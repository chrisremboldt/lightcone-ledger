import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import {
  observationSubjectKindValues,
  type Command,
  type CurrentPrincipalResponse,
  type RecordProduction,
  type RecordProductionCreate,
  type RecordkeepingPlanDraftResponse,
} from '@ledger/contracts';
import { adoptionInstant } from './adoption.js';
import { RefusalError, UsageError, type Context, type Output } from './commands.js';
import { plural } from './format.js';

export interface ProduceRequest {
  /** `<kind>:<id>`, or `organization` for the organization itself. */
  subjects: string[];
  types: string[];
  from?: string;
  to?: string;
  originals: boolean;
  /** Include the records of the flights a selected person was assigned to. */
  withFlights?: boolean;
  reason?: string;
  requestedBy?: string;
  /** Where the .zip is written. */
  out?: string;
}

type ProductionSubject = NonNullable<RecordProductionCreate['subjects']>[number];

function subjectOf(text: string): ProductionSubject {
  if (text.trim() === 'organization') return { kind: 'organization' };
  const split = text.indexOf(':');
  const kind = text.slice(0, split).trim();
  const id = text.slice(split + 1).trim();
  if (split < 1 || !id || !(observationSubjectKindValues as readonly string[]).includes(kind))
    throw new UsageError(
      `--subject is <kind>:<your id>, such as person:PIL-1 or aircraft:AC-1, or organization: ${text}. Kinds: ${observationSubjectKindValues.join(', ')}.`,
    );
  return { kind: kind as ProductionSubject['kind'], id };
}

/** Produces records on request as one .zip, saves it, and says the digest to keep apart from it. */
export async function produceRecords(context: Context, request: ProduceRequest): Promise<Output> {
  const { client } = context;
  if (!request.reason?.trim()) throw new UsageError('--reason is required: why the records are produced.');
  if (!request.requestedBy?.trim())
    throw new UsageError('--requested-by is required: who asked for them, in your words.');
  if (!request.out) throw new UsageError('--out is required: the .zip file to write.');
  const who = await client.request<CurrentPrincipalResponse>('/v1/me');
  const zone = who.organization?.timeZone ?? 'UTC';
  const from = request.from ? adoptionInstant(request.from, zone, 'from') : undefined;
  const to = request.to ? adoptionInstant(request.to, zone, 'until') : undefined;
  if (from && to && Date.parse(to.instant) <= Date.parse(from.instant))
    throw new UsageError('--until is after --from.');
  const body: RecordProductionCreate = {
    subjects: request.subjects.map(subjectOf),
    recordTypes: [...request.types],
    ...(from ? { from: from.instant } : {}),
    ...(to ? { to: to.instant } : {}),
    includeOriginals: request.originals,
    ...(request.withFlights ? { withFlights: true } : {}),
    reason: request.reason.trim(),
    requestedBy: request.requestedBy.trim(),
  };
  context.say(`Producing records, recorded as ${who.principal.name} (${who.principal.id}).`);
  const { record } = await client.request<{ record: RecordProduction }>(
    '/v1/record-productions',
    { method: 'POST', body: JSON.stringify(body) },
    randomUUID(),
  );
  const { bytes } = await client.download(`/v1/record-productions/${encodeURIComponent(record.id)}/content`);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (bytes.byteLength !== record.byteLength || digest !== record.archiveSha256)
    throw new RefusalError(
      `The file received for production ${record.id} does not match its recorded length and SHA-256; nothing was written. Download it again.`,
    );
  writeFileSync(request.out, bytes);
  const { counts } = record;
  return {
    data: { production: record, file: request.out },
    lines: [
      `Produced ${plural(counts.records, 'record')} of ${plural(counts.recordTypes, 'record type')} (${counts.replaced} of them replaced by a correction, included and marked), ${counts.originalsIncluded} of ${plural(counts.originals, 'original file')} included.`,
      ...(counts.flights
        ? [
            `The records name ${plural(counts.flights, 'flight')} the person was assigned to, listed in the file${request.withFlights ? ' with their records' : '; --with-flights includes their records'}.`,
          ]
        : []),
      ...(counts.originalsWithOtherRecords
        ? [
            `${plural(counts.originalsWithOtherRecords, 'original file')} also ${counts.originalsWithOtherRecords === 1 ? 'holds' : 'hold'} ${plural(counts.otherRecords, 'record')} this file does not, such as rows about other subjects${request.originals ? '; the originals are included whole, so those rows go with them' : ''}.`,
          ]
        : []),
      `Selection: ${body.subjects!.length ? request.subjects.join(', ') : 'every subject'}; ${request.types.length ? request.types.join(', ') : 'every record type'}; ${from ? `from ${from.words}` : 'from the first record'}${to ? ` until ${to.words}` : ' to the latest'}.`,
      `Production ${record.id}, recorded with the reason and who asked.`,
      `Wrote ${request.out} (${record.byteLength} bytes).`,
      `Manifest SHA-256: ${record.manifestSha256}`,
      'Keep that digest apart from the file. Anyone can check the file offline with:',
      `  node tools/verifier/record-production-cli.mjs ${request.out} --expected-manifest-sha256 ${record.manifestSha256}`,
    ],
  };
}

export interface PlanDraftRequest {
  out?: string;
  open: boolean;
}

/** A recordkeeping plan drafted from the required records; opened as a draft document only when asked. */
export async function draftPlan(context: Context, request: PlanDraftRequest): Promise<Output> {
  const { client } = context;
  const draft = await client.request<RecordkeepingPlanDraftResponse>('/v1/organization/recordkeeping-plan/draft');
  const text = draft.body.text ?? '';
  const blanks = draft.blanks.length
    ? [
        `${plural(draft.blanks.length, 'blank')} only your organization can fill, each written [To be filled in: …]:`,
        ...draft.blanks.map((blank) => `  ${blank}`),
        'Reviewing or issuing the plan is refused while one remains.',
      ]
    : [];
  const written = request.out ? [`Wrote the draft text to ${request.out}.`] : [];
  if (request.out) writeFileSync(request.out, `${text}\n`);
  const shown = request.out ? [] : [text, ''];
  if (!request.open)
    return {
      data: { opened: false, draft },
      lines: [
        ...shown,
        ...written,
        `Drafted from ${plural(draft.requiredRecords, 'required record')}.`,
        ...blanks,
        'Not opened. A person opens it as a draft controlled document with --open, or with Start a recordkeeping plan on the Records screen.',
      ],
    };
  const who = await client.request<CurrentPrincipalResponse>('/v1/me');
  if (who.principal.kind !== undefined && who.principal.kind !== 'human')
    throw new RefusalError(
      `Not opened. A recordkeeping plan is owned by a person, and this credential belongs to ${who.principal.name}, not a person. Open it with a person's credential.`,
    );
  const command = {
    kind: 'sms.record.open',
    record: {
      kind: 'document',
      schema: 'sms.document.2',
      title: draft.title,
      ownerId: who.principal.id,
      body: draft.body,
    },
  } as Command;
  const sent = await client.command(command, randomUUID());
  const id = sent.command.subject?.id;
  if (!id)
    throw new RefusalError('Ledger recorded the command but returned no document id. Look under Safety, Documents.');
  return {
    data: { opened: true, recordId: id, draft },
    lines: [
      ...shown,
      ...written,
      `Opened a draft recordkeeping plan, document ${id}, owned by ${who.principal.name}.`,
      ...blanks,
      'Fill the blanks in Safety, Documents, then review it, have it signed and issue it there.',
    ],
  };
}
