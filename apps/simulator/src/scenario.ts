import { createServer, type IncomingMessage } from 'node:http';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { FlightSummary, Input, ReceiptResponse, TimelineResponse } from '@ledger/contracts';
import {
  LedgerClient,
  PartnerOrderAdapter,
  AirspaceLinkAdapter,
  PkceClient,
  retainInput,
  digest,
  type AdapterResult,
} from '@ledger/adapters';
import { createWorld, scenarioManifest, type HiddenWorld, type PartnerOrder } from '@ledger/simulation-models';
import { acquireControlLease } from './control-lease.js';
import { publicFlights } from './public-state.js';
import { assessFarControls, runFarControlDay } from './scenario-applicability.js';

export interface ScenarioConfig {
  apiUrl: string;
  emulatorUrl: string;
  callbackHost: string;
  callbackPort: number;
  reportDirectory: string;
  adminKey: string;
  partnerKey: string;
  userClientId: string;
  callbackSecret: string;
  tokens: Record<'alpha' | 'beta', { source: string; actor: string }>;
  /** The Alpha dispatcher, who records the day's far-field hazard and release; required only by the simulated day. */
  alphaOperatorToken?: string;
  seed: number;
  start: string;
  runId: string;
}
export interface ScenarioEmission {
  tenant: string;
  receiptId: string;
  artifactId?: string;
  occurredAt: string;
  receivedAt: string;
  kind: string;
  sha256?: string;
  processing?: string;
}
export interface OracleAssertion {
  name: string;
  passed: boolean;
  expected: unknown;
  actual: unknown;
}
export interface ScenarioReport {
  scenario: typeof scenarioManifest;
  runStartedAt: string;
  runFinishedAt: string;
  world: HiddenWorld;
  emissions: ScenarioEmission[];
  assertions: OracleAssertion[];
  flights: Record<'alpha' | 'beta', FlightSummary[]>;
  passed: boolean;
  limitations: string[];
}
const runIdPattern = /^[A-Za-z0-9-]{1,32}$/;
/** A run's own form of an identity the seeded world repeats on every run. */
export const runScoped = (id: string, runId: string): string => `${id}-${runId}`;
/** The idempotency key of one scenario step; the run id keeps a later run from reusing it with different content. */
export const scenarioKey = (world: HiddenWorld, runId: string, step: string): string =>
  `scenario:${world.seed}:${runId}:${step}`;
/** Gives the world's intents and orders this run's identities, so its flights and orders are its own. */
export function worldForRun(world: HiddenWorld, runId: string): HiddenWorld {
  const scoped = (id: string) => runScoped(id, runId);
  const order = (row: PartnerOrder): PartnerOrder => ({
    ...row,
    order_id: scoped(row.order_id),
    flights: row.flights.map((flight) => ({
      ...flight,
      flight_intent_id: scoped(flight.flight_intent_id),
      order_refs: flight.order_refs.map(scoped),
    })),
  });
  return {
    ...world,
    flights: world.flights.map((flight) => ({
      ...flight,
      intentId: scoped(flight.intentId),
      orderIds: flight.orderIds.map(scoped),
    })),
    orders: { alpha: world.orders.alpha.map(order), beta: world.orders.beta.map(order) },
    expected: {
      ...world.expected,
      logicalIntents: world.expected.logicalIntents.map(scoped),
      cancelledOrder: scoped(world.expected.cancelledOrder),
    },
  };
}
const isLocal = (value: string): boolean => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname);
export function scenarioConfig(env: NodeJS.ProcessEnv = process.env): ScenarioConfig {
  const apiUrl = env.LEDGER_API_URL ?? env.API_URL ?? 'http://127.0.0.1:4000';
  const emulatorUrl = env.EMULATOR_BASE_URL ?? 'http://127.0.0.1:4002';
  const development =
    (env.LEDGER_ENV ?? 'local') === 'local' && env.NODE_ENV !== 'production' && isLocal(apiUrl) && isLocal(emulatorUrl);
  if (!development && env.LEDGER_SIMULATION_TARGET !== 'isolated')
    throw new Error('Remote simulation requires LEDGER_SIMULATION_TARGET=isolated');
  const value = (key: string, fallback: string): string => {
    if (env[key]) return env[key]!;
    if (!development) throw new Error(`${key} must be supplied for remote simulation`);
    return fallback;
  };
  return {
    apiUrl,
    emulatorUrl,
    callbackHost: env.SIMULATOR_CALLBACK_HOST ?? '127.0.0.1',
    callbackPort: Number(env.SIMULATOR_CALLBACK_PORT ?? 4003),
    reportDirectory: env.SIMULATOR_REPORT_DIR ?? '.local/scenarios/m0-m1',
    adminKey: value('EMULATOR_ADMIN_KEY', 'ledger-local-emulator-admin'),
    partnerKey: value('PARTNER_API_KEY', 'ledger-local-partner'),
    userClientId: value('AIRSPACE_USER_CLIENT_ID', 'ledger-local-user'),
    callbackSecret: value('AIRSPACE_CALLBACK_SECRET', 'ledger-local-airhub-callback'),
    tokens: {
      alpha: {
        source: value('ALPHA_SOURCE_TOKEN', 'ledger-dev-alpha-source'),
        actor: value('ALPHA_ACTOR_TOKEN', 'ledger-dev-alpha-actor'),
      },
      beta: {
        source: value('BETA_SOURCE_TOKEN', 'ledger-dev-beta-source'),
        actor: value('BETA_ACTOR_TOKEN', 'ledger-dev-beta-actor'),
      },
    },
    ...(env.ALPHA_OPERATOR_TOKEN || development
      ? { alphaOperatorToken: env.ALPHA_OPERATOR_TOKEN || 'ledger-dev-alpha-operator' }
      : {}),
    seed: Number(env.SIMULATOR_SEED ?? 71031),
    start: env.SIMULATOR_START ?? new Date().toISOString(),
    runId: scenarioRunId(env.SIMULATOR_RUN_ID),
  };
}
function scenarioRunId(fixed: string | undefined): string {
  if (fixed === undefined || fixed === '') return randomBytes(6).toString('hex');
  if (!runIdPattern.test(fixed)) throw new Error('SIMULATOR_RUN_ID must be 1 to 32 letters, digits or hyphens');
  return fixed;
}

async function bytes(request: IncomingMessage): Promise<Uint8Array> {
  const parts: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    length += Buffer.byteLength(chunk);
    if (length > 2 * 1024 * 1024) throw new Error('Callback exceeded its bound');
    parts.push(Buffer.from(chunk));
  }
  return Buffer.concat(parts);
}
/** Every order in the tenant: a database that holds earlier runs has more than one page of them. */
async function allOrders(client: LedgerClient) {
  const orders = [];
  let cursor: string | undefined;
  do {
    const page = await client.orders({ limit: 200, ...(cursor ? { cursor } : {}) });
    orders.push(...page.orders);
    cursor = page.page.nextCursor ?? undefined;
  } while (cursor);
  return orders;
}
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function eventually<T>(
  description: string,
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  timeout = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  do {
    const value = await read();
    if (ready(value)) return value;
    await pause(50);
  } while (Date.now() < deadline);
  throw new Error(`Scenario timed out waiting for ${description}`);
}

export function assessWorld(
  world: HiddenWorld,
  flights: ScenarioReport['flights'],
  observations: {
    duplicateReceiptIds: string[];
    splitOrder: { revision: number; flightIds: string[] };
    consolidatedOrders: Array<{ flightIds: string[] }>;
    cancelledOrder: { status: string };
    linkedReceipt: { linkStatus: string; flightId?: string };
    primaryFlightId: string;
    timeline: TimelineResponse;
    deniedTimeline: TimelineResponse;
    correctionTarget: string;
    decisionId: string;
    betaBefore: string;
    betaAfter: string;
    betaBeforeAsOf?: string;
    betaAfterAsOf?: string;
  },
): OracleAssertion[] {
  const assertions: OracleAssertion[] = [];
  const equal = (name: string, expected: unknown, actual: unknown) =>
    assertions.push({ name, expected, actual, passed: JSON.stringify(expected) === JSON.stringify(actual) });
  equal(
    'ten distinct intended flights, no duplicate origination',
    world.expected.logicalIntents.map((id) => `${id}:attempt:1`).sort(),
    [...flights.alpha, ...flights.beta].map((flight) => flight.originationKey).sort(),
  );
  equal('alpha flight count', world.expected.alphaFlights, flights.alpha.length);
  equal('beta flight count', world.expected.betaFlights, flights.beta.length);
  equal('webhook retry returns its original receipt', 1, new Set(observations.duplicateReceiptIds).size);
  equal('out-of-order revision cannot regress current order', 2, observations.splitOrder.revision);
  equal('one order is split into two flight identities', 2, new Set(observations.splitOrder.flightIds).size);
  equal(
    'two orders are consolidated into one identity',
    1,
    new Set(observations.consolidatedOrders.flatMap((order) => order.flightIds)).size,
  );
  equal(
    'unmatched evidence is linked by an attributed public command',
    ['linked', observations.primaryFlightId],
    [observations.linkedReceipt.linkStatus, observations.linkedReceipt.flightId],
  );
  equal('cancellation changes the order', 'cancelled', observations.cancelledOrder.status);
  const cancelledIntent = `${world.flights.find((flight) => flight.orderIds.includes(world.expected.cancelledOrder))!.intentId}:attempt:1`;
  equal(
    'order cancellation does not rewrite observed physical activity',
    'active',
    flights.alpha.find((flight) => flight.originationKey === cancelledIntent)?.activity,
  );
  const originalLandingClaims = observations.timeline.items
    .filter((item) => item.kind === 'flight.observation' && typeof item.payload.landingTime === 'string')
    .map((item) => item.payload.landingTime);
  equal(
    'late conflicting landing source records remain visible',
    [world.flights[0]!.end, new Date(Date.parse(world.flights[0]!.end) + 120_000).toISOString()].sort(),
    [...new Set(originalLandingClaims)].sort(),
  );
  equal(
    'appended correction resolves the current interpretation',
    [0, 'landed'],
    [observations.timeline.flight.conflictCount, observations.timeline.flight.activity],
  );
  equal(
    'original conflicting evidence survives its appended correction',
    true,
    observations.timeline.items.some((item) => item.id === observations.correctionTarget) &&
      observations.timeline.items.some(
        (item) => item.kind === 'evidence.correct' && item.correctionOf === observations.correctionTarget,
      ),
  );
  const decision = observations.timeline.decisions.find((item) => item.id === observations.decisionId);
  equal(
    'decision retains its original rendered and accepted cuts',
    true,
    Boolean(
      decision?.renderedInputCut.streams &&
      decision.acceptedInputCut.streams &&
      decision.acceptedBasisRevision < observations.timeline.flight.basisRevision,
    ),
  );
  equal(
    'rescission received after departure remains an independent vendor claim',
    true,
    observations.timeline.items.some(
      (item) => item.kind === 'airspace.status' && item.payload.status === 'STATUS_RESCINDED',
    ) &&
      observations.timeline.items.some(
        (item) => item.kind === 'flight.observation' && item.payload.activity === 'active',
      ),
  );
  equal(
    'vendor denial and its actual denial enum are retained',
    true,
    observations.deniedTimeline.items.some(
      (item) =>
        item.kind === 'airspace.status' &&
        item.payload.status === 'STATUS_DENIED' &&
        (item.payload.authorizationRecord as Record<string, unknown> | undefined)?.denialReason === 'DENY_LOCATION',
    ),
  );
  equal('second tenant timeline unchanged by alpha activity', observations.betaBefore, observations.betaAfter);
  const earlierReadAt = Date.parse(observations.betaBeforeAsOf ?? '');
  const laterReadAt = Date.parse(observations.betaAfterAsOf ?? '');
  equal(
    'second tenant read clock is valid and advances',
    true,
    Number.isFinite(earlierReadAt) && Number.isFinite(laterReadAt) && laterReadAt > earlierReadAt,
  );
  return assertions;
}

export async function runScenario(config = scenarioConfig()): Promise<ScenarioReport> {
  const world = worldForRun(createWorld(config.seed, config.start), config.runId);
  const key = (step: string) => scenarioKey(world, config.runId, step);
  const ownedFlights = (tenant: 'alpha' | 'beta', rows: FlightSummary[]) => {
    const keys = new Set(
      world.flights
        .filter((flight) => flight.tenant === tenant)
        .map((flight) => `${flight.intentId}:attempt:${flight.attempt}`),
    );
    return rows.filter((flight) => keys.has(flight.originationKey));
  };
  const runStartedAt = new Date().toISOString();
  const source = {
    alpha: new LedgerClient(config.apiUrl, config.tokens.alpha.source),
    beta: new LedgerClient(config.apiUrl, config.tokens.beta.source),
  };
  const actor = {
    alpha: new LedgerClient(config.apiUrl, config.tokens.alpha.actor),
    beta: new LedgerClient(config.apiUrl, config.tokens.beta.actor),
  };
  const partner = {
    alpha: new PartnerOrderAdapter({
      ledger: source.alpha,
      sourceId: 'partner-orders',
      baseUrl: config.emulatorUrl,
      apiKey: config.partnerKey,
    }),
    beta: new PartnerOrderAdapter({
      ledger: source.beta,
      sourceId: 'partner-orders',
      baseUrl: config.emulatorUrl,
      apiKey: config.partnerKey,
    }),
  };
  const emissions: ScenarioEmission[] = [];
  const webhookResults: Record<'alpha' | 'beta', AdapterResult[]> = { alpha: [], beta: [] };
  let airspace: AirspaceLinkAdapter | undefined;
  const record = (tenant: 'alpha' | 'beta', result: AdapterResult | ReceiptResponse): ReceiptResponse => {
    const response = 'artifactId' in result ? (result as AdapterResult).receipt : (result as ReceiptResponse);
    const receipt = response.receipt;
    emissions.push({
      tenant,
      receiptId: receipt.id,
      artifactId: receipt.artifactId,
      occurredAt: receipt.occurredAt,
      receivedAt: receipt.receivedAt,
      kind: receipt.kind,
      ...('sha256' in result ? { sha256: result.sha256 } : {}),
    });
    return response;
  };
  const waitReceipt = async (tenant: 'alpha' | 'beta', response: ReceiptResponse) =>
    eventually(
      `receipt ${response.receipt.id}`,
      () => source[tenant].receipt(response.receipt.id),
      (result) => {
        if (result.receipt.processing.status === 'failed')
          throw new Error(
            `Receipt ${response.receipt.id} failed: ${result.receipt.processing.error ?? 'unknown failure'}`,
          );
        return result.receipt.processing.status === 'completed';
      },
    ).then((result) => {
      for (const emission of emissions.filter((item) => item.receiptId === result.receipt.id))
        emission.processing = result.receipt.processing.status;
      return result;
    });
  const waitResults = async (tenant: 'alpha' | 'beta', results: AdapterResult[]) => {
    for (const result of results) await waitReceipt(tenant, record(tenant, result));
  };
  const timeline = (tenant: 'alpha' | 'beta', id: string) =>
    eventually(
      `fresh timeline ${id}`,
      () => actor[tenant].timeline(id),
      (view) => view.meta.outstandingWork === 0,
    );
  let controlLease: Awaited<ReturnType<typeof acquireControlLease>> | undefined;
  const control = async <T>(path: string, method: string, body?: unknown): Promise<T> => {
    if (!controlLease) throw new Error('Scenario emulator control lease missing');
    const response = await fetch(`${config.emulatorUrl}${path}`, {
      method,
      headers: controlLease.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Emulator control ${path} returned ${response.status}: ${await response.text()}`);
    return response.json() as Promise<T>;
  };
  const callbackServer = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (request.method !== 'POST') {
        response.writeHead(405);
        response.end();
        return;
      }
      const raw = await bytes(request);
      if (url.pathname.startsWith('/callbacks/partner/')) {
        if (request.headers['x-partner-key'] !== config.partnerKey)
          throw new Error('Partner delivery credential rejected');
        const tenant = url.pathname.endsWith('/beta') ? 'beta' : 'alpha';
        const result = await partner[tenant].ingest(raw);
        webhookResults[tenant].push(result);
      } else if (url.pathname === '/callbacks/airspace' && airspace) {
        const expected = createHmac('sha256', config.callbackSecret).update(raw).digest('hex');
        const supplied = String(request.headers['x-simulation-signature'] ?? '');
        const valid =
          supplied.length === expected.length && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
        const originationKey = url.searchParams.get('intent');
        if (!originationKey) throw new Error('Callback intent mapping missing');
        record('alpha', await airspace.receiveCallback(raw, originationKey, valid));
      } else throw new Error('Unknown adapter callback route');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ accepted: true }));
    } catch {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'Adapter rejected callback' }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    callbackServer.once('error', reject);
    callbackServer.listen(config.callbackPort, config.callbackHost, resolve);
  });
  const callbackPort = (callbackServer.address() as { port: number }).port;
  const callbackBase = `http://${config.callbackHost}:${callbackPort}`;
  try {
    const emulatorHealth = (await fetch(`${config.emulatorUrl}/healthz`).then((response) => response.json())) as {
      simulation?: boolean;
    };
    if (!emulatorHealth.simulation) throw new Error('Target does not identify itself as a vendor emulator');
    controlLease = await acquireControlLease(config.emulatorUrl, config.adminKey, 'scenario');
    await control('/_simulation/reset', 'POST');
    const earliestStart = Math.min(...world.flights.map((flight) => Date.parse(flight.start)));
    await control('/_simulation/clock', 'POST', { now: new Date(earliestStart - 600_000).toISOString() });

    const primaryWorld = world.flights[0]!;
    const unmatchedFlightId = runScoped('pre-dispatch-alpha-01', config.runId);
    const unmatchedBytes = new TextEncoder().encode(
      JSON.stringify({
        activity: 'active',
        externalSession: unmatchedFlightId,
        aircraft: primaryWorld.aircraftId,
      }),
    );
    const unmatched = record(
      'alpha',
      await retainInput(
        { ledger: source.alpha, sourceId: 'aircraft-pre-dispatch' },
        unmatchedBytes,
        'application/json',
        {
          kind: 'flight.observation',
          occurredAt: primaryWorld.start,
          subject: { externalFlightId: unmatchedFlightId },
          payload: JSON.parse(new TextDecoder().decode(unmatchedBytes)),
          fidelity: 'synthetic_contract',
        },
        key('unmatched'),
      ),
    );
    await waitReceipt('alpha', unmatched);

    const split = world.orders.alpha.find((order) => order.order_id === runScoped('order-alpha-split', config.runId))!;
    const splitV2: PartnerOrder = {
      ...split,
      version: 2,
      updated_at: new Date(Date.parse(world.start) - 240_000).toISOString(),
    };
    for (const order of [splitV2, splitV2, split]) {
      const delivery = await control<{ status: number }>('/_simulation/partner/deliver', 'POST', {
        callbackUrl: `${callbackBase}/callbacks/partner/alpha`,
        order,
      });
      if (delivery.status !== 200) throw new Error(`Partner webhook adapter returned ${delivery.status}`);
    }
    await waitResults('alpha', webhookResults.alpha);
    await control('/_simulation/partner/orders', 'PUT', {
      orders: world.orders.alpha.filter((order) => order.order_id !== split.order_id),
    });
    await waitResults('alpha', await partner.alpha.poll());
    await control('/_simulation/partner/orders', 'PUT', { orders: world.orders.beta });
    await waitResults('beta', await partner.beta.poll());
    const initialAlpha = await eventually(
      'nine alpha flights',
      async () => {
        const response = await publicFlights(source.alpha);
        return { ...response, flights: ownedFlights('alpha', response.flights) };
      },
      (result) => result.flights.length === world.expected.alphaFlights,
    );
    const initialBeta = await eventually(
      'one beta flight',
      async () => {
        const response = await publicFlights(source.beta);
        return { ...response, flights: ownedFlights('beta', response.flights) };
      },
      (result) => result.flights.length === world.expected.betaFlights,
    );
    const lookup = (flight: HiddenWorld['flights'][number]): FlightSummary =>
      (flight.tenant === 'alpha' ? initialAlpha.flights : initialBeta.flights).find(
        (row) => row.originationKey === `${flight.intentId}:attempt:${flight.attempt}`,
      )!;
    const primary = lookup(primaryWorld);
    const beforeLink = await timeline('alpha', primary.id);
    const linked = await source.alpha.receipt(unmatched.receipt.id);
    if (linked.receipt.linkStatus !== 'linked')
      await actor.alpha.command(
        {
          kind: 'identity.link',
          flightId: primary.id,
          receiptId: unmatched.receipt.id,
          expectedRevision: beforeLink.flight.revision,
        },
        key('identity-link'),
      );
    await timeline('alpha', primary.id);

    const pkce = new PkceClient({
      authorizationUrl: `${config.emulatorUrl}/oauth/authorize`,
      tokenUrl: `${config.emulatorUrl}/oauth/token`,
      clientId: config.userClientId,
      redirectUri: 'http://127.0.0.1:4002/oauth/callback',
      scopes: ['operation:read', 'operation:create', 'operation:update', 'laanc:read', 'laanc:create', 'laanc:update'],
    });
    const grant = pkce.authorize('s'.repeat(43), `scenario-${world.seed}`);
    const redirect = await fetch(grant.url, { redirect: 'manual' });
    if (redirect.status !== 302 || !redirect.headers.get('location'))
      throw new Error('Emulated user authorization failed');
    const returnUrl = new URL(redirect.headers.get('location')!);
    if (returnUrl.searchParams.get('state') !== grant.state) throw new Error('PKCE state mismatch');
    const accessToken = await pkce.exchange(returnUrl.searchParams.get('code')!, grant.verifier);
    const provenanceBytes = await readFile(
      new URL('../../emulators/vendor/airspace-link/provenance.json', import.meta.url),
    );
    airspace = new AirspaceLinkAdapter({
      ledger: source.alpha,
      sourceId: 'airspace-link',
      baseUrl: config.emulatorUrl,
      credential: { kind: 'user', accessToken },
      fidelity: 'documented_schema_conformant',
      schemaDigest: digest(provenanceBytes),
    });
    const createAirspace = async (worldFlight: HiddenWorld['flights'][number]) => {
      const originationKey = `${worldFlight.intentId}:attempt:${worldFlight.attempt}`;
      const parent = await airspace!.vendorRequest<{ id: string }>('POST', '/v1/operations', originationKey, {
        name: `Fictional ${worldFlight.intentId}`,
        pilotId: 'fictional-pilot-alpha',
        aircraftId: worldFlight.aircraftId,
        boundary: {
          type: 'Polygon',
          coordinates: [
            [
              [-83, 42],
              [-83, 42.01],
              [-82.99, 42.01],
              [-82.99, 42],
              [-83, 42],
            ],
          ],
        },
        minAltitude: 0,
        maxAltitude: 200,
        startTime: worldFlight.start,
        endTime: worldFlight.end,
        timezone: 'America/Chicago',
        altitudeUnit: 'ALTITUDE_UNIT_FEET',
        altitudeReference: 'ALTITUDE_REFERENCE_AGL',
        flightType: 'FLIGHT_TYPE_COMMERCIAL',
        callbackUrl: `${callbackBase}/callbacks/airspace?intent=${encodeURIComponent(originationKey)}`,
      });
      const child = await airspace!.vendorRequest<{ operation: { candidates: Array<{ hashCode: string }> } }>(
        'POST',
        `/v1/operations/${parent.id}/laanc`,
        originationKey,
        {
          license: 'LICENSE_PART_107',
          fixedAltitude: false,
          pointOfContact: {
            firstName: 'Synthetic',
            lastName: 'Pilot',
            phoneNumber: '+15555550123',
            emailAddress: 'pilot@example.invalid',
          },
        },
      );
      const result = await airspace!.vendorRequest<{ authorization: { id: string } }>(
        'POST',
        `/v1/operations/${parent.id}/laanc/authorizations/${child.operation.candidates[0]!.hashCode}`,
        originationKey,
        { justification: 'Fictional simulation' },
      );
      await waitResults('alpha', await airspace!.pollOperation(parent.id, originationKey));
      return { operationId: parent.id, authorizationId: result.authorization.id, originationKey };
    };
    const airspacePrimary = await createAirspace(primaryWorld);
    const denied = await createAirspace(world.flights[1]!);
    await control(
      `/_simulation/airspace/operations/${denied.operationId}/authorizations/${denied.authorizationId}/status`,
      'POST',
      {
        status: 'STATUS_DENIED',
        denialReason: 'DENY_LOCATION',
        occurredAt: new Date(Date.parse(world.flights[1]!.start) - 60_000).toISOString(),
      },
    );
    await waitResults('alpha', await airspace.pollOperation(denied.operationId, denied.originationKey));

    const wall = Date.now();
    if (Date.parse(primaryWorld.end) > wall)
      throw new Error(
        'The completed clinic flight ends after the scenario clock, so its landing would predate receipt',
      );
    for (const flight of world.flights) {
      if (Date.parse(flight.start) > wall) continue;
      const raw = new TextEncoder().encode(
        JSON.stringify({ activity: 'active', aircraft: flight.aircraftId, title: 'Synthetic departure observation' }),
      );
      await waitReceipt(
        flight.tenant,
        record(
          flight.tenant,
          await retainInput(
            { ledger: actor[flight.tenant], sourceId: `simulation-person-${flight.tenant}` },
            raw,
            'application/json',
            {
              kind: 'flight.observation',
              occurredAt: flight.start,
              subject: { flightId: lookup(flight).id },
              payload: JSON.parse(new TextDecoder().decode(raw)),
              fidelity: 'synthetic_contract',
            },
            key(`${flight.intentId}:departure`),
          ),
        ),
      );
    }
    const betaFlight = initialBeta.flights[0]!;
    const betaView = await timeline('beta', betaFlight.id);
    const { asOf: betaBeforeAsOf, ...betaBeforeOperation } = betaView.flight.operation ?? {};
    const betaBefore = JSON.stringify({
      flight: { ...betaView.flight, operation: betaBeforeOperation },
      items: betaView.items,
      decisions: betaView.decisions,
    });
    const shown = await timeline('alpha', primary.id);
    const oldDecision = shown.decisions.find(
      (decision) =>
        (decision.kind === 'proceed' && decision.note.includes('Eastside Clinic pharmacy run')) ||
        (decision.kind === 'simulation.dispatch-note' && decision.note.includes(`seed ${world.seed}`)),
    );
    const decisionId =
      oldDecision?.id ??
      (
        await actor.alpha.command(
          {
            kind: 'decision.record',
            flightId: primary.id,
            expectedRevision: shown.flight.revision,
            expectedBasisRevision: shown.flight.basisRevision,
            inputCut: shown.meta.inputCut,
            expectedDependencyBasis: shown.meta.dependencyBasis!,
            decision: {
              kind: 'proceed',
              note: 'Continued the Eastside Clinic pharmacy run. The reports in hand showed a normal departure.',
            },
          },
          key('decision'),
        )
      ).command.id;
    await timeline('alpha', primary.id);

    const observeLanding = async (sourceId: string, landingTime: string, occurredAt: string, suffix: string) => {
      const raw = new TextEncoder().encode(
        JSON.stringify({ activity: 'landed', landingTime, title: `Synthetic ${suffix} landing record` }),
      );
      const received = record(
        'alpha',
        await retainInput(
          { ledger: source.alpha, sourceId },
          raw,
          'application/json',
          {
            kind: 'flight.observation',
            occurredAt,
            subject: { originationKey: primary.originationKey },
            payload: JSON.parse(new TextDecoder().decode(raw)),
            fidelity: 'synthetic_contract',
          },
          key(suffix),
        ),
      );
      await waitReceipt('alpha', received);
      return received;
    };
    await observeLanding('aircraft-live', primaryWorld.end, primaryWorld.end, 'live');
    const disputed = await observeLanding(
      'postflight-log',
      new Date(Date.parse(primaryWorld.end) + 120_000).toISOString(),
      new Date(Date.parse(primaryWorld.end) + 180_000).toISOString(),
      'late-log',
    );
    const conflicting = await timeline('alpha', primary.id);
    const correctionTarget = conflicting.items.find((item) => item.receiptId === disputed.receipt.id)!.id;
    if (!conflicting.items.some((item) => item.kind === 'evidence.correct' && item.correctionOf === correctionTarget))
      await actor.alpha.command(
        {
          kind: 'evidence.correct',
          flightId: primary.id,
          expectedRevision: conflicting.flight.revision,
          expectedBasisRevision: conflicting.flight.basisRevision,
          inputCut: conflicting.meta.inputCut,
          expectedDependencyBasis: conflicting.meta.dependencyBasis!,
          correctionOf: correctionTarget,
          occurredAt: primaryWorld.end,
          note: 'Using the aircraft landing time. The later postflight log stays on the record.',
          payload: { landingTime: primaryWorld.end, referenceSource: 'aircraft-live' },
        },
        key('correction'),
      );
    await timeline('alpha', primary.id);

    for (const flight of world.flights) {
      if (flight.intentId === primaryWorld.intentId || Date.parse(flight.end) > wall) continue;
      const landing = new TextEncoder().encode(
        JSON.stringify({ activity: 'landed', landingTime: flight.end, title: 'Landing reported' }),
      );
      await waitReceipt(
        flight.tenant,
        record(
          flight.tenant,
          await retainInput(
            { ledger: actor[flight.tenant], sourceId: `simulation-person-${flight.tenant}` },
            landing,
            'application/json',
            {
              kind: 'flight.observation',
              occurredAt: flight.end,
              subject: { flightId: lookup(flight).id },
              payload: JSON.parse(new TextDecoder().decode(landing)),
              fidelity: 'synthetic_contract',
            },
            key(`${flight.intentId}:landing`),
          ),
        ),
      );
    }

    const cancelled = world.orders.alpha.find((order) => order.order_id === world.expected.cancelledOrder)!;
    await waitResults('alpha', [
      await partner.alpha.ingest(
        new TextEncoder().encode(
          JSON.stringify({
            ...cancelled,
            version: 2,
            state: 'cancelled',
            updated_at: new Date(Date.parse(cancelled.schedule.start) + 60_000).toISOString(),
          }),
        ),
      ),
    ]);
    await control(
      `/_simulation/airspace/operations/${airspacePrimary.operationId}/authorizations/${airspacePrimary.authorizationId}/status`,
      'POST',
      { status: 'STATUS_RESCINDED', occurredAt: new Date(Date.parse(primaryWorld.start) + 420_000).toISOString() },
    );
    await waitResults(
      'alpha',
      await airspace.pollOperation(airspacePrimary.operationId, airspacePrimary.originationKey),
    );
    for (const result of airspace.retainedReceipts) record('alpha', result);
    for (const emission of emissions)
      await waitReceipt(
        emission.tenant as 'alpha' | 'beta',
        await source[emission.tenant as 'alpha' | 'beta'].receipt(emission.receiptId),
      );

    const finalTimeline = await timeline('alpha', primary.id);
    const betaAfterView = await timeline('beta', betaFlight.id);
    const { asOf: betaAfterAsOf, ...betaAfterOperation } = betaAfterView.flight.operation ?? {};
    const betaAfter = JSON.stringify({
      flight: { ...betaAfterView.flight, operation: betaAfterOperation },
      items: betaAfterView.items,
      decisions: betaAfterView.decisions,
    });
    const orders = await allOrders(source.alpha);
    const consolidatedIds = ['order-alpha-consolidated-a', 'order-alpha-consolidated-b'].map((id) =>
      runScoped(id, config.runId),
    );
    const flights = {
      alpha: ownedFlights('alpha', (await publicFlights(source.alpha)).flights),
      beta: ownedFlights('beta', (await publicFlights(source.beta)).flights),
    };
    const linkedReceipt = (await source.alpha.receipt(unmatched.receipt.id)).receipt;
    if (!config.alphaOperatorToken) throw new Error('ALPHA_OPERATOR_TOKEN must be supplied for remote simulation');
    const farControls = await runFarControlDay({
      operator: new LedgerClient(config.apiUrl, config.alphaOperatorToken),
      operatorToken: config.alphaOperatorToken,
      source: source.alpha,
      otherTenant: actor.beta,
      flightIds: flights.alpha.map((flight) => flight.id),
      key,
      eventually,
    });
    const assertions = assessWorld(world, flights, {
      duplicateReceiptIds: webhookResults.alpha.slice(0, 2).map((result) => result.receipt.receipt.id),
      splitOrder: orders.find((order) => order.externalId === split.order_id)!,
      consolidatedOrders: orders.filter((order) => consolidatedIds.includes(order.externalId)),
      cancelledOrder: orders.find((order) => order.externalId === world.expected.cancelledOrder)!,
      linkedReceipt,
      primaryFlightId: primary.id,
      timeline: finalTimeline,
      deniedTimeline: await timeline('alpha', lookup(world.flights[1]!).id),
      correctionTarget,
      decisionId,
      betaBefore,
      betaAfter,
      betaBeforeAsOf,
      betaAfterAsOf,
    });
    assertions.push(assessFarControls(farControls));
    const report: ScenarioReport = {
      scenario: scenarioManifest,
      runStartedAt,
      runFinishedAt: new Date().toISOString(),
      world,
      emissions,
      assertions,
      flights,
      passed: assertions.every((assertion) => assertion.passed),
      limitations: [
        'Synthetic vendor operation and identity-provider behavior; no sandbox/live validation.',
        'Scripted scenario source timestamps; Ledger receipts use actual server time.',
        'No throughput, realtime soak, aviation-rule or production-readiness claims.',
      ],
    };
    await mkdir(config.reportDirectory, { recursive: true });
    await writeFile(
      `${config.reportDirectory}/manifest.json`,
      JSON.stringify({ ...scenarioManifest, seed: world.seed, runId: config.runId, worldStart: world.start }, null, 2) +
        '\n',
    );
    await writeFile(`${config.reportDirectory}/evidence-report.json`, JSON.stringify(report, null, 2) + '\n');
    return report;
  } catch (error) {
    await mkdir(config.reportDirectory, { recursive: true });
    await writeFile(
      `${config.reportDirectory}/failure-report.json`,
      JSON.stringify(
        {
          scenario: scenarioManifest,
          runStartedAt,
          failedAt: new Date().toISOString(),
          emissions,
          error: error instanceof Error ? error.message : 'Scenario failed',
        },
        null,
        2,
      ) + '\n',
    );
    throw error;
  } finally {
    await controlLease?.release();
    callbackServer.closeAllConnections();
    await new Promise<void>((resolve) => callbackServer.close(() => resolve()));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = scenarioConfig();
  runScenario(config)
    .then((report) => {
      console.log(
        `M0–M1 scenario: ${report.passed ? 'PASS' : 'FAIL'} · ${report.flights.alpha.length + report.flights.beta.length} flights · ${report.assertions.filter((assertion) => assertion.passed).length}/${report.assertions.length} oracle assertions`,
      );
      console.log(`Evidence report: ${config.reportDirectory}/evidence-report.json`);
      if (!report.passed) {
        for (const assertion of report.assertions.filter((row) => !row.passed))
          console.error(
            `${assertion.name}: expected ${JSON.stringify(assertion.expected)}, got ${JSON.stringify(assertion.actual)}`,
          );
        process.exitCode = 1;
      }
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : 'Scenario failed');
      // An API refusal carries the reason in its body; print it so a failed run says what was refused.
      if (error instanceof Error && 'body' in error) console.error(JSON.stringify(error.body).slice(0, 2000));
      if (error instanceof Error && error.stack) console.error(error.stack.split('\n').slice(1, 6).join('\n'));
      process.exitCode = 1;
    });
}
