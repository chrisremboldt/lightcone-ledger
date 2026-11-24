import { randomUUID } from 'node:crypto';
import {
  CONTROL_WINDOW_LIMITS,
  INDICATOR_LIMITS,
  findObservationType,
  subjectReferenceKey,
  type ControlWindow,
  type ControlWindowControl,
  type ControlWindowIndicatorResponse,
  type ControlWindowListResponse,
  type ControlWindowObservation,
  type ControlWindowOpen,
  type ControlWindowQuery,
  type ControlWindowRevise,
  type IndicatorDefinition,
  type IndicatorPopulation,
  type SubjectReference,
} from '@ledger/contracts';
import { canonicalDigest } from '@ledger/integrity';
import { appendEvent, DomainError, idempotent, type AuthContext, type PoolClient } from '@ledger/persistence';
import { organization } from './adoptions.js';
import { utcMillis } from './check-kinds.js';
import { findExposureKind } from './indicator-exposure-kinds.js';
import { gatherIndicatorInputs, type IndicatorGatherRequest } from './indicator-gathering.js';
import { calculateIndicator, findIndicatorDefinition } from './indicators.js';
import { indicatorResultWording, indicatorTitles, populationWording, principalNames } from './indicator-wording.js';
import { observationRegistry } from './observation-registry.js';

type DeclaredBy = NonNullable<IndicatorPopulation['declaredBy']>;

interface WindowContext {
  format: 'ledger.control-window-context.1';
  organizationId: string;
  control: ControlWindowControl;
  period: { start: string; end: string };
  subjectKind: SubjectReference['kind'];
  expectedObservations: ControlWindowObservation[];
  indicators: { id: string; version: number; digest: string }[];
}

interface RevisionRecord {
  format: 'ledger.control-window-revision.1';
  id: string;
  windowId: string;
  revision: number;
  actorId: string;
  recordedAt: string;
  declaredBy: DeclaredBy;
  subjects: SubjectReference[];
  complete: boolean;
  note: string;
  contextDigest: string;
}

interface WindowRow {
  id: string;
  organization_id: string;
  context: WindowContext;
  context_digest: string;
  opened_at: Date;
  record: RevisionRecord;
  record_digest: string;
}

/**
 * Reads windows kept elsewhere for a control, in the same shape. A window variant that predates this one registers
 * here, so a list for a control returns every window without this module knowing how the others are stored.
 */
export interface RetainedControlWindowSource {
  name: string;
  list(client: PoolClient, principal: AuthContext, query: ControlWindowQuery, limit: number): Promise<ControlWindow[]>;
}

// One process can load this module both from source and from its build (tests do), so the registrations live on a
// process-wide key that both copies share.
const sourcesKey = Symbol.for('ledger.control-window-sources.1');
const retainedSources = ((globalThis as Record<symbol, Map<string, RetainedControlWindowSource> | undefined>)[
  sourcesKey
] ??= new Map());

export function registerRetainedControlWindowSource(source: RetainedControlWindowSource): void {
  retainedSources.set(source.name, source);
}

const WINDOW_COLUMNS = `w.id,w.organization_id,w.context,w.context_digest,w.opened_at,r.record,r.record_digest`;

function invalid(message: string): DomainError {
  return new DomainError(400, 'invalid_control_window', message);
}

function subjectKey(subject: SubjectReference): string {
  try {
    return subjectReferenceKey(subject);
  } catch {
    throw invalid('A source-scoped subject needs its sourceId');
  }
}

/** The listed subjects, each of the window's kind, once each, in a fixed order. */
function normalizedSubjects(subjects: SubjectReference[], kind: SubjectReference['kind']): SubjectReference[] {
  if (subjects.length > CONTROL_WINDOW_LIMITS.maxSubjects)
    throw invalid(`A window lists at most ${CONTROL_WINDOW_LIMITS.maxSubjects} subjects`);
  const keyed = new Map<string, SubjectReference>();
  for (const subject of subjects) {
    if (subject.kind !== kind) throw invalid(`Every listed subject must be of kind ${kind}`);
    if (subject.scope === 'ledger' && subject.sourceId !== undefined)
      throw invalid('A Ledger-scoped subject has no sourceId');
    const key = subjectKey(subject);
    if (keyed.has(key)) throw invalid('A subject is listed twice');
    keyed.set(key, structuredClone(subject));
  }
  return [...keyed.entries()].sort(([left], [right]) => (left < right ? -1 : 1)).map(([, subject]) => subject);
}

function declaredBy(principal: AuthContext): DeclaredBy {
  return { kind: principal.kind === 'human' ? 'person' : 'source', id: principal.id };
}

function requirePeriod(period: { start: string; end: string }): void {
  const start = utcMillis(period.start),
    end = utcMillis(period.end);
  if (start === undefined || end === undefined || start >= end)
    throw invalid('The period must be an ordered pair of UTC instants');
  if (end - start > INDICATOR_LIMITS.maxWindowMilliseconds)
    throw invalid('The period is longer than any indicator allows');
}

function expects(expected: ControlWindowObservation[], type: string, versions: readonly number[]): boolean {
  const declared = expected.find((entry) => entry.type === type);
  return declared !== undefined && versions.every((version) => declared.versions.includes(version));
}

function requireObservationTypes(expected: ControlWindowObservation[]): void {
  if (new Set(expected.map((entry) => entry.type)).size !== expected.length)
    throw invalid('An observation type is listed twice');
  for (const entry of expected)
    for (const version of entry.versions)
      if (!findObservationType(observationRegistry(), entry.type, version))
        throw invalid(`Observation type ${entry.type} version ${version} is not registered`);
}

/** Each indicator must be registered with the cited digest and readable from what the window expects. */
function requireIndicators(input: ControlWindowOpen): IndicatorDefinition[] {
  const keys = input.indicators.map((indicator) => `${indicator.id}@${indicator.version}`);
  if (new Set(keys).size !== keys.length) throw invalid('An indicator is listed twice');
  const length = Date.parse(input.period.end) - Date.parse(input.period.start);
  return input.indicators.map((cited) => {
    const definition = findIndicatorDefinition(cited.id, cited.version);
    if (!definition || definition.digest !== cited.digest)
      throw invalid(`Indicator ${cited.id} version ${cited.version} is not registered with that digest`);
    if (length > definition.window.maxMilliseconds)
      throw invalid(`The period is longer than indicator ${cited.id} allows`);
    if (definition.scope.kind === 'subject_kind' && definition.scope.subjectKind !== input.subjectKind)
      throw invalid(`Indicator ${cited.id} counts subjects of kind ${definition.scope.subjectKind}`);
    const events = definition.events;
    if (events.kind === 'observations' && !expects(input.expectedObservations, events.type, events.versions))
      throw invalid(`Indicator ${cited.id} counts ${events.type}, which the window does not expect`);
    const exposure = findExposureKind(definition.exposure.kind, definition.exposure.version)!;
    for (const read of exposure.reads(definition.exposure.params))
      if (!read.alternative && !expects(input.expectedObservations, read.type, read.versions))
        throw invalid(`Indicator ${cited.id} measures exposure from ${read.type}, which the window does not expect`);
    return definition;
  });
}

/** A control record version bound by its hazard's latest risk acceptance. */
async function requireAcceptedControlRecord(
  client: PoolClient,
  tenantId: string,
  control: ControlWindowControl,
): Promise<void> {
  const found = await client.query(
    `SELECT 1 FROM accepted_hazard_controls a
     JOIN sms_records h ON h.tenant_id=a.tenant_id AND h.id=a.hazard_id AND h.kind='hazard'
     WHERE a.tenant_id=$1 AND a.hazard_id=$2 AND a.control_id=$3 AND a.control_version_number=$4
      AND a.control_body_digest=$5 AND a.acceptance_id=$6 AND h.latest_acceptance_id=a.acceptance_id`,
    [tenantId, control.hazardId, control.recordId, control.versionNumber, control.bodyDigest, control.acceptanceId],
  );
  if (!found.rowCount)
    throw new DomainError(
      404,
      'control_not_accepted',
      'The control version is not bound by the latest risk acceptance of that hazard',
    );
}

function controlIdentity(control: ControlWindowControl): { id: string; version: number } {
  return { id: control.recordId, version: control.versionNumber };
}

function windowFromRow(row: WindowRow): ControlWindow {
  const { context, record } = row;
  return {
    id: row.id,
    variant: 'generic',
    organizationId: row.organization_id,
    control: structuredClone(context.control),
    period: { ...context.period },
    population: {
      subjectKind: context.subjectKind,
      subjects: structuredClone(record.subjects),
      complete: record.complete,
      declaredBy: { ...record.declaredBy },
    },
    expectedObservations: structuredClone(context.expectedObservations),
    indicators: structuredClone(context.indicators),
    openedAt: row.opened_at.toISOString(),
    revision: {
      number: record.revision,
      id: record.id,
      recordedAt: record.recordedAt,
      digest: row.record_digest,
      note: record.note,
    },
  };
}

function verifiedRow(row: WindowRow): ControlWindow {
  if (
    canonicalDigest(row.context) !== row.context_digest ||
    row.record.contextDigest !== row.context_digest ||
    canonicalDigest(row.record) !== row.record_digest
  )
    throw new DomainError(
      409,
      'control_window_commitment_mismatch',
      'A control window differs from its retained digest',
    );
  return windowFromRow(row);
}

async function loadWindow(client: PoolClient, tenantId: string, windowId: string, lock = false): Promise<WindowRow> {
  if (lock)
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array('control-window-revision',$1::text,$2::text)::text,0))`,
      [tenantId, windowId],
    );
  const row = (
    await client.query<WindowRow>(
      `SELECT ${WINDOW_COLUMNS} FROM control_windows w
       JOIN LATERAL (SELECT record,record_digest FROM control_window_revisions
        WHERE tenant_id=w.tenant_id AND window_id=w.id ORDER BY revision DESC LIMIT 1) r ON true
       WHERE w.tenant_id=$1 AND w.id=$2`,
      [tenantId, windowId],
    )
  ).rows[0];
  if (!row) throw new DomainError(404, 'control_window_not_found', 'The window was not found within your organization');
  return row;
}

async function recordRevision(
  client: PoolClient,
  principal: AuthContext,
  windowId: string,
  organizationId: string,
  context: { digest: string; value?: WindowContext },
  revision: number,
  population: { subjects: SubjectReference[]; complete: boolean; note: string },
): Promise<string> {
  const event = await appendEvent(client, principal, {
    type: revision === 1 ? 'control-window.open' : 'control-window.revise',
    stream: `control-window:${windowId}`,
    payload: {
      windowId,
      revision,
      contextDigest: context.digest,
      ...(context.value ? { context: context.value } : {}),
      ...population,
    },
  });
  const record: RevisionRecord = {
    format: 'ledger.control-window-revision.1',
    id: event.id,
    windowId,
    revision,
    actorId: principal.id,
    recordedAt: event.received_at.toISOString(),
    declaredBy: declaredBy(principal),
    subjects: population.subjects,
    complete: population.complete,
    note: population.note,
    contextDigest: context.digest,
  };
  if (context.value)
    await client.query(
      `INSERT INTO control_windows(id,tenant_id,organization_id,control_kind,hazard_id,control_id,control_version,
       acceptance_id,period_start,period_end,subject_kind,context,context_digest,opened_event_id,opened_by,opened_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        windowId,
        principal.tenantId,
        organizationId,
        context.value.control.kind,
        context.value.control.hazardId,
        controlIdentity(context.value.control).id,
        controlIdentity(context.value.control).version,
        context.value.control.acceptanceId,
        context.value.period.start,
        context.value.period.end,
        context.value.subjectKind,
        context.value,
        context.digest,
        event.id,
        principal.id,
        event.received_at,
      ],
    );
  await client.query(
    `INSERT INTO control_window_revisions(id,tenant_id,window_id,organization_id,revision,actor_id,recorded_at,record,record_digest)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      event.id,
      principal.tenantId,
      windowId,
      organizationId,
      revision,
      principal.id,
      event.received_at,
      record,
      canonicalDigest(record),
    ],
  );
  return windowId;
}

/** Opens a window for an accepted control, declaring its first population. */
export async function openControlWindow(
  client: PoolClient,
  principal: AuthContext,
  input: ControlWindowOpen,
  key: string,
): Promise<{ window: ControlWindow; replayed: boolean }> {
  const result = await idempotent(
    client,
    principal,
    'control-window.open',
    key,
    input,
    async () => {
      requirePeriod(input.period);
      requireObservationTypes(input.expectedObservations);
      requireIndicators(input);
      const subjects = normalizedSubjects(input.subjects, input.subjectKind);
      const org = await organization(client, principal.tenantId, 'SHARE');
      await requireAcceptedControlRecord(client, principal.tenantId, input.control);
      const context: WindowContext = {
        format: 'ledger.control-window-context.1',
        organizationId: org.id,
        control: structuredClone(input.control),
        period: { ...input.period },
        subjectKind: input.subjectKind,
        expectedObservations: structuredClone(input.expectedObservations),
        indicators: structuredClone(input.indicators),
      };
      const id = await recordRevision(
        client,
        principal,
        randomUUID(),
        org.id,
        { digest: canonicalDigest(context), value: context },
        1,
        { subjects, complete: input.complete, note: input.note },
      );
      return { id, value: verifiedRow(await loadWindow(client, principal.tenantId, id)) };
    },
    async (id) => verifiedRow(await loadWindow(client, principal.tenantId, id)),
  );
  return { window: result.value, replayed: result.replayed };
}

/** Declares the window's population again. The control, period and expectations stay as opened. */
export async function reviseControlWindow(
  client: PoolClient,
  principal: AuthContext,
  windowId: string,
  input: ControlWindowRevise,
  key: string,
): Promise<{ window: ControlWindow; replayed: boolean }> {
  const result = await idempotent(
    client,
    principal,
    `control-window.revise:${windowId}`,
    key,
    input,
    async () => {
      const current = await loadWindow(client, principal.tenantId, windowId, true);
      verifiedRow(current);
      if (current.record.revision !== input.expectedRevision)
        throw new DomainError(409, 'stale_revision', 'The window was revised after it was shown; review it again');
      await recordRevision(
        client,
        principal,
        windowId,
        current.organization_id,
        { digest: current.context_digest },
        current.record.revision + 1,
        {
          subjects: normalizedSubjects(input.subjects, current.context.subjectKind),
          complete: input.complete,
          note: input.note,
        },
      );
      return { id: windowId, value: verifiedRow(await loadWindow(client, principal.tenantId, windowId)) };
    },
    async (id) => verifiedRow(await loadWindow(client, principal.tenantId, id)),
  );
  return { window: result.value, replayed: result.replayed };
}

export async function getControlWindow(
  client: PoolClient,
  principal: AuthContext,
  windowId: string,
): Promise<ControlWindow> {
  return verifiedRow(await loadWindow(client, principal.tenantId, windowId));
}

/** Every window for one control, newest first, including windows of a retained variant in the same shape. */
export async function listControlWindows(
  client: PoolClient,
  principal: AuthContext,
  query: ControlWindowQuery,
): Promise<ControlWindowListResponse> {
  const limit = CONTROL_WINDOW_LIMITS.maxListed;
  const version = query.controlVersion === undefined ? null : Number(query.controlVersion);
  const rows = await client.query<WindowRow>(
    `SELECT ${WINDOW_COLUMNS} FROM control_windows w
     JOIN LATERAL (SELECT record,record_digest FROM control_window_revisions
      WHERE tenant_id=w.tenant_id AND window_id=w.id ORDER BY revision DESC LIMIT 1) r ON true
     WHERE w.tenant_id=$1 AND w.control_kind=$2 AND w.hazard_id=$3 AND w.control_id=$4
      AND ($5::integer IS NULL OR w.control_version=$5)
     ORDER BY w.opened_at DESC,w.id COLLATE "C" DESC LIMIT $6`,
    [principal.tenantId, query.controlKind, query.hazardId, query.controlId, version, limit + 1],
  );
  const windows = rows.rows.map(verifiedRow);
  for (const source of retainedSources.values())
    windows.push(...(await source.list(client, principal, query, limit + 1)));
  windows.sort((left, right) =>
    left.openedAt === right.openedAt ? (left.id < right.id ? 1 : -1) : left.openedAt < right.openedAt ? 1 : -1,
  );
  const listed = windows.slice(0, limit);
  const names = await principalNames(
    client,
    principal.tenantId,
    listed.map((window) => window.population.declaredBy),
  );
  return {
    windows: listed.map((window) => ({ ...window, wording: windowWording(window, names) })),
    truncated: windows.length > limit,
  };
}

function windowWording(window: ControlWindow, names: ReadonlyMap<string, string>): ControlWindow['wording'] {
  const { subjectKind, subjects, complete, declaredBy } = window.population;
  return {
    population: populationWording(subjectKind, { count: subjects.length, complete, declaredBy }, names),
    indicators: indicatorTitles(window.indicators),
  };
}

/**
 * The gathering request for one of the window's indicators: its period, the population as currently declared, and
 * the evidence cut at the instant of that declaration. Nothing else is needed to calculate the indicator.
 */
export function controlWindowIndicatorRequest(
  window: ControlWindow,
  definition: { id: string; version: number },
): IndicatorGatherRequest {
  if (!window.indicators.some((cited) => cited.id === definition.id && cited.version === definition.version))
    throw new DomainError(404, 'indicator_not_in_window', 'The window was not opened for this indicator');
  return {
    definition: { id: definition.id, version: definition.version },
    window: { ...window.period },
    recordedThrough: window.revision.recordedAt,
    control: controlIdentity(window.control),
    population: {
      subjects: structuredClone(window.population.subjects),
      complete: window.population.complete,
      declaredBy: window.population.declaredBy ? { ...window.population.declaredBy } : null,
    },
  };
}

/** Gathers and calculates one of the window's indicators from its population and cut. */
export async function calculateControlWindowIndicator(
  client: PoolClient,
  principal: AuthContext,
  windowId: string,
  definition: { id: string; version: number },
): Promise<ControlWindowIndicatorResponse> {
  const window = await getControlWindow(client, principal, windowId);
  const request = controlWindowIndicatorRequest(window, definition);
  const cited = window.indicators.find((entry) => entry.id === definition.id && entry.version === definition.version)!;
  if (findIndicatorDefinition(definition.id, definition.version)?.digest !== cited.digest)
    throw new DomainError(
      409,
      'indicator_definition_changed',
      'The indicator registered here differs from the one the window was opened for',
    );
  const gathering = await gatherIndicatorInputs(client, principal, request);
  const result = calculateIndicator(gathering.definition, gathering.input);
  const names = await principalNames(client, principal.tenantId, [result.population.declaredBy]);
  return {
    windowId,
    revision: window.revision.number,
    selection: gathering.outcome,
    result,
    wording: indicatorResultWording(result, { subjectKind: window.population.subjectKind, names }),
  };
}
