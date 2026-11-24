import {
  type AdapterDescriptor,
  type ObservationAdapter,
  type ObservationDraft,
  type OriginalLocator,
  type TranslateFunction,
  type TranslationRejection,
  decodeStrictJson,
  jsonPointer,
  rejected,
  subjectFor,
  unknownKeys,
} from './adapter-contract.js';

/**
 * A crew roster export file: one JSON document per export, each entry one duty, flight-duty or rest period of one
 * person. The format is invented for this repository; its emulator is the sample file
 * packages/contracts/fixtures/crew-roster/alpha-crew-roster.json.
 *
 * Each entry becomes one crew.duty-period observation keyed by its entry id and revision, so the same entry sent again
 * in the same export is recorded once. An amended entry is a later revision: submit it with the intake envelope's
 * `replaces` naming the observation it corrects.
 */
const ROSTER_BYTES_LIMIT = 4 * 1024 * 1024;
const MAX_ENTRIES = 2000;
const FORMAT = 'crew-roster-export';
const UTC_SECONDS = /^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d{1,3})?Z$/;
const ENTRY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

const periods = { DUTY: 'duty', FLIGHT_DUTY: 'flight_duty', REST: 'rest' } as const;
const roles = {
  PILOT: 'remote_pilot',
  OBSERVER: 'visual_observer',
  PAYLOAD: 'payload_operator',
  OTHER: 'other',
} as const;
const fileKeys = ['format', 'formatVersion', 'entries'];
const entryKeys = ['entryId', 'revision', 'employeeId', 'position', 'kind', 'start', 'end'];

export const crewRosterDutyDescriptor: AdapterDescriptor = {
  id: 'crew-roster-export-duty-periods',
  version: '1.0.0',
  source: {
    vendor: 'Example Rostering',
    product: 'Crew roster export',
    interface: 'One UTF-8 JSON export file per upload, at most 4 MiB and 2,000 entries',
  },
  produces: [{ type: 'crew.duty-period', version: 1 }],
  fidelity: 'synthetic_contract',
  limitations: [
    'Built from an invented export format and a sample file, not from a real rostering system.',
    'Each period is what the operator entered in its roster: a planned period that was never amended reads the same as one worked as planned.',
    'The person is the operator’s own employee identifier, not a Ledger person.',
    'Times are the UTC instants the export states. Periods the operator did not enter are absent, and a gap between periods is not rest.',
  ],
  documentation: [
    {
      reference:
        'Crew roster export format, described in packages/adapters/src/crew-roster-duty.ts, with the sample file packages/contracts/fixtures/crew-roster/alpha-crew-roster.json.',
    },
  ],
};

type Entry = Record<string, unknown>;
type DutyDraft = ObservationDraft;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const utcTime = (value: unknown): value is string =>
  typeof value === 'string' && UTC_SECONDS.test(value) && Number.isFinite(Date.parse(value));

/** The reason an entry cannot become an observation, or undefined. */
function entryProblem(entry: Entry): string | undefined {
  if (typeof entry.entryId !== 'string' || !ENTRY_ID.test(entry.entryId))
    return 'entryId must be 1 to 100 letters, digits, dots, colons, hyphens or underscores';
  if (entry.revision !== undefined && (!Number.isSafeInteger(entry.revision) || (entry.revision as number) < 1))
    return 'revision must be a positive whole number';
  if (typeof entry.employeeId !== 'string' || !entry.employeeId.trim() || entry.employeeId.length > 200)
    return 'employeeId must be a non-blank identifier of at most 200 characters';
  if (typeof entry.kind !== 'string' || !Object.hasOwn(periods, entry.kind))
    return `kind must be one of ${Object.keys(periods).join(', ')}`;
  if (entry.position !== undefined && (typeof entry.position !== 'string' || !Object.hasOwn(roles, entry.position)))
    return `position must be one of ${Object.keys(roles).join(', ')}`;
  if (!utcTime(entry.start)) return 'start must be a UTC time written as YYYY-MM-DDThh:mm:ssZ';
  if (entry.end !== undefined && !utcTime(entry.end)) return 'end must be a UTC time written as YYYY-MM-DDThh:mm:ssZ';
  if (entry.end !== undefined && Date.parse(entry.end as string) <= Date.parse(entry.start as string))
    return 'end must be after start';
  return undefined;
}

const eventIdOf = (entry: Entry) => `${String(entry.entryId)}@${String(entry.revision ?? 1)}`;

export const translateCrewRosterDuty: TranslateFunction = (message, context) => {
  if (message.contentType !== 'application/json') return rejected('A crew roster export must be application/json');
  const decoded = decodeStrictJson(message.bytes, ROSTER_BYTES_LIMIT);
  if (!decoded.ok) return rejected(`Invalid or ambiguous JSON: ${decoded.reason}`);
  const file = decoded.value;
  if (!isObject(file)) return rejected('A crew roster export is a JSON object');
  if (file.format !== FORMAT || file.formatVersion !== 1)
    return rejected(`Only ${FORMAT} format version 1 is read`, jsonPointer('format'));
  const entries = file.entries;
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_ENTRIES)
    return rejected(`entries must list 1 to ${MAX_ENTRIES} roster entries`, jsonPointer('entries'));
  const seen = new Map<string, number>();
  for (const [index, entry] of entries.entries()) {
    if (!isObject(entry)) continue;
    const key = eventIdOf(entry);
    if (seen.has(key))
      return rejected(
        `Entry ${key} is listed twice (entries ${seen.get(key)} and ${index}); the export is ambiguous`,
        jsonPointer('entries', index),
      );
    seen.set(key, index);
  }

  const drafts: DutyDraft[] = [];
  const rejections: TranslationRejection[] = [];
  const unmapped: OriginalLocator[] = unknownKeys(file, fileKeys);
  for (const [index, entry] of entries.entries()) {
    const locator = jsonPointer('entries', index);
    if (!isObject(entry)) {
      rejections.push({ reason: 'A roster entry is a JSON object', locator });
      continue;
    }
    unmapped.push(...unknownKeys(entry, entryKeys, 'entries', index));
    const problem = entryProblem(entry);
    const subject = problem ? undefined : subjectFor(context.subjects, 'person', entry.employeeId as string);
    if (problem || !subject) {
      rejections.push({ reason: problem ?? 'No Ledger person is bound to this employee', locator });
      continue;
    }
    const start = entry.start as string;
    drafts.push({
      type: 'crew.duty-period',
      version: 1,
      subject,
      occurredAt: start,
      interval: { start, ...(entry.end === undefined ? {} : { end: entry.end as string }) },
      sourceEventId: eventIdOf(entry),
      originalLocator: locator,
      values: {
        period: periods[entry.kind as keyof typeof periods],
        ...(entry.position === undefined ? {} : { role: roles[entry.position as keyof typeof roles] }),
      },
    } as DutyDraft);
  }
  return { drafts, rejections, unmapped };
};

export const crewRosterDutyAdapter: ObservationAdapter = {
  descriptor: crewRosterDutyDescriptor,
  translate: translateCrewRosterDuty,
};
