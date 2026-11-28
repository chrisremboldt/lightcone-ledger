import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../api/src/index.js';
import { createEmulator, emulatorConfig } from '../../emulators/src/server.js';
import { skydioEmulatorState } from '../../emulators/src/skydio.js';
import type { AcceptedObservation, ObservationListResponse } from '../../../packages/contracts/src/index.js';
import { sha256 } from '../../../packages/integrity/src/index.js';
import { createPool, MemoryObjectStore, type AuthContext } from '../../../packages/persistence/src/index.js';
import { settleOwnedWork } from '../../../tests/integration/worker-queue.js';
import { runAdapterHost } from '../src/host.js';

// The flight service adapter, as an operator starts it, between the emulated flight service and the real API on the
// test database. What Ledger holds afterwards is read back through the API. The emulator is written from the same
// published reference as the adapter: this shows the adapter against Ledger, not against the real service.

/** Keeps every object the API stores, so a test can search the retained originals. */
class SearchableObjectStore extends MemoryObjectStore {
  readonly stored: Uint8Array[] = [];
  override async putIfAbsent(key: string, bytes: Uint8Array, contentType: string) {
    this.stored.push(bytes.slice());
    return super.putIfAbsent(key, bytes, contentType);
  }
}

interface Sent {
  readonly to: 'service' | 'ledger';
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}
interface Line {
  readonly event: string;
  readonly message: string;
  readonly received?: number;
  readonly submittedMessages?: number;
  readonly queued?: number;
  readonly refused?: number;
  readonly rejected?: number;
}

describe.runIf(process.env.LEDGER_ENV !== 'staging')('The flight service adapter against the real API', () => {
  const prefix = `flight-service-${randomUUID()}`;
  const tenantId = `${prefix}:org`;
  const sourceId = `${prefix}-flights`;
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const store = new SearchableObjectStore();
  const emulatorSettings = { ...emulatorConfig({}), port: 0 };
  const serviceToken = emulatorSettings.flightServiceToken!;
  const emulator = createEmulator(emulatorSettings);
  const who = {} as Record<'reader' | 'source' | 'writer', AuthContext>;
  const sent: Sent[] = [];
  const base = Date.now();
  let emulatorBase = '';
  let app: Awaited<ReturnType<typeof createApp>>;
  let address = '';

  /** Everything the process sends, to the service and to Ledger, as the test's request log. */
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const body =
      init.body instanceof Uint8Array
        ? new TextDecoder().decode(init.body)
        : typeof init.body === 'string'
          ? init.body
          : '';
    sent.push({
      to: url.startsWith(emulatorBase) ? 'service' : 'ledger',
      method: init.method ?? 'GET',
      url,
      headers: Object.fromEntries(new Headers(init.headers)),
      body,
    });
    return fetch(input, init);
  }) as typeof fetch;
  const listReads = () => sent.filter((request) => request.to === 'service' && request.url.includes('/api/v0/flights'));

  function call(principal: AuthContext, method: 'GET' | 'POST', url: string, payload?: unknown) {
    return app.inject({
      method,
      url,
      headers: { authorization: `Bearer ledger-dev-${principal.id}`, 'idempotency-key': randomUUID() },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  }

  /** What Ledger holds about one of the service's ids, read through the API as a person with evidence:read. */
  async function onFile(
    kind: 'flight' | 'aircraft',
    id: string,
    type: 'flight.report' | 'position.fix',
    include: 'current' | 'all' = 'current',
  ): Promise<AcceptedObservation[]> {
    const query = new URLSearchParams({
      subjectKind: kind,
      subjectId: id,
      subjectScope: 'source',
      sourceId,
      type,
      from: '1970-01-01T00:00:00.000Z',
      to: '9999-12-31T23:59:59.000Z',
      limit: '500',
      include,
    });
    const response = await call(who.reader, 'GET', `/v1/observations?${query}`);
    expect(response.statusCode, response.body).toBe(200);
    const list = response.json<ObservationListResponse>();
    expect(list.page.hasMore).toBe(false);
    return list.observations;
  }
  const flightIds = ['EXAMPLE-FLIGHT-0001', 'EXAMPLE-FLIGHT-0002', 'EXAMPLE-FLIGHT-0003'];
  const aircraftIds = ['EXAMPLE-VEHICLE-01', 'EXAMPLE-VEHICLE-02'];

  /** Every observation the source has on file, replaced ones included, by id. */
  async function everything(): Promise<Map<string, AcceptedObservation>> {
    const all = new Map<string, AcceptedObservation>();
    for (const id of flightIds)
      for (const item of await onFile('flight', id, 'flight.report', 'all')) all.set(item.id, item);
    for (const id of aircraftIds)
      for (const item of await onFile('aircraft', id, 'position.fix', 'all')) all.set(item.id, item);
    return all;
  }

  /** One adapter process, started as an operator starts it; `until` waits for a state of its log, `stop` ends it. */
  function start(principal: AuthContext) {
    const stop = new AbortController();
    const lines: Line[] = [];
    const exit = runAdapterHost(
      ['skydio-cloud-flights', '--service-url', emulatorBase, '--poll-seconds', '5'],
      {
        LEDGER_API_URL: address,
        LEDGER_API_CREDENTIAL: `ledger-dev-${principal.id}`,
        LEDGER_CREDENTIAL_LABEL: 'Fictional flight service adapter on the hangar host',
        ADAPTER_SERVICE_TOKEN: serviceToken,
      },
      { out: (line) => lines.push(JSON.parse(line) as Line), stop: stop.signal, fetcher, summaryMs: 100 },
    );
    return {
      lines,
      exit,
      /** Resolves once a count the process printed after this call satisfies `done`. */
      async until(done: (summary: Line) => boolean, what: string) {
        const from = lines.length;
        const deadline = Date.now() + 40_000;
        while (!lines.slice(from).some((line) => line.event === 'summary' && done(line))) {
          if (Date.now() > deadline) throw new Error(`The process did not reach: ${what}. ${JSON.stringify(lines)}`);
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      },
      async stop() {
        stop.abort();
        return exit;
      },
    };
  }
  /** Handed over and submitted this many messages in all, with nothing waiting. */
  const settledAt = (messages: number) => (line: Line) =>
    line.received === messages && line.submittedMessages === messages && line.queued === 0;

  beforeAll(async () => {
    await new Promise<void>((resolve) => emulator.server.listen(0, '127.0.0.1', resolve));
    emulatorBase = `http://127.0.0.1:${(emulator.server.address() as AddressInfo).port}`;
    // Three invented flights around now: one landed with telemetry, one landed without, one in the air.
    emulator.state.skydio = skydioEmulatorState(new Date(base).toISOString());
    emulator.state.sourceClock = new Date(base).toISOString();
    app = await createApp({ pool, env: 'test', objectStore: store });
    address = await app.listen({ host: '127.0.0.1', port: 0 });
    await admin.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenantId, 'Fictional inspection operator']);
    const people = {
      reader: { kind: 'human', capabilities: ['evidence:read', 'flight:read', 'authority:write'] },
      source: { kind: 'source', capabilities: ['input:write', 'evidence:read'] },
      // A source as the other adapters' credentials are issued: it may write and not read.
      writer: { kind: 'source', capabilities: ['input:write'] },
    } as const;
    for (const [role, person] of Object.entries(people) as [keyof typeof people, (typeof people)['reader']][]) {
      who[role] = {
        id: `${tenantId}:${role}`,
        tenantId,
        name: `Fictional ${role}`,
        kind: person.kind,
        revision: 1,
        capabilities: [...person.capabilities],
      };
      await admin.query('INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,$3,$4,$5)', [
        who[role].id,
        tenantId,
        who[role].name,
        person.kind,
        person.capabilities,
      ]);
      await admin.query('INSERT INTO api_credentials(token_hash,principal_id) VALUES($1,$2)', [
        sha256(`ledger-dev-${who[role].id}`),
        who[role].id,
      ]);
    }
    for (const principal of [who.source, who.writer]) {
      const current = await call(who.reader, 'GET', `/v1/authority/principals/${encodeURIComponent(principal.id)}`);
      const granted = await call(who.reader, 'POST', '/v1/commands', {
        kind: 'authority.update',
        principalId: principal.id,
        expectedRevision: current.json().principal.revision,
        capabilities: current.json().principal.capabilities,
        observationGrants: ['flight.report', 'position.fix'].map((observationType) => ({ sourceId, observationType })),
      });
      expect(granted.statusCode, granted.body).toBe(201);
    }
  });

  afterAll(async () => {
    await settleOwnedWork([prefix]);
    if (app) await app.close();
    emulator.server.closeAllConnections();
    await new Promise<void>((resolve) => emulator.server.close(() => resolve()));
    await pool.end();
    await admin.end();
  });

  it('records each flight once, replaces the report of a flight the service changes, and records nothing twice', async () => {
    const first = start(who.source);

    // (a) The first poll: three flights and the telemetry of the one flight that has it.
    await first.until(settledAt(4), 'the first poll submitted');
    const reports = new Map<string, AcceptedObservation[]>();
    for (const id of flightIds) reports.set(id, await onFile('flight', id, 'flight.report'));
    for (const id of flightIds) expect(reports.get(id), id).toHaveLength(1);
    expect(reports.get('EXAMPLE-FLIGHT-0001')![0]!.observation).toMatchObject({
      secondarySubject: { kind: 'aircraft', id: 'EXAMPLE-VEHICLE-01', scope: 'source' },
      position: { latitudeDegrees: 44.5, longitudeDegrees: -100.5 },
      values: { activity: 'landed' },
      fidelity: 'synthetic_contract',
    });
    const inTheAir = reports.get('EXAMPLE-FLIGHT-0003')![0]!;
    expect(inTheAir.observation.values).toEqual({ takeoffAt: new Date(base - 4 * 60_000).toISOString() });
    const positions = await onFile('aircraft', 'EXAMPLE-VEHICLE-01', 'position.fix');
    expect(positions.length).toBeGreaterThan(200);
    expect(positions.length).toBeLessThanOrEqual(240);
    expect(new Set(positions.map((item) => (item.observation.secondarySubject as { id: string }).id))).toEqual(
      new Set(['EXAMPLE-FLIGHT-0001']),
    );
    expect(positions[0]!.observation).toMatchObject({
      position: { altitude: { datum: 'takeoff_point' } },
      values: { fix: 'unknown', method: 'satellite' },
    });
    expect(await onFile('aircraft', 'EXAMPLE-VEHICLE-02', 'position.fix')).toEqual([]);
    const afterFirst = await everything();
    expect(afterFirst.size).toBe(3 + positions.length);

    // (b) The same process polls again with nothing changed: nothing is handed over, nothing is recorded.
    const polls = listReads().length;
    while (listReads().length < polls + 2) await new Promise((resolve) => setTimeout(resolve, 100));
    await first.until(settledAt(4), 'a second poll with nothing new');
    expect([...(await everything()).keys()].sort()).toEqual([...afterFirst.keys()].sort());

    // (c) Nine minutes on, the service lists the third flight with its landing.
    emulator.state.sourceClock = new Date(base + 9 * 60_000).toISOString();
    await first.until(settledAt(5), 'the changed flight submitted');
    const current = await onFile('flight', 'EXAMPLE-FLIGHT-0003', 'flight.report');
    expect(current).toHaveLength(1);
    expect(current[0]!.observation.values).toEqual({
      activity: 'landed',
      takeoffAt: new Date(base - 4 * 60_000).toISOString(),
      landingAt: new Date(base + 8 * 60_000).toISOString(),
    });
    expect(current[0]!.replaces).toBe(inTheAir.id);
    const history = await onFile('flight', 'EXAMPLE-FLIGHT-0003', 'flight.report', 'all');
    expect(history.map((item) => item.id).sort()).toEqual([inTheAir.id, current[0]!.id].sort());
    expect(history.find((item) => item.id === inTheAir.id)).toMatchObject({ replacedBy: current[0]!.id });
    for (const id of ['EXAMPLE-FLIGHT-0001', 'EXAMPLE-FLIGHT-0002'])
      expect((await onFile('flight', id, 'flight.report', 'all')).map((item) => item.id)).toEqual([
        reports.get(id)![0]!.id,
      ]);
    expect(await first.stop()).toBe(0);
    expect(first.lines.at(-1)).toMatchObject({ event: 'stopped', unsubmitted: 0, refused: 0, rejected: 0 });
    const afterChange = await everything();
    expect(afterChange.size).toBe(afterFirst.size + 1);

    // (d) The process is started again. It reads every flight and the telemetry again, and Ledger gains nothing.
    const again = start(who.source);
    await again.until(settledAt(4), 'the restarted process read everything again');
    expect(await again.stop()).toBe(0);
    expect(again.lines.at(-1)).toMatchObject({ event: 'stopped', unsubmitted: 0, refused: 0, rejected: 0 });
    const afterRestart = await everything();
    expect([...afterRestart.keys()].sort()).toEqual([...afterChange.keys()].sort());
    for (const [id, item] of afterRestart)
      expect({ replaces: item.replaces, replacedBy: item.replacedBy }, id).toEqual({
        replaces: afterChange.get(id)!.replaces,
        replacedBy: afterChange.get(id)!.replacedBy,
      });
    expect(await onFile('flight', 'EXAMPLE-FLIGHT-0003', 'flight.report')).toHaveLength(1);
  }, 150_000);

  it('does not start with a credential that may not read what is on file, and says what to give it', async () => {
    const asked = listReads().length;
    const refused = start(who.writer);
    expect(await refused.exit).toBe(1);
    expect(refused.lines[0]!.event).toBe('starting');
    expect(refused.lines.at(-1)).toMatchObject({
      event: 'cannot_start',
      message:
        'Fictional writer may not read observations: give it evidence:read on the People screen. Before this adapter reports a flight.report it reads the one on file about the same subject, so a changed record replaces the earlier one instead of standing beside it.',
    });
    // It asked the service nothing.
    expect(listReads()).toHaveLength(asked);
  });

  it('sends the service’s token to the service only: nothing Ledger was sent or keeps holds it', async () => {
    // To the service: the token is the whole Authorization header, on every request, and nowhere else in one.
    const toService = sent.filter((request) => request.to === 'service');
    expect(toService.length).toBeGreaterThan(4);
    for (const request of toService) {
      expect(request.headers.authorization).toBe(serviceToken);
      expect(`${request.url} ${request.body}`).not.toContain(serviceToken);
    }
    // To Ledger: no request's address, headers or body holds it.
    const toLedger = sent.filter((request) => request.to === 'ledger');
    expect(toLedger.some((request) => request.url.endsWith('/v1/inputs'))).toBe(true);
    expect(toLedger.some((request) => request.url.includes('/content'))).toBe(true);
    for (const request of toLedger) expect(JSON.stringify(request)).not.toContain(serviceToken);
    // In Ledger: no retained original, and no row of the journal, the receipts or the observations, holds it.
    expect(store.stored.length).toBeGreaterThan(4);
    for (const bytes of store.stored) expect(Buffer.from(bytes).includes(serviceToken)).toBe(false);
    const held = await admin.query<{ count: string }>(
      `SELECT (SELECT COUNT(*) FROM journal_events WHERE tenant_id=$1 AND payload::text LIKE $2)
        +(SELECT COUNT(*) FROM receipts WHERE tenant_id=$1 AND payload::text LIKE $2)
        +(SELECT COUNT(*) FROM observations WHERE tenant_id=$1 AND observation::text LIKE $2) AS count`,
      [tenantId, `%${serviceToken}%`],
    );
    expect(Number(held.rows[0]!.count)).toBe(0);
    const rows = await admin.query<{ count: string }>('SELECT COUNT(*) AS count FROM observations WHERE tenant_id=$1', [
      tenantId,
    ]);
    expect(Number(rows.rows[0]!.count)).toBeGreaterThan(200);
  });
});
