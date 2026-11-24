import { Ajv } from 'ajv';
import addFormats from 'ajv-formats';
import {
  CommandLinkSourceSchema,
  CONTROL_EFFECTIVENESS_LIMITS,
  MissionRevisionRecordSchema,
  MonitoringReportSourceSchema,
  type FlightSummary,
  type MissionRevisionRecord,
  type MonitoringReportSource,
} from '@ledger/contracts';
import { canonicalDigest, canonicalize, parseStrictJson, sha256 } from '@ledger/integrity';
import type { OperationMonitoringSnapshot } from '@ledger/simulation-models/operation';
import { prepareWorldFact } from './operation-delivery.js';

export interface OperationMonitoringPublicBinding {
  attemptId: string;
  flight: Pick<FlightSummary, 'id' | 'originationKey' | 'aircraft'>;
  mission: MissionRevisionRecord;
}

interface SourceOriginal {
  bytesBase64: string;
  sha256: string;
  byteLength: number;
}

export interface OperationMonitoringC2Original extends SourceOriginal {
  sourceId: string;
  sourceSessionId: string;
  sourceEventId: string;
}

export interface PreparedOperationMonitoringSource extends SourceOriginal {
  version: 'operation.monitoring-source.1';
  identity: {
    runId: string;
    tenantId: string;
    sourceId: string;
    sourceSessionId: string;
    sourceWindowId: string;
    sourceRevision: number;
    planDigest: string;
  };
  key: string;
  c2Originals: OperationMonitoringC2Original[];
}

export interface OperationMonitoringPreparation {
  status: 'pending';
  reasons: string[];
  source?: MonitoringReportSource;
  original?: PreparedOperationMonitoringSource;
}

type RetainedOriginal = Omit<PreparedOperationMonitoringSource, 'c2Originals'> & {
  c2OriginalDigests: string[];
};

export interface OperationMonitoringSourceJournal {
  version: 'operation.monitoring-source-journal.1';
  identityDigest: string;
  originals: RetainedOriginal[];
  c2Originals: Record<string, OperationMonitoringC2Original>;
}

const ajv = new Ajv({ allErrors: true, strict: false });
(addFormats as unknown as (instance: Ajv) => void)(ajv);
const missionShape = ajv.compile<MissionRevisionRecord>(MissionRevisionRecordSchema);
const sourceShape = ajv.compile<MonitoringReportSource>(MonitoringReportSourceSchema);
const c2Shape = ajv.compile(CommandLinkSourceSchema);
export const OPERATION_MONITORING_JOURNAL_LIMITS = Object.freeze({
  maxBytes: 4 * 1024 * 1024,
  maxRevisions: 16,
});
const limits = CONTROL_EFFECTIVENESS_LIMITS;
const same = (left: unknown, right: unknown): boolean => canonicalize(left) === canonicalize(right);

function invalid(reason: string): never {
  throw new Error(reason);
}

function original(bytes: Uint8Array): SourceOriginal {
  return { bytesBase64: Buffer.from(bytes).toString('base64'), sha256: sha256(bytes), byteLength: bytes.length };
}

function decoded(value: SourceOriginal, maximum: number): unknown {
  if (
    !Number.isSafeInteger(value.byteLength) ||
    value.byteLength < 1 ||
    value.byteLength > maximum ||
    typeof value.bytesBase64 !== 'string' ||
    value.bytesBase64.length > 4 * Math.ceil(maximum / 3)
  )
    return invalid('Monitoring original exceeds its byte bound');
  const bytes = Buffer.from(value.bytesBase64, 'base64');
  if (
    bytes.toString('base64') !== value.bytesBase64 ||
    bytes.length !== value.byteLength ||
    sha256(bytes) !== value.sha256
  )
    return invalid('Monitoring original commitment changed');
  return parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes), { maxBytes: maximum });
}

function missionReference(
  observed: OperationMonitoringSnapshot['flights'][number],
  binding: OperationMonitoringPublicBinding,
  tenantId: string,
): MonitoringReportSource['flights'][number]['mission'] {
  const record = binding.mission;
  const executed = observed.executedMission;
  if (
    !executed ||
    binding.attemptId !== observed.attemptId ||
    binding.flight.originationKey !== observed.attemptId ||
    binding.flight.aircraft !== observed.aircraftId ||
    !missionShape(record) ||
    record.flightId !== binding.flight.id ||
    record.aircraftId !== observed.aircraftId ||
    record.sourceId !== 'mission-planner' ||
    record.authority.tenantId !== tenantId ||
    record.authority.sourceId !== record.sourceId ||
    !record.authority.grantedSources.includes(record.sourceId)
  )
    return invalid('Public monitoring binding differs from the observed flight or executed mission');
  const source = {
    sourceRevision: record.sourceRevision,
    occurredAt: record.occurredAt,
    sourceMissionId: record.sourceMissionId,
    aircraftId: record.aircraftId,
    route: record.route,
    lateralToleranceMeters: record.lateralToleranceMeters,
    altitude: record.altitude,
    operatingInterval: record.operatingInterval,
    ...(record.routePlanning ? { routePlanning: record.routePlanning } : {}),
  };
  if (!same(source, executed)) return invalid('Public mission differs from the executed source revision');
  const bytes = observed.executedMissionOriginalBytesBase64
    ? Buffer.from(observed.executedMissionOriginalBytesBase64, 'base64')
    : Buffer.from(JSON.stringify(executed), 'utf8');
  const retained = original(bytes);
  const { sourceRevision, occurredAt, ...payload } = executed;
  const contentDigest = canonicalDigest({
    version: 'ledger.mission-content.1',
    sourceId: record.sourceId,
    flightId: record.flightId,
    sourceRevision,
    occurredAt,
    fidelity: 'synthetic_contract',
    payload,
    original: { sha256: retained.sha256, byteLength: retained.byteLength, bytesBase64: retained.bytesBase64 },
  });
  if (
    record.original.sha256 !== retained.sha256 ||
    record.original.byteLength !== retained.byteLength ||
    record.contentDigest !== contentDigest
  )
    return invalid('Public mission original does not match the executed source bytes');
  return {
    missionId: record.missionId,
    sourceRevision: record.sourceRevision,
    eventId: record.id,
    contentDigest: record.contentDigest,
    recordDigest: canonicalDigest(record),
  };
}

export function prepareOperationMonitoringSource(
  snapshot: OperationMonitoringSnapshot,
  bindings: OperationMonitoringPublicBinding[],
  sourceRevision: number,
): OperationMonitoringPreparation {
  if (!Number.isSafeInteger(sourceRevision) || sourceRevision < 1)
    return invalid('Monitoring source revision must be a positive safe integer');
  if (snapshot.version !== 'operation.monitoring-snapshot.1') return invalid('Unknown monitoring snapshot');
  if (!snapshot.complete || !snapshot.completedAt)
    return { status: 'pending', reasons: [snapshot.failure?.code ?? 'observation_pending'] };
  const plan = snapshot.plan;
  if (bindings.length < snapshot.flights.length)
    return { status: 'pending', reasons: ['public_bindings_pending', 'monitoring_intake_pending'] };
  if (
    snapshot.flights.length !== plan.flights.length ||
    snapshot.flights.length > limits.maxFlights ||
    bindings.length !== snapshot.flights.length ||
    new Set(bindings.map((binding) => binding.attemptId)).size !== bindings.length ||
    new Set(bindings.map((binding) => binding.flight.id)).size !== bindings.length
  )
    return invalid('Monitoring requires one exact public binding per selected flight');
  const tenantId = `tenant-${plan.tenant}`;
  const reasons = new Set(['monitoring_intake_pending']);
  const c2Originals: OperationMonitoringC2Original[] = [];
  const flights: MonitoringReportSource['flights'] = [];
  for (const observed of snapshot.flights) {
    const binding = bindings.find((candidate) => candidate.attemptId === observed.attemptId);
    if (!binding) return invalid('Monitoring public binding is outside the selected population');
    if (!observed.aircraftId || !observed.c2SourceId || !observed.c2SourceSessionId || !observed.baseline)
      return { status: 'pending', reasons: ['observed_flight_pending', 'monitoring_intake_pending'] };
    if (!observed.reports.some((report) => Date.parse(report.at) < Date.parse(plan.window.start)))
      reasons.add(observed.baseline.state === 'unknown' ? 'c2_baseline_missing' : 'baseline_contract_pending');
    if (Date.parse(observed.baseline.occurredAt) >= Date.parse(plan.window.start))
      reasons.add('c2_baseline_not_before_window');
    const declared: string[] = [];
    for (const report of observed.reports) {
      if (
        report.sourceId !== observed.c2SourceId ||
        report.sourceSessionId !== observed.c2SourceSessionId ||
        report.aircraftId !== observed.aircraftId ||
        report.attemptId !== observed.attemptId ||
        report.tenant !== plan.tenant ||
        Date.parse(report.at) >= Date.parse(plan.window.end)
      )
        return invalid('Monitoring C2 original differs from its selected source session');
      const bytes = Buffer.from(prepareWorldFact(report).bytesBase64, 'base64');
      const value = original(bytes);
      if (!c2Shape(decoded(value, limits.maxC2OriginalBytes))) return invalid('Unsupported C2 source original');
      c2Originals.push({
        sourceId: report.sourceId,
        sourceSessionId: report.sourceSessionId,
        sourceEventId: report.sourceEventId,
        ...value,
      });
      declared.push(report.sourceEventId);
    }
    if (new Set(declared).size !== declared.length) return invalid('Monitoring C2 source event identity repeated');
    flights.push({
      flightId: binding.flight.id,
      aircraftId: observed.aircraftId,
      mission: missionReference(observed, binding, tenantId),
      c2SourceId: observed.c2SourceId,
      c2SourceSessionId: observed.c2SourceSessionId,
      historyStart: observed.reports.reduce(
        (earliest, report) => (Date.parse(report.at) < Date.parse(earliest) ? report.at : earliest),
        observed.baseline.occurredAt,
      ),
      observedIntervals: structuredClone(observed.observedIntervals),
      coverageIntervals: structuredClone(observed.coverageIntervals),
      gaps: structuredClone(observed.gaps),
      declaredC2SourceEventIds: declared,
    });
  }
  if (c2Originals.length > limits.maxC2Records) return invalid('Monitoring C2 originals exceed their bound');
  const source: MonitoringReportSource = {
    sourceSessionId: plan.sourceSessionId,
    sourceWindowId: plan.sourceWindowId,
    sourceRevision,
    occurredAt: snapshot.completedAt,
    control: structuredClone(plan.control),
    window: structuredClone(plan.window),
    populationComplete: true,
    completeThrough: plan.window.end,
    flights,
  };
  if (!sourceShape(source)) return invalid('Monitoring source differs from the agreed proposed schema');
  const value = original(Buffer.from(JSON.stringify(source), 'utf8'));
  if (value.byteLength > limits.maxMonitoringOriginalBytes) return invalid('Monitoring source exceeds 128 KiB');
  const identity = {
    runId: plan.runId,
    tenantId,
    sourceId: plan.sourceId,
    sourceSessionId: plan.sourceSessionId,
    sourceWindowId: plan.sourceWindowId,
    sourceRevision,
    planDigest: canonicalDigest(plan),
  };
  const prepared: PreparedOperationMonitoringSource = {
    version: 'operation.monitoring-source.1',
    identity,
    key: `simulator:monitoring:${canonicalDigest(identity)}`,
    ...value,
    c2Originals,
  };
  return { status: 'pending', reasons: [...reasons].sort(), source, original: prepared };
}

function validatePrepared(prepared: PreparedOperationMonitoringSource): MonitoringReportSource {
  const source = decoded(prepared, limits.maxMonitoringOriginalBytes);
  if (!sourceShape(source)) return invalid('Retained monitoring source is invalid');
  if (
    prepared.version !== 'operation.monitoring-source.1' ||
    prepared.identity.sourceSessionId !== source.sourceSessionId ||
    prepared.identity.sourceWindowId !== source.sourceWindowId ||
    prepared.identity.sourceRevision !== source.sourceRevision ||
    prepared.key !== `simulator:monitoring:${canonicalDigest(prepared.identity)}` ||
    prepared.c2Originals.length > limits.maxC2Records
  )
    return invalid('Retained monitoring identity changed');
  for (const retained of prepared.c2Originals) {
    const raw = decoded(retained, limits.maxC2OriginalBytes);
    if (
      !c2Shape(raw) ||
      !same(
        { sourceSessionId: retained.sourceSessionId, sourceEventId: retained.sourceEventId },
        {
          sourceSessionId: (raw as { sourceSessionId: string }).sourceSessionId,
          sourceEventId: (raw as { sourceEventId: string }).sourceEventId,
        },
      )
    )
      return invalid('Retained C2 source identity changed');
  }
  for (const flight of source.flights) {
    const selected = prepared.c2Originals.filter(
      (entry) => entry.sourceId === flight.c2SourceId && entry.sourceSessionId === flight.c2SourceSessionId,
    );
    if (
      !same(selected.map((entry) => entry.sourceEventId).sort(), [...flight.declaredC2SourceEventIds].sort()) ||
      selected.some(
        (entry) =>
          (decoded(entry, limits.maxC2OriginalBytes) as { aircraftId: string }).aircraftId !== flight.aircraftId,
      )
    )
      return invalid('Retained C2 originals differ from declared source membership');
  }
  if (
    prepared.c2Originals.some(
      (entry) =>
        !source.flights.some(
          (flight) => flight.c2SourceId === entry.sourceId && flight.c2SourceSessionId === entry.sourceSessionId,
        ),
    )
  )
    return invalid('Retained C2 original is outside the declared population');
  return source;
}

function immutableScope(source: MonitoringReportSource) {
  return {
    control: source.control,
    window: source.window,
    flights: source.flights.map(({ flightId, aircraftId, mission, c2SourceId, c2SourceSessionId }) => ({
      flightId,
      aircraftId,
      mission,
      c2SourceId,
      c2SourceSessionId,
    })),
  };
}

export function retainOperationMonitoringSource(
  previous: OperationMonitoringSourceJournal | undefined,
  prepared: PreparedOperationMonitoringSource,
): OperationMonitoringSourceJournal {
  const source = validatePrepared(prepared);
  const { sourceRevision: _revision, ...identity } = prepared.identity;
  const identityDigest = canonicalDigest(identity);
  const journal: OperationMonitoringSourceJournal = previous
    ? structuredClone(previous)
    : { version: 'operation.monitoring-source-journal.1', identityDigest, originals: [], c2Originals: {} };
  if (
    journal.version !== 'operation.monitoring-source-journal.1' ||
    journal.identityDigest !== identityDigest ||
    journal.originals.length > OPERATION_MONITORING_JOURNAL_LIMITS.maxRevisions ||
    Buffer.byteLength(JSON.stringify(journal)) > OPERATION_MONITORING_JOURNAL_LIMITS.maxBytes
  )
    return invalid('Monitoring journal belongs to another retained window');
  if (Object.keys(journal.c2Originals).length > limits.maxC2Records)
    return invalid('Monitoring journal exceeds its C2 original bound');
  const identities = new Map<string, string>();
  for (const [digest, entry] of Object.entries(journal.c2Originals)) {
    const identity = canonicalDigest([entry.sourceId, entry.sourceSessionId, entry.sourceEventId]);
    if (canonicalDigest(entry) !== digest || (identities.has(identity) && identities.get(identity) !== digest))
      return invalid('Monitoring journal C2 original identity changed');
    identities.set(identity, digest);
  }
  for (const [index, retained] of journal.originals.entries()) {
    const { sourceRevision, ...binding } = retained.identity;
    if (canonicalDigest(binding) !== identityDigest || sourceRevision !== index + 1)
      return invalid('Monitoring journal revision identity changed');
    const c2Originals = retained.c2OriginalDigests.map((digest) => journal.c2Originals[digest]);
    if (c2Originals.some((value) => !value)) return invalid('Monitoring journal lost a retained C2 original');
    const { c2OriginalDigests: _digests, ...value } = retained;
    const previousSource = validatePrepared({ ...value, c2Originals });
    if (!same(immutableScope(previousSource), immutableScope(source)))
      return invalid('Monitoring revision cannot change its control, window or selected public scope');
  }
  const { c2Originals, ...value } = structuredClone(prepared);
  const c2OriginalDigests = c2Originals.map((entry) => canonicalDigest(entry));
  const retained = { ...value, c2OriginalDigests };
  const existing = journal.originals.find(
    (entry) => entry.identity.sourceRevision === prepared.identity.sourceRevision,
  );
  if (existing) {
    if (!same(existing, retained)) return invalid('Monitoring revision cannot replace its original bytes');
    return journal;
  }
  if (prepared.identity.sourceRevision !== (journal.originals.at(-1)?.identity.sourceRevision ?? 0) + 1)
    return invalid('Monitoring revisions must advance one retained revision at a time');
  if (journal.originals.length >= OPERATION_MONITORING_JOURNAL_LIMITS.maxRevisions)
    return invalid('Monitoring journal revision bound reached');
  for (const [index, entry] of c2Originals.entries()) {
    if (
      Object.values(journal.c2Originals).some(
        (retained) =>
          retained.sourceId === entry.sourceId &&
          retained.sourceSessionId === entry.sourceSessionId &&
          retained.sourceEventId === entry.sourceEventId &&
          !same(retained, entry),
      )
    )
      return invalid('Monitoring cannot replace an issued C2 source event original');
    journal.c2Originals[c2OriginalDigests[index]] = entry;
  }
  if (Object.keys(journal.c2Originals).length > limits.maxC2Records)
    return invalid('Monitoring journal exceeds its C2 original bound');
  journal.originals.push(retained);
  if (Buffer.byteLength(JSON.stringify(journal)) > OPERATION_MONITORING_JOURNAL_LIMITS.maxBytes)
    return invalid('Monitoring journal exceeds its retained byte bound');
  return journal;
}
