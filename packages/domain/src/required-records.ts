import {
  planBlanks,
  readableQuote,
  RECORDKEEPING_PLAN_DOCUMENT_TYPE,
  type DocumentBodyV2,
  type RecordkeepingPlanDraftResponse,
  type RequiredRecordOnFile,
  type RequiredRecordsResponse,
  type RequiredRecordView,
  type RulePackRequiredRecord,
  type SmsRecordKind,
} from '@ledger/contracts';
import type { PoolClient } from '@ledger/persistence';
import { standingAdoptionRecords } from './adoptions.js';
import { operatorRecordDefinitions, operatorRecordObservationTypes, RECORD_TYPE_SQL } from './operator-record-reads.js';

/**
 * The records the organization's adopted packs say must be kept, with what is on file for each
 * (docs/design/required-records.md). Every word about a requirement is the pack's; this reads counts and times only,
 * and never says a requirement is met. A plain read: it takes no lock.
 */

const safetyRecordTitles: Record<SmsRecordKind, string> = {
  document: 'Controlled documents',
  risk_matrix: 'Risk matrices',
  hazard: 'Hazards',
  control: 'Controls',
  assurance: 'Safety assurance records',
  report: 'Safety reports',
};

interface CountRow {
  key: string;
  current: string;
  replaced: string;
  earliest: Date | null;
  latest: Date | null;
}

const onFileOf = (row: CountRow | undefined): RequiredRecordOnFile => ({
  current: Number(row?.current ?? 0),
  replaced: Number(row?.replaced ?? 0),
  earliest: row?.earliest?.toISOString() ?? null,
  latest: row?.latest?.toISOString() ?? null,
});

/**
 * Operator records of each type, under every source and whether carried in operator.record or recorded as their own
 * observation type, counted with the times they start. An interval's end is not read: for many record types it is a
 * schedule or a validity (an inspection's next due time, a plan's window), not a time a record was made.
 */
async function operatorRecordCounts(client: PoolClient, tenantId: string, types: string[]): Promise<CountRow[]> {
  if (!types.length) return [];
  return (
    await client.query<CountRow>(
      `SELECT key,COUNT(*) FILTER (WHERE current) AS current,COUNT(*) FILTER (WHERE NOT current) AS replaced,
         MIN(span_start) FILTER (WHERE current) AS earliest,MAX(span_start) FILTER (WHERE current) AS latest
       FROM (
         SELECT ${RECORD_TYPE_SQL} AS key,o.span_start,
           NOT EXISTS(SELECT 1 FROM observations r WHERE r.tenant_id=o.tenant_id AND r.replaces_observation_id=o.id)
           AND NOT EXISTS(SELECT 1 FROM observation_withdrawals w WHERE w.tenant_id=o.tenant_id AND w.observation_id=o.id)
             AS current
         FROM observations o
         WHERE o.tenant_id=$1 AND o.observation_type=ANY($2::text[]) AND ${RECORD_TYPE_SQL}=ANY($3::text[])
       ) AS records GROUP BY key`,
      [tenantId, operatorRecordObservationTypes(), types],
    )
  ).rows;
}

/** Ledger's own safety records of each kind: none is removed, so every record is current and earlier versions kept. */
async function safetyRecordCounts(client: PoolClient, tenantId: string, kinds: string[]): Promise<CountRow[]> {
  if (!kinds.length) return [];
  return (
    await client.query<CountRow>(
      `SELECT kind AS key,COUNT(*) AS current,COALESCE(SUM(version_number-1),0) AS replaced,
         MIN(opened_at) AS earliest,MAX(opened_at) AS latest
       FROM sms_records WHERE tenant_id=$1 AND kind=ANY($2::text[]) GROUP BY kind`,
      [tenantId, kinds],
    )
  ).rows;
}

function recordTypeTitle(recordType: string): string {
  const versions = operatorRecordDefinitions().filter((definition) => definition.recordType === recordType);
  return versions.sort((a, b) => b.recordVersion - a.recordVersion)[0]?.title ?? recordType;
}

/** The total over the records that hold one required record. */
function totalOf(parts: RequiredRecordOnFile[]): RequiredRecordOnFile {
  const times = (pick: (part: RequiredRecordOnFile) => string | null) =>
    parts.map(pick).filter((time): time is string => time !== null);
  const earliest = times((part) => part.earliest).sort()[0] ?? null;
  const latest =
    times((part) => part.latest)
      .sort()
      .at(-1) ?? null;
  return {
    current: parts.reduce((sum, part) => sum + part.current, 0),
    replaced: parts.reduce((sum, part) => sum + part.replaced, 0),
    earliest,
    latest,
  };
}

export async function adoptedRequiredRecords(client: PoolClient, tenantId: string): Promise<RequiredRecordsResponse> {
  const organization = (
    await client.query<{ name: string; time_zone: string; now: Date }>(
      'SELECT name,time_zone,clock_timestamp() AS now FROM tenants WHERE id=$1',
      [tenantId],
    )
  ).rows[0];
  const adoptions = await standingAdoptionRecords(client, tenantId, (organization?.now ?? new Date()).toISOString());
  // Each required record once by id, as the highest version adopted declares it, and every version that declares it.
  const declared = new Map<
    string,
    { declaration: RulePackRequiredRecord; declaredBy: RequiredRecordView['declaredBy'] }
  >();
  for (const { pack } of adoptions) {
    for (const declaration of pack.requiredRecords ?? []) {
      const entry = declared.get(declaration.id) ?? { declaration, declaredBy: [] };
      if (!entry.declaredBy.some((item) => item.packId === pack.packId && item.version === pack.version))
        entry.declaredBy.push({ packId: pack.packId, version: pack.version, packTitle: pack.title });
      declared.set(declaration.id, entry);
    }
  }
  const holders = [...declared.values()].flatMap((entry) => entry.declaration.heldBy);
  const recordTypes = [
    ...new Set(holders.flatMap((holder) => (holder.kind === 'operator_record' ? [holder.recordType] : []))),
  ];
  const recordKinds = [
    ...new Set(holders.flatMap((holder) => (holder.kind === 'safety_record' ? [holder.recordKind] : []))),
  ];
  const operatorCounts = new Map(
    (await operatorRecordCounts(client, tenantId, recordTypes)).map((row) => [row.key, row]),
  );
  const safetyCounts = new Map((await safetyRecordCounts(client, tenantId, recordKinds)).map((row) => [row.key, row]));

  const records = [...declared.values()].map(({ declaration, declaredBy }): RequiredRecordView => {
    const heldBy = declaration.heldBy.map((holder) =>
      holder.kind === 'operator_record'
        ? {
            ...holder,
            title: recordTypeTitle(holder.recordType),
            onFile: onFileOf(operatorCounts.get(holder.recordType)),
          }
        : {
            ...holder,
            title: safetyRecordTitles[holder.recordKind],
            onFile: onFileOf(safetyCounts.get(holder.recordKind)),
          },
    );
    return {
      id: declaration.id,
      title: declaration.title,
      keptBy: declaration.keptBy,
      source: { reference: declaration.source.reference, text: declaration.source.text },
      retention: declaration.retention
        ? { reference: declaration.retention.source.reference, text: declaration.retention.source.text }
        : null,
      declaredBy,
      heldBy,
      onFile: totalOf(heldBy.map((holder) => holder.onFile)),
    };
  });
  return {
    asOf: (organization?.now ?? new Date()).toISOString(),
    organization: { name: organization?.name ?? tenantId, timeZone: organization?.time_zone ?? 'UTC' },
    records,
  };
}

// The recordkeeping plan ---------------------------------------------------------------------------------------------

const blank = (what: string) => `[To be filled in: ${what}]`;

/** A day in the organization's time zone, as 2026-11-22. */
function day(time: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(time),
  );
}

/** The quoted words on one line, as a reader of the plan reads them. */
const quoted = (text: string) => `“${readableQuote(text).replace(/\s+/g, ' ').trim()}”`;

function onFileSentence(onFile: RequiredRecordOnFile, timeZone: string): string {
  if (!onFile.current)
    return `none on file${onFile.replaced ? ` (${onFile.replaced} earlier versions replaced by corrections are kept)` : ''}`;
  const span =
    onFile.earliest && onFile.latest
      ? day(onFile.earliest, timeZone) === day(onFile.latest, timeZone)
        ? `, about ${day(onFile.earliest, timeZone)}`
        : `, about ${day(onFile.earliest, timeZone)} to ${day(onFile.latest, timeZone)}`
      : '';
  const corrected = onFile.replaced ? `; ${onFile.replaced} earlier versions replaced by corrections are kept` : '';
  return `${onFile.current} on file${span}${corrected}`;
}

function recordSection(record: RequiredRecordView, number: number, timeZone: string): string[] {
  return [
    `3.${number} ${record.title}`,
    `What the text lists: ${quoted(record.source.text)} (${record.source.reference})`,
    `Who the text says keeps it: ${record.keptBy}`,
    `Held in Ledger as: ${record.heldBy
      .map((holder) => `${holder.title} (${holder.kind === 'operator_record' ? holder.recordType : holder.recordKind})`)
      .join('; ')}`,
    `On file when this draft was made: ${record.heldBy
      .map((holder) => `${holder.title}: ${onFileSentence(holder.onFile, timeZone)}`)
      .join('; ')}`,
    record.retention
      ? `How long the text says it is kept: ${quoted(record.retention.text)} (${record.retention.reference})`
      : 'How long the text says it is kept: the text states no period.',
  ];
}

/** The text of a recordkeeping plan drafted from the required records read now. Neutral words; nothing fictional. */
export function recordkeepingPlanText(read: RequiredRecordsResponse): string {
  const { timeZone, name } = read.organization;
  const packs = [
    ...new Map(
      read.records.flatMap((record) =>
        record.declaredBy.map((pack) => [`${pack.packId}@${pack.version}`, pack] as const),
      ),
    ).values(),
  ];
  return [
    `Recordkeeping plan of ${name}`,
    '',
    '1. What this plan covers',
    `This plan describes how ${name} keeps the records listed below and how it produces them on request. The list was read from Ledger on ${day(read.asOf, timeZone)} (${timeZone}) from the rule packs ${name} has adopted: ${packs.length ? packs.map((pack) => `${pack.packTitle} (${pack.packId} version ${pack.version})`).join('; ') : 'none that lists a required record'}. The paragraphs are quoted from those packs; what each one requires is for the organization to read in the text itself.`,
    '',
    '2. Who is responsible',
    blank('the person or role responsible for keeping these records and producing them on request'),
    '',
    '3. The records',
    ...(read.records.length
      ? read.records.flatMap((record, index) => [...recordSection(record, index + 1, timeZone), ''])
      : ['No adopted rule pack lists a required record.', '']),
    '4. How records are kept',
    'Records are kept in Ledger. Every record, every input and every correction is appended; a correction is a new record that names the one it replaces, and both are kept. No record is changed or removed. Each original uploaded file is kept as it was received, with its SHA-256 digest.',
    '',
    '5. How records are produced on request',
    'Records are produced by subject, record type and dates as one .zip file: a CSV file for each record type with when and by whom each record was recorded and what replaced it, a printable index, a manifest listing every file with its SHA-256 digest, and, when asked, the original files. Each production is itself recorded: who produced it, when, why and who asked. The file is checked offline with the verifier that ships with Ledger (tools/verifier/record-production-cli.mjs) against the manifest digest, which is kept apart from the file.',
    '',
    '6. Where the records are held',
    `Where this Ledger deployment runs: ${blank('where the Ledger deployment that holds these records runs')}`,
    `How it is backed up: ${blank('how the deployment’s database and stored files are backed up, how often, and where the backups are kept')}`,
    '',
    '7. How long',
    `Ledger removes no record. Keeping the deployment and its backups for as long as the periods in section 3 ask is the organization’s. ${name} keeps them for: ${blank('how long the organization undertakes to keep the deployment and its backups')}`,
  ].join('\n');
}

export function recordkeepingPlanDraft(read: RequiredRecordsResponse): RecordkeepingPlanDraftResponse {
  const text = recordkeepingPlanText(read);
  const body: DocumentBodyV2 = {
    origin: 'authored',
    documentType: RECORDKEEPING_PLAN_DOCUMENT_TYPE,
    revisionLabel: '1',
    summary: `How ${read.organization.name} keeps and produces the ${read.records.length} records its adopted rule packs list.`,
    text,
    changeReason: `Drafted in Ledger from the required records read on ${day(read.asOf, read.organization.timeZone)}.`,
  };
  return {
    asOf: read.asOf,
    title: 'Recordkeeping plan',
    body,
    blanks: planBlanks(text),
    requiredRecords: read.records.length,
  };
}
