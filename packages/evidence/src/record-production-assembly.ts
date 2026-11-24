import {
  findOperatorRecordDefinition,
  producedCsvPath,
  producedRecordCsv,
  RECORD_PRODUCTION_FORMAT,
  type OperatorRecordDefinition,
  type ProducedRecordRow,
  type RecordProductionFlight,
  type RecordProductionJournalPosition,
  type RecordProductionLimits,
  type RecordProductionManifest,
  type RecordProductionManifestFile,
  type RecordProductionOriginal,
  type RecordProductionSelection,
} from '@ledger/contracts';
import { observationRegistry, storedRecord, type RecordRow, type RecordSubject } from '@ledger/domain';
import { sha256 } from '@ledger/integrity';
import { writeZip, type ZipEntry } from './zip.js';

/** A count with its noun, singular for one: "1 record", "3 records". */
const counted = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

/**
 * Builds a produced file from what was read: one CSV per record type, a printable index and the manifest, zipped.
 * Pure: the same sources and issue give the same bytes.
 */

export interface ProductionSources {
  organization: { id: string; name: string; timeZone: string };
  selection: RecordProductionSelection;
  subjects: readonly RecordSubject[];
  /** The selected records, in any order. */
  rows: readonly RecordRow[];
  /** `kind id` of a source subject → the name its records give it. */
  names: ReadonlyMap<string, string>;
  /** Principal id → name. */
  recordedBy: ReadonlyMap<string, string>;
  originals: readonly RecordProductionOriginal[];
  /** The flights each selected person was assigned to. */
  flights: readonly RecordProductionFlight[];
  /** Original bytes by artifact id, when originals are included. */
  originalBytes: ReadonlyMap<string, Uint8Array>;
  journal: readonly RecordProductionJournalPosition[];
  limits: RecordProductionLimits;
}

export interface ProductionIssue {
  productionId: string;
  producedBy: { id: string; name?: string };
  producedAt: string;
  reason: string;
  requestedBy: string;
}

export interface AssembledProduction {
  archive: Buffer;
  manifest: RecordProductionManifest;
  manifestSha256: string;
}

const utf8 = (text: string) => Buffer.from(text, 'utf8');

interface RecordGroup {
  definition: OperatorRecordDefinition | undefined;
  recordType: string;
  recordVersion: number;
  rows: RecordRow[];
}

function recordValues(row: RecordRow): { recordType: string; recordVersion: number; record: Record<string, unknown> } {
  return storedRecord(row);
}

/** Records grouped by type, each group in the order the records were recorded, so a replacement follows what it replaced. */
function groupsOf(rows: readonly RecordRow[]): RecordGroup[] {
  const groups = new Map<string, RecordGroup>();
  for (const row of rows) {
    const values = recordValues(row);
    const key = `${values.recordType}@${values.recordVersion}`;
    const group = groups.get(key) ?? {
      definition: findOperatorRecordDefinition(observationRegistry(), values.recordType, values.recordVersion),
      recordType: values.recordType,
      recordVersion: values.recordVersion,
      rows: [],
    };
    group.rows.push(row);
    groups.set(key, group);
  }
  const recorded = (row: RecordRow) => row.received_at.getTime();
  for (const group of groups.values())
    group.rows.sort((a, b) => recorded(a) - recorded(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return [...groups.values()].sort((a, b) =>
    a.recordType === b.recordType ? a.recordVersion - b.recordVersion : a.recordType < b.recordType ? -1 : 1,
  );
}

function producedRow(row: RecordRow, sources: ProductionSources): ProducedRecordRow {
  const subject = { kind: row.subject_kind, id: row.subject_id, scope: row.subject_scope as 'ledger' | 'source' };
  return {
    recordId: row.id,
    subject,
    ...(row.secondary_subject_kind && row.secondary_subject_id && row.secondary_subject_scope
      ? {
          secondarySubject: {
            kind: row.secondary_subject_kind,
            id: row.secondary_subject_id,
            scope: row.secondary_subject_scope as 'ledger' | 'source',
          },
        }
      : {}),
    record: recordValues(row).record,
    ...(row.replaces_observation_id ? { replaces: row.replaces_observation_id } : {}),
    ...(row.replaced_by ? { replacedBy: row.replaced_by } : {}),
    recordedAt: row.received_at.toISOString(),
    recordedBy: sources.recordedBy.get(row.principal_id) ?? row.principal_id,
    originalFile: row.filename ?? row.artifact_id,
    originalSha256: row.artifact_sha256,
    limitations: row.observation.limitations ?? [],
    ...enteredOf(row),
  };
}

/** What the import kept of how the record's values were entered: converted values and dates alone. */
function enteredOf(row: RecordRow): Pick<ProducedRecordRow, 'entered' | 'dayOnly'> {
  const values = row.observation.values as {
    entered?: Record<string, string>;
    dayOnly?: Record<string, { day: string }>;
  };
  return {
    ...(values?.entered ? { entered: values.entered } : {}),
    ...(values?.dayOnly ? { dayOnly: values.dayOnly } : {}),
  };
}

/** Whether a record value names the subject by the operator's own id, as a reference field does. */
function names(value: unknown, id: string): boolean {
  return Boolean(
    value &&
    typeof value === 'object' &&
    (value as { id?: unknown }).id === id &&
    (value as { scope?: unknown }).scope === 'source',
  );
}

/**
 * The flights each selected person was assigned to: every record about a flight that names the person, as its related
 * subject or in a reference field, with the record's own time.
 */
export function assignedFlights(
  subjects: readonly RecordSubject[],
  rows: readonly RecordRow[],
): RecordProductionFlight[] {
  const people = subjects.filter((subject) => subject.kind === 'person' && subject.scope === 'source');
  const flights = people.flatMap((person) =>
    rows
      .filter(
        (row) =>
          row.subject_kind === 'flight' &&
          ((row.secondary_subject_kind === 'person' && row.secondary_subject_id === person.id) ||
            Object.values(recordValues(row).record).some((value) => names(value, person.id))),
      )
      .map((row) => ({
        person: person.id,
        flight: row.subject_id,
        start: (row.interval_start ?? row.occurred_at).toISOString(),
        end: row.interval_end?.toISOString() ?? null,
        recordId: row.id,
      })),
  );
  return flights.sort(
    (a, b) =>
      a.person.localeCompare(b.person) ||
      a.start.localeCompare(b.start) ||
      a.flight.localeCompare(b.flight) ||
      a.recordId.localeCompare(b.recordId),
  );
}

/** A file name safe on every common file system, keeping the original's own name where it can. */
function safeName(name: string | null): string {
  const cleaned = (name ?? 'original').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '');
  return cleaned.slice(0, 120) || 'original';
}

const narrowed = (selection: RecordProductionSelection) =>
  selection.recordTypes.length > 0 || selection.from !== null || selection.to !== null;

function statements(sources: ProductionSources, counts: RecordProductionManifest['counts']): string[] {
  const one = counts.originals === 1;
  const listed = `${counted(counts.originals, 'original file')} ${one ? 'is listed with its' : 'are listed with their'} SHA-256`;
  const originals = sources.selection.includeOriginals
    ? `${listed} and included under originals/.`
    : `${listed} and not included; ${one ? 'it was' : 'they were'} not asked for.`;
  const others = counts.originalsWithOtherRecords
    ? [
        `${counted(counts.originalsWithOtherRecords, 'original file')} also ${counts.originalsWithOtherRecords === 1 ? 'holds' : 'hold'} ${counted(counts.otherRecords, 'record')} this file does not, ${narrowed(sources.selection) ? 'about other subjects or outside the selected record types or dates' : 'about other subjects'}${sources.selection.includeOriginals ? '; each original is included whole' : ''}. The table of original files gives the number for each.`,
      ]
    : [];
  const flights = counts.flights
    ? [
        `The records name ${counted(counts.flights, 'flight')} a selected person was assigned to; they are listed under Flights assigned${sources.selection.withFlights ? ', and their records are included' : ', and their own records are not included unless asked for'}.`,
      ]
    : [];
  return [
    `This file holds ${counted(counts.records, 'record')} of ${counted(counts.recordTypes, 'record type')} that ${sources.organization.name} kept in Ledger, chosen as the selection says.`,
    'Each records CSV has the columns of its record type’s import template, then the record’s Ledger id, when and by whom it was recorded, the record that replaced it, and the original file it came from with that file’s SHA-256. Numbers are in the units the record type stores, and beside each number and time a column shows it as it was entered, with its unit or the zone it was read in; a date entered alone is written as that date.',
    `${counts.replaced} of the records ${counts.replaced === 1 ? 'was replaced by a later record; it is included and says which record replaced it' : 'were replaced by a later record; they are included and say which record replaced them'}.`,
    originals,
    ...others,
    ...flights,
    'Safety reports and restricted attachments are never included.',
    'These are the records as the organization kept them. Ledger did not check them against any requirement, and this file does not say that any requirement is met.',
  ];
}

export function assembleRecordProduction(sources: ProductionSources, issue: ProductionIssue): AssembledProduction {
  const groups = groupsOf(sources.rows);
  const files: RecordProductionManifestFile[] = [];
  const entries: ZipEntry[] = [];
  const add = (
    path: string,
    bytes: Uint8Array,
    details: Omit<RecordProductionManifestFile, 'path' | 'byteLength' | 'sha256'>,
  ) => {
    entries.push({ path, bytes });
    files.push({ path, ...details, byteLength: bytes.byteLength, sha256: sha256(bytes) });
  };
  for (const group of groups) {
    if (!group.definition) continue;
    const csv = producedRecordCsv(
      group.definition,
      group.rows.map((row) => producedRow(row, sources)),
    );
    add(producedCsvPath(group.recordType, group.recordVersion), utf8(csv), {
      role: 'records',
      contentType: 'text/csv; charset=utf-8',
      recordType: group.recordType,
      recordVersion: group.recordVersion,
      rows: group.rows.length,
    });
  }
  const originals = sources.originals.map((original) => ({
    ...original,
    path: sources.selection.includeOriginals ? `originals/${original.artifactId}/${safeName(original.filename)}` : null,
  }));
  for (const original of originals)
    if (original.path)
      add(original.path, sources.originalBytes.get(original.artifactId)!, {
        role: 'original',
        contentType: original.contentType,
        artifactId: original.artifactId,
      });
  const counts = {
    records: groups.reduce((total, group) => total + (group.definition ? group.rows.length : 0), 0),
    recordTypes: groups.filter((group) => group.definition).length,
    replaced: sources.rows.filter((row) => row.replaced_by).length,
    originals: originals.length,
    originalsIncluded: originals.filter((original) => original.path).length,
    originalBytes: originals
      .filter((original) => original.path)
      .reduce((total, original) => total + original.byteLength, 0),
    originalsWithOtherRecords: originals.filter((original) => original.otherRecords > 0).length,
    otherRecords: originals.reduce((total, original) => total + original.otherRecords, 0),
    flights: new Set(sources.flights.map((flight) => flight.flight)).size,
  };
  const head = {
    format: RECORD_PRODUCTION_FORMAT,
    productionId: issue.productionId,
    organization: sources.organization,
    producedBy: issue.producedBy,
    producedAt: issue.producedAt,
    reason: issue.reason,
    requestedBy: issue.requestedBy,
    selection: sources.selection,
    journal: sources.journal,
    counts,
    limits: { ...sources.limits },
  } as const;
  const index = utf8(renderIndex(sources, issue, groups, originals, counts, statements(sources, counts)));
  files.push({
    path: 'index.html',
    role: 'index',
    contentType: 'text/html; charset=utf-8',
    byteLength: index.byteLength,
    sha256: sha256(index),
  });
  const manifest: RecordProductionManifest = {
    ...head,
    files: [...files].sort((a, b) => (a.path < b.path ? -1 : 1)),
    originals,
    flights: sources.flights,
    statements: statements(sources, counts),
  };
  const manifestBytes = utf8(`${JSON.stringify(manifest, null, 2)}\n`);
  const archive = writeZip(
    [{ path: 'index.html', bytes: index }, { path: 'manifest.json', bytes: manifestBytes }, ...entries],
    issue.producedAt,
  );
  return { archive, manifest, manifestSha256: sha256(manifestBytes) };
}

// The index ------------------------------------------------------------------------------------------------------------

const escape = (text: string) => text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

function zoned(value: string, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(value))
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function subjectLabel(sources: ProductionSources, kind: string, id: string, scope: string): string {
  if (scope === 'ledger' && kind === 'organization') return `${sources.organization.name} (the organization)`;
  const name = sources.names.get(`${kind} ${id}`);
  return name ? `${name} (${kind} ${id})` : `${kind} ${id}`;
}

function recordTime(row: RecordRow, timeZone: string): string {
  if (row.interval_start)
    return row.interval_end
      ? `${zoned(row.interval_start.toISOString(), timeZone)} to ${zoned(row.interval_end.toISOString(), timeZone)}`
      : `from ${zoned(row.interval_start.toISOString(), timeZone)}`;
  return zoned(row.occurred_at.toISOString(), timeZone);
}

function cellText(definition: OperatorRecordDefinition, name: string, value: unknown, row: RecordRow): string {
  const field = definition.fields.find((candidate) => candidate.name === name);
  if (!field || value === undefined || value === null) return '';
  const entered = enteredOf(row);
  const day = entered.dayOnly?.[name]?.day;
  if (day) return `${day} (date only)`;
  const written = entered.entered?.[name];
  if (written) return `${storedText(field, value)} (entered as ${written})`;
  return storedText(field, value);
}

function storedText(field: OperatorRecordDefinition['fields'][number], value: unknown): string {
  if (field.kind === 'boolean') return value ? 'yes' : 'no';
  if (field.kind === 'reference') return String((value as { id?: unknown }).id ?? '');
  if (field.kind === 'select') return field.options.find((option) => option.value === value)?.label ?? String(value);
  if (field.kind === 'number')
    return `${value} ${field.unit === 'Count' ? '' : field.unit.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()}`.trim();
  return String(value);
}

function flightSection(sources: ProductionSources): string {
  if (!sources.flights.length) return '';
  const zone = sources.organization.timeZone;
  const rows = sources.flights.map((flight) => {
    const time = flight.end
      ? `${zoned(flight.start, zone)} to ${zoned(flight.end, zone)}`
      : `from ${zoned(flight.start, zone)}`;
    return `<tr><td>${escape(subjectLabel(sources, 'person', flight.person, 'source'))}</td><td>${escape(subjectLabel(sources, 'flight', flight.flight, 'source'))}</td><td>${escape(time)} (${escape(zone)})</td><td><code>${escape(flight.recordId)}</code></td></tr>`;
  });
  return `<section>
<h2>Flights assigned</h2>
<table><thead><tr><th>Person</th><th>Flight</th><th>Time the record gives</th><th>Record</th></tr></thead><tbody>${rows.join('\n')}</tbody></table>
</section>`;
}

function selectionText(sources: ProductionSources): string[] {
  const { selection } = sources;
  const zone = sources.organization.timeZone;
  return [
    selection.subjects.length
      ? `Subjects: ${sources.subjects.map((subject) => subjectLabel(sources, subject.kind, subject.id, subject.scope)).join('; ')}.`
      : 'Subjects: every subject.',
    selection.recordTypes.length
      ? `Record types: ${selection.recordTypes
          .map((recordType) => {
            const title = Object.values(observationRegistry().recordTypes).find(
              (definition) => definition.recordType === recordType && 'title' in definition,
            ) as { title?: string } | undefined;
            return title?.title ? `${title.title} (${recordType})` : recordType;
          })
          .join(', ')}.`
      : 'Record types: every type.',
    selection.from || selection.to
      ? `Records about the time ${selection.from ? `from ${zoned(selection.from, zone)}` : ''}${selection.from && selection.to ? ' ' : ''}${selection.to ? `until ${zoned(selection.to, zone)}` : ''} (${zone}).`
      : 'Dates: all.',
    selection.includeOriginals ? 'Original files: included.' : 'Original files: listed, not included.',
    selection.withFlights
      ? 'Flights a selected person was assigned to: listed, and their records included.'
      : 'Flights a selected person was assigned to: listed.',
  ];
}

function renderIndex(
  sources: ProductionSources,
  issue: ProductionIssue,
  groups: readonly RecordGroup[],
  originals: readonly RecordProductionOriginal[],
  counts: RecordProductionManifest['counts'],
  plain: readonly string[],
): string {
  const zone = sources.organization.timeZone;
  const sections = groups
    .filter((group) => group.definition)
    .map((group) => {
      const definition = group.definition!;
      const header = ['Subject', 'Time', ...definition.fields.map((field) => field.label), 'Recorded', 'Status'];
      const body = group.rows.map((row) => {
        const values = recordValues(row).record;
        const status = row.replaced_by
          ? `Replaced by ${row.replaced_by}`
          : row.replaces_observation_id
            ? `Replaces ${row.replaces_observation_id}`
            : 'Current';
        const cells = [
          subjectLabel(sources, row.subject_kind, row.subject_id, row.subject_scope) +
            (row.secondary_subject_kind && row.secondary_subject_id && row.secondary_subject_scope
              ? `; related ${subjectLabel(sources, row.secondary_subject_kind, row.secondary_subject_id, row.secondary_subject_scope)}`
              : ''),
          recordTime(row, zone),
          ...definition.fields.map((field) => cellText(definition, field.name, values[field.name], row)),
          `${zoned(row.received_at.toISOString(), zone)} by ${sources.recordedBy.get(row.principal_id) ?? row.principal_id}`,
          `${status}. Ledger id ${row.id}`,
        ];
        return `<tr>${cells.map((cell) => `<td>${escape(cell)}</td>`).join('')}</tr>`;
      });
      return `<section>
<h2>${escape(definition.title)} <small>(${escape(group.recordType)} version ${group.recordVersion}, ${counted(group.rows.length, 'record')}, ${escape(producedCsvPath(group.recordType, group.recordVersion))})</small></h2>
<table><thead><tr>${header.map((cell) => `<th>${escape(cell)}</th>`).join('')}</tr></thead>
<tbody>${body.join('\n')}</tbody></table>
</section>`;
    });
  const originalRows = originals.map(
    (original) =>
      `<tr><td>${escape(original.filename ?? original.artifactId)}</td><td>${original.records}</td><td>${original.otherRecords}</td><td>${original.byteLength}</td><td><code>${original.sha256}</code></td><td>${escape(original.path ?? 'not included')}</td></tr>`,
  );
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Records of ${escape(sources.organization.name)}</title>
<style>
body{font-family:Georgia,'Times New Roman',serif;margin:2rem;color:#111;background:#fff;line-height:1.4}
h1{font-size:1.5rem;margin:0 0 .5rem}h2{font-size:1.1rem;margin:2rem 0 .5rem;break-after:avoid}
small{font-weight:normal;color:#444}dl{display:grid;grid-template-columns:max-content 1fr;gap:.2rem 1rem}
dt{font-weight:bold}dd{margin:0}table{border-collapse:collapse;width:100%;font-size:.8rem}
th,td{border:1px solid #999;padding:.2rem .35rem;text-align:left;vertical-align:top;overflow-wrap:anywhere}
thead{display:table-header-group}tr{break-inside:avoid}code{font-size:.75rem}
@page{size:landscape;margin:12mm}@media print{body{margin:0}}
</style>
</head>
<body>
<h1>Records of ${escape(sources.organization.name)}</h1>
<dl>
<dt>Produced</dt><dd>${escape(zoned(issue.producedAt, zone))} (${escape(zone)}), ${escape(issue.producedAt)} UTC</dd>
<dt>Produced by</dt><dd>${escape(issue.producedBy.name ?? issue.producedBy.id)}</dd>
<dt>Reason</dt><dd>${escape(issue.reason)}</dd>
<dt>Requested by</dt><dd>${escape(issue.requestedBy)}</dd>
<dt>Selection</dt><dd>${selectionText(sources).map(escape).join('<br>')}</dd>
<dt>Records</dt><dd>${counted(counts.records, 'record')} of ${counted(counts.recordTypes, 'type')}; ${counts.replaced} replaced</dd>
<dt>Production id</dt><dd><code>${escape(issue.productionId)}</code></dd>
</dl>
${plain.map((sentence) => `<p>${escape(sentence)}</p>`).join('\n')}
<p>manifest.json lists every file in this .zip with its SHA-256. To check it, see the verifier described in Ledger’s guide to verifying an export.</p>
${counts.records ? sections.join('\n') : '<p>No records match the selection.</p>'}
${flightSection(sources)}
<section>
<h2>Original files</h2>
${originalRows.length ? `<table><thead><tr><th>File</th><th>Records in this file</th><th>Other records in it</th><th>Bytes</th><th>SHA-256</th><th>In this file</th></tr></thead><tbody>${originalRows.join('\n')}</tbody></table>` : '<p>None.</p>'}
</section>
</body>
</html>
`;
}
