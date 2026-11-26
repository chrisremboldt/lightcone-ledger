import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type {
  Command,
  CommandLinkSource,
  CommandResponse,
  FlightResponse,
  MissionSource,
  Principal,
  ReceiptResponse,
  SmsFindingPromotionResponse,
  SmsRecordDetailResponse,
  SmsSigningPreviewResponse,
  TimelineResponse,
} from '@ledger/contracts';
import { completeObservations } from '../../packages/adapters/src/adapter-contract.js';
import { commandLinkStatusAdapter } from '../../packages/adapters/src/command-link-status.js';

export const api = (process.env.LEDGER_API_URL || 'http://127.0.0.1:4000').replace(/\/$/, '');
export const operator = 'ledger-dev-alpha-operator';
export const releaseAuthor = 'ledger-dev-alpha-actor';
export const source = 'ledger-dev-alpha-source';
export const authorization = (token = operator) => ({ authorization: `Bearer ${token}` });
export const writeHeaders = (token = operator) => ({ ...authorization(token), 'idempotency-key': randomUUID() });

/** A lost-link finding: the generic evaluator's reported-episode check, or a retained one in its own format. */
export function isLostLinkEvaluation(evaluation: { explanation: object }): boolean {
  const explanation = evaluation.explanation as {
    kind?: string;
    ruleEvaluation?: { check: { kind: string } };
  };
  return (
    explanation.kind === 'command_link' ||
    (explanation.kind === 'rule' && explanation.ruleEvaluation?.check.kind === 'episode.open')
  );
}

export async function read<T>(request: APIRequestContext, path: string, token = operator): Promise<T> {
  const deadline = Date.now() + 5000;
  while (true) {
    const response = await request.get(`${api}${path}`, {
      headers: authorization(token),
      timeout: Math.max(1, deadline - Date.now()),
    });
    if (
      response.status() === 409 &&
      (await response.json()).error?.code === 'concurrent_change' &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, deadline - Date.now())));
      continue;
    }
    expect(response.ok(), `${path}: ${await response.text()}`).toBeTruthy();
    return response.json() as Promise<T>;
  }
}

export async function principal(request: APIRequestContext, token = operator) {
  return (await read<{ principal: Principal }>(request, '/v1/me', token)).principal;
}

/**
 * Sends a command. A 409 concurrent_change is PostgreSQL refusing a transaction that raced a worker (a serialization
 * failure or a deadlock): nothing was recorded, and the API's answer is to retry. It is sent again, as read() reads
 * again, for at most five seconds; any other refusal fails the test at once.
 */
export async function command(request: APIRequestContext, body: Command) {
  const deadline = Date.now() + 5000;
  while (true) {
    const response = await request.post(`${api}/v1/commands`, { headers: writeHeaders(), data: body });
    if (
      response.status() === 409 &&
      (await response.json()).error?.code === 'concurrent_change' &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, deadline - Date.now())));
      continue;
    }
    expect(response.status(), await response.text()).toBe(201);
    return response.json() as Promise<CommandResponse>;
  }
}

export async function complete(request: APIRequestContext, receiptId: string) {
  await expect
    .poll(async () => (await read<ReceiptResponse>(request, `/v1/receipts/${receiptId}`)).receipt.processing.status, {
      message: 'Worker must finish this accepted public source record',
      timeout: 20_000,
    })
    .toBe('completed');
}

export async function upload(request: APIRequestContext, raw: unknown, token = source) {
  const bytes = Buffer.from(`${JSON.stringify(raw)}\n`);
  const created = await request.post(`${api}/v1/uploads`, {
    headers: writeHeaders(token),
    data: { contentType: 'application/json', byteLength: bytes.byteLength },
  });
  expect(created.status(), await created.text()).toBe(201);
  const { upload } = (await created.json()) as { upload: { id: string } };
  const stored = await request.put(`${api}/v1/uploads/${upload.id}/content`, {
    headers: { ...writeHeaders(token), 'content-type': 'application/octet-stream' },
    data: bytes,
  });
  expect(stored.ok(), await stored.text()).toBeTruthy();
  const finalized = await request.post(`${api}/v1/uploads/${upload.id}/finalize`, {
    headers: writeHeaders(token),
  });
  expect(finalized.status(), await finalized.text()).toBe(201);
  return ((await finalized.json()) as { artifact: { id: string } }).artifact.id;
}

type LinkGrantHolder = Pick<Principal, 'id' | 'revision' | 'capabilities' | 'observationGrants'>;

/** Grants the principal link.status observations under the source id, keeping its other grants. */
export function linkStatusGrant(
  holder: LinkGrantHolder,
  sourceId: string,
): Extract<Command, { kind: 'authority.update' }> {
  return {
    kind: 'authority.update',
    principalId: holder.id,
    expectedRevision: holder.revision,
    capabilities: holder.capabilities,
    observationGrants: [...(holder.observationGrants ?? []), { sourceId, observationType: 'link.status' }],
  };
}

/** Removes the link.status grant under the source id that linkStatusGrant added. */
export function linkStatusRevocation(
  holder: LinkGrantHolder,
  sourceId: string,
): Extract<Command, { kind: 'authority.update' }> {
  return {
    kind: 'authority.update',
    principalId: holder.id,
    expectedRevision: holder.revision,
    capabilities: holder.capabilities,
    observationGrants: (holder.observationGrants ?? []).filter(
      (grant) => grant.sourceId !== sourceId || grant.observationType !== 'link.status',
    ),
  };
}

const holdsLinkStatus = (holder: LinkGrantHolder, sourceId: string) =>
  (holder.observationGrants ?? []).some(
    (grant) => grant.sourceId === sourceId && grant.observationType === 'link.status',
  );

/** Runs the step with the source principal holding the link.status grant, added for the step when it lacks it. */
export async function withLinkStatusGrant<T>(
  request: APIRequestContext,
  sourceId: string,
  step: () => Promise<T>,
): Promise<T> {
  const holder = (await read<{ principal: Principal }>(request, '/v1/me', source)).principal;
  if (holdsLinkStatus(holder, sourceId)) return step();
  await command(request, linkStatusGrant(holder, sourceId));
  try {
    return await step();
  } finally {
    const current = (await read<{ principal: Principal }>(request, '/v1/me', source)).principal;
    await command(request, linkStatusRevocation(current, sourceId));
  }
}

/**
 * Sends one command-link report as a real source does: its original bytes, then the link.status observation the
 * command-link adapter translates them to, through the generic intake. Returns the receipt.
 */
export async function reportLinkStatus(
  request: APIRequestContext,
  sourceId: string,
  flightId: string,
  raw: CommandLinkSource,
  token = source,
): Promise<ReceiptResponse['receipt']> {
  const bytes = Buffer.from(`${JSON.stringify(raw)}\n`);
  const translated = commandLinkStatusAdapter.translate(
    { bytes, contentType: 'application/json', transport: {}, capturedAt: raw.occurredAt },
    {
      subjects: { scope: 'ledger', ids: { flight: { [raw.sourceSessionId]: flightId } } },
      binding: { sourceSessionId: raw.sourceSessionId, aircraftId: raw.aircraftId },
    },
  );
  expect(translated.rejections).toEqual([]);
  const artifactId = await upload(request, raw, token);
  const [observation] = completeObservations(commandLinkStatusAdapter.descriptor, translated.drafts, artifactId);
  const response = await request.post(`${api}/v1/inputs`, {
    headers: writeHeaders(token),
    data: { sourceId, kind: 'observation', occurredAt: observation!.occurredAt, payload: observation },
  });
  expect(response.status(), await response.text()).toBe(201);
  return ((await response.json()) as ReceiptResponse).receipt;
}

export async function createFlight(
  request: APIRequestContext,
  label: string,
  aircraft: string,
  start: number,
  end: number,
) {
  const response = await request.post(`${api}/v1/flights`, {
    headers: writeHeaders(),
    data: {
      originationKey: `browser:release:${randomUUID()}`,
      label,
      aircraft,
      scheduledStart: new Date(start).toISOString(),
      scheduledEnd: new Date(end).toISOString(),
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  const { flight } = (await response.json()) as FlightResponse;
  await expect
    .poll(
      async () => (await read<TimelineResponse>(request, `/v1/flights/${flight.id}/timeline`)).flight.outstandingWork,
    )
    .toBe(0);
  return flight;
}

export async function mission(request: APIRequestContext, flightId: string, sourceId: string, raw: MissionSource) {
  const artifactId = await upload(request, raw);
  const { sourceRevision, occurredAt, ...payload } = raw;
  const response = await request.post(`${api}/v1/inputs`, {
    headers: writeHeaders(source),
    data: {
      kind: 'mission.revision',
      sourceId,
      sourceRevision,
      occurredAt,
      subject: { flightId },
      artifactId,
      fidelity: 'synthetic_contract',
      payload,
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  const { receipt } = (await response.json()) as ReceiptResponse;
  await complete(request, receipt.id);
  return receipt;
}

/** An avoidance area: its circle and, when it declares one, how near a planned route must come for it to apply. */
export interface AreaGeometry {
  center: { latitude: number; longitude: number };
  radiusMeters: number;
  appliesWithinMeters?: number;
}

const areaParameters = ({ center, radiusMeters, appliesWithinMeters }: AreaGeometry) => ({
  center,
  radiusMeters,
  ...(appliesWithinMeters === undefined ? {} : { appliesWithinMeters }),
});

export async function acceptedControl(
  request: APIRequestContext,
  sourceId: string,
  identity: string,
  interval: MissionSource['operatingInterval'],
  owner: Principal,
  geometry: AreaGeometry = { center: { latitude: 41.88, longitude: -87.63 }, radiusMeters: 250 },
  label = `Market route avoidance ${identity.slice(0, 6)}`,
) {
  const origin = await createFlight(
    request,
    `Route safety finding ${identity.slice(0, 6)}`,
    'Browser release evidence aircraft',
    Date.now() - 5 * 60_000,
    Date.now() + 30 * 60_000,
  );
  const raw: CommandLinkSource = {
    sourceSessionId: `browser-release-c2-${identity}`,
    sourceEventId: `lost-${identity}`,
    incidentId: `browser-release-incident-${identity}`,
    aircraftId: origin.aircraft!,
    occurredAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    status: 'lost',
    position: geometry.center,
  };
  await complete(
    request,
    (await withLinkStatusGrant(request, sourceId, () => reportLinkStatus(request, sourceId, origin.id, raw))).id,
  );
  let shown: TimelineResponse;
  await expect
    .poll(async () => {
      shown = await read<TimelineResponse>(request, `/v1/flights/${origin.id}/timeline`);
      return (
        shown.flight.outstandingWork === 0 &&
        shown.findings?.some((entry) => isLostLinkEvaluation(entry.latestEvaluation))
      );
    })
    .toBe(true);
  const finding = shown!.findings!.find((entry) => isLostLinkEvaluation(entry.latestEvaluation))!;
  expect(finding).toBeDefined();
  // The dispatcher promotes the finding to a hazard on the safety record, proposes the area as a control record,
  // assesses the hazard with it in place and signs the risk acceptance after confirming locally that it is them.
  const promotion = await read<SmsFindingPromotionResponse>(request, `/v1/sms/findings/${finding.id}/promotion`);
  const title = `Route avoidance ${identity.slice(0, 6)}`;
  const hazardId = (
    await command(request, {
      kind: 'sms.record.open',
      record: {
        kind: 'hazard',
        schema: 'sms.hazard.1',
        title,
        ownerId: owner.id,
        body: {
          description: 'Review the reported interruption before later flights use this area.',
          consequence: 'An aircraft could lose its control link over the market.',
          source: { kind: 'finding' },
        },
      },
      origin: {
        kind: 'finding',
        findingId: finding.id,
        evaluationId: promotion.origin.evaluationId,
        expectedDependencyBasis: promotion.basis.dependencyBasis,
      },
    } as never)
  ).command.subject!.id;
  const record = (id: string) => read<SmsRecordDetailResponse>(request, `/v1/sms/records/${id}`);
  const decide = async (decision: Record<string, unknown>, headers: Record<string, string> = {}) => {
    const shown = await record(hazardId);
    const response = await request.post(`${api}/v1/commands`, {
      headers: { ...writeHeaders(), ...headers },
      data: {
        kind: 'decision.record',
        subject: { kind: 'sms', id: hazardId },
        expectedRevision: shown.basis.revision,
        expectedDependencyBasis: shown.basis.dependencyBasis,
        decision,
      },
    });
    expect(response.status(), await response.text()).toBe(201);
  };
  const opened = await record(hazardId);
  const type = opened.controlTypes!.find((entry) => entry.id === 'control.avoidance-area')!;
  const controlId = (
    await command(request, {
      kind: 'sms.record.open',
      record: {
        kind: 'control',
        schema: 'sms.control.1',
        title: label,
        ownerId: owner.id,
        body: {
          hazardId,
          controlType: { id: type.id, version: type.version, digest: type.digest },
          parameters: areaParameters(geometry),
          effectiveFrom: interval.start,
          effectiveUntil: interval.end,
        },
      },
    } as never)
  ).command.subject!.id;
  await decide({
    kind: 'risk.assess',
    note: 'Review the reported interruption against the current company matrix.',
    matrix: { recordId: opened.matrix!.record.id, versionNumber: opened.matrix!.version.versionNumber },
    initial: { severity: 'major', likelihood: 'remote' },
    controls: [{ recordId: controlId, versionNumber: 1 }],
    residual: { severity: 'minor', likelihood: 'remote' },
    newHazardCheck: { answer: 'none_identified' },
    ...(opened.origin?.kind === 'finding' ? { evidence: { evaluationId: opened.origin.evaluationId } } : {}),
  });
  const assessmentId = (await record(hazardId)).decisions.find((decision) => decision.kind === 'risk.assess')!.id;
  const signing = await read<SmsSigningPreviewResponse>(
    request,
    `/v1/sms/records/${hazardId}/signing?meaning=risk.accept`,
  );
  expect(signing.available, signing.reason).toBe(true);
  const grant = await request.post(`${api}/v1/local/reauthentications`, {
    headers: writeHeaders(),
    data: { credential: operator },
  });
  expect(grant.status(), await grant.text()).toBe(201);
  await decide(
    {
      kind: 'risk.accept',
      note: 'Accept this assessed risk with the exact owned route avoidance control.',
      assessmentId,
      signature: { intent: signing.intent!, contentDigest: signing.contentDigest!, reviewed: true },
    },
    { 'x-ledger-reauthentication': ((await grant.json()) as { grant: string }).grant },
  );
  const accepted = await record(hazardId);
  const listed = accepted.controls!.find((entry) => entry.id === controlId)!;
  expect(listed.accepted).toBe(true);
  const acceptance = accepted.decisions.find((decision) => decision.kind === 'risk.accept')!;
  const version = (await record(controlId)).current as { id: string; versionNumber: number; bodyDigest: string };
  return {
    id: hazardId,
    title,
    origin: { flightId: origin.id, findingId: finding.id },
    control: {
      /** The control version event, which route review candidates cite as controlEventId. */
      id: version.id,
      hazardId,
      controlId,
      controlVersion: version.versionNumber,
      bodyDigest: version.bodyDigest,
      label,
      description: listed.description as string,
      area: geometry,
      effectiveFrom: interval.start,
      effectiveUntil: interval.end,
    },
    acceptance: {
      id: acceptance.id,
      acceptedRevision: acceptance.acceptedRevision,
      digest: acceptance.signature!.contentDigest,
    },
  };
}

/** A hazard on the safety record from a flight finding, with an accepted avoidance area, as acceptedControl returns it. */
export type AcceptedAreaControl = Awaited<ReturnType<typeof acceptedControl>>;

/**
 * Records a new version of an accepted avoidance area through the public API, as its owner revising it on the safety
 * record does. The accepted version stays on the record; returns the new version's number.
 */
export async function supersedeControl(
  request: APIRequestContext,
  hazard: AcceptedAreaControl,
  owner: Principal,
  title = `${hazard.control.label} (revised)`,
) {
  const record = (id: string) => read<SmsRecordDetailResponse>(request, `/v1/sms/records/${id}`);
  const type = (await record(hazard.id)).controlTypes!.find((entry) => entry.id === 'control.avoidance-area')!;
  const shown = await record(hazard.control.controlId);
  await command(request, {
    kind: 'sms.record.revise',
    recordId: hazard.control.controlId,
    expectedRevision: shown.basis.revision,
    record: {
      kind: 'control',
      schema: 'sms.control.1',
      title,
      ownerId: owner.id,
      body: {
        hazardId: hazard.id,
        controlType: { id: type.id, version: type.version, digest: type.digest },
        parameters: areaParameters(hazard.control.area),
        effectiveFrom: hazard.control.effectiveFrom,
        effectiveUntil: hazard.control.effectiveUntil,
      },
    },
  } as never);
  const revised = (await record(hazard.control.controlId)).current as { versionNumber: number };
  expect(revised.versionNumber).toBeGreaterThan(hazard.control.controlVersion);
  return revised.versionNumber;
}

export async function localMinute(page: Page, timestamp: number) {
  return page.evaluate((value) => {
    const date = new Date(value);
    return new Date(value - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  }, timestamp);
}

/** The digest of the open findings a release of this flight would list, for a command sent without the form. */
export async function releaseFindingsDigest(request: APIRequestContext, flightId: string, token = operator) {
  return (await read<{ basis: { digest: string } }>(request, `/v1/flights/${flightId}/mission-release-findings`, token))
    .basis.digest;
}

/** Records in the release form that the listed open findings were reviewed, when any are listed. */
export async function attestReleaseFindings(form: Locator) {
  const reviewed = form.getByLabel(/^I reviewed the \d+ open findings? listed above\.$/);
  if (await reviewed.count()) await reviewed.check();
}
