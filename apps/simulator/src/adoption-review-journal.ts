import { createHash } from 'node:crypto';
import type { SubjectExportRecord } from '@ledger/contracts';
import { lockPrivateJournal, readJournalEnvelope, writeJournalEnvelope } from './private-journal.js';

export interface ReviewAction {
  key: string;
  payload: string;
  payloadSha256: string;
  status: 'submitted' | 'accepted' | 'rejected';
  decisionId?: string;
  rejection?: { status: number; code: string };
}

export interface ReviewJournal {
  version: 1;
  kind: 'adoption-review';
  planDigest: string;
  principalId: string;
  tenantId: string;
  endpoint: '/v1/commands';
  actions: ReviewAction[];
  export?: {
    endpoint: '/v1/subject-exports';
    key: string;
    payload: string;
    payloadSha256: string;
    status: 'submitted' | 'accepted' | 'rejected';
    record?: SubjectExportRecord;
    rejection?: { status: number; code: string };
  };
}

const maxJournalBytes = 1024 * 1024;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const invalid = (): never => {
  throw new Error('Adoption review journal commitment is invalid; refusing to reset the action');
};
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
};
const keys = (value: Record<string, unknown>, required: string[], optional: string[] = []): void => {
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))
  )
    invalid();
};
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200;
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function commitment(action: Record<string, unknown>): void {
  if (
    !id(action.key) ||
    typeof action.payload !== 'string' ||
    !digest(action.payloadSha256) ||
    hash(action.payload) !== action.payloadSha256 ||
    typeof action.status !== 'string' ||
    !['submitted', 'accepted', 'rejected'].includes(action.status)
  )
    invalid();
  if (action.rejection !== undefined) {
    const rejection = object(action.rejection);
    keys(rejection, ['status', 'code']);
    if (
      !Number.isSafeInteger(rejection.status) ||
      Number(rejection.status) < 400 ||
      Number(rejection.status) > 599 ||
      !id(rejection.code)
    )
      invalid();
  }
}

function exportRecord(value: unknown): void {
  const record = object(value);
  keys(record, [
    'id',
    'tenantId',
    'format',
    'subject',
    'decisionId',
    'issuedBy',
    'issuedAt',
    'scope',
    'byteLength',
    'bundleSha256',
    'manifestDigest',
    'snapshotDigest',
    'anchorStatus',
    'interpretation',
    'counts',
    'limits',
    'cuts',
    'interpretations',
    'addedAcceptedEventIds',
    'limitations',
  ]);
  const subject = object(record.subject);
  keys(subject, ['kind', 'id']);
  if (
    !['id', 'tenantId', 'decisionId', 'issuedBy'].every((field) => id(record[field])) ||
    record.format !== 'ledger.subject-evidence.2' ||
    subject.kind !== 'organization' ||
    !id(subject.id) ||
    record.scope !== 'whole_tenant_prefixes' ||
    typeof record.issuedAt !== 'string' ||
    !Number.isFinite(Date.parse(record.issuedAt)) ||
    !Number.isSafeInteger(record.byteLength) ||
    Number(record.byteLength) < 0 ||
    !['bundleSha256', 'manifestDigest', 'snapshotDigest'].every((field) => digest(record[field])) ||
    record.anchorStatus !== 'not_externally_anchored' ||
    record.interpretation !== 'evidence-cut.1' ||
    !Array.isArray(record.addedAcceptedEventIds) ||
    !record.addedAcceptedEventIds.every(id) ||
    !Array.isArray(record.limitations) ||
    !record.limitations.every((entry) => typeof entry === 'string')
  )
    invalid();
  for (const [field, fields] of [
    ['counts', ['events', 'streams', 'receipts', 'artifacts', 'artifactBytes', 'ruleSources', 'ruleSourceBytes']],
    [
      'limits',
      [
        'maxEvents',
        'maxStreams',
        'maxArtifacts',
        'maxArtifactBytes',
        'maxBundleBytes',
        'maxRuleSources',
        'maxRuleSourceBytes',
      ],
    ],
  ] as const) {
    const values = object(record[field]);
    keys(values, [...fields]);
    if (Object.values(values).some((entry) => !Number.isSafeInteger(entry) || Number(entry) < 0)) invalid();
  }
  const cuts = object(record.cuts);
  const interpretations = object(record.interpretations);
  keys(cuts, ['rendered', 'accepted', 'issuance']);
  keys(interpretations, ['rendered', 'accepted', 'issuance']);
  for (const name of ['rendered', 'accepted', 'issuance']) {
    const cut = object(cuts[name]);
    keys(cut, ['streams'], ['basisRevision', 'principalRevision']);
    const streams = object(cut.streams);
    if (
      Object.values(streams).some((entry) => !Number.isSafeInteger(entry) || Number(entry) < 0) ||
      ['basisRevision', 'principalRevision'].some(
        (field) => cut[field] !== undefined && (!Number.isSafeInteger(cut[field]) || Number(cut[field]) < 0),
      )
    )
      invalid();
    const summary = object(interpretations[name]);
    keys(summary, ['eventCount', 'digest', 'causalClosure', 'missingCausationIds']);
    if (
      !Number.isSafeInteger(summary.eventCount) ||
      Number(summary.eventCount) < 0 ||
      !digest(summary.digest) ||
      typeof summary.causalClosure !== 'string' ||
      !['closed', 'incomplete'].includes(summary.causalClosure) ||
      !Array.isArray(summary.missingCausationIds) ||
      !summary.missingCausationIds.every((entry) => typeof entry === 'string')
    )
      invalid();
  }
}

function validateJournal(value: unknown): ReviewJournal {
  const journal = object(value);
  keys(journal, ['version', 'kind', 'planDigest', 'principalId', 'tenantId', 'endpoint', 'actions'], ['export']);
  if (
    journal.version !== 1 ||
    journal.kind !== 'adoption-review' ||
    !digest(journal.planDigest) ||
    !id(journal.principalId) ||
    !id(journal.tenantId) ||
    journal.endpoint !== '/v1/commands' ||
    !Array.isArray(journal.actions) ||
    journal.actions.length > 16
  )
    return invalid();
  const actionKeys = new Set<string>();
  for (const entry of journal.actions) {
    const action = object(entry);
    keys(action, ['key', 'payload', 'payloadSha256', 'status'], ['decisionId', 'rejection']);
    commitment(action);
    if (actionKeys.has(String(action.key)) || (action.decisionId !== undefined && !id(action.decisionId)))
      return invalid();
    actionKeys.add(String(action.key));
    const payload = object(JSON.parse(String(action.payload)));
    keys(payload, [
      'kind',
      'subject',
      'expectedRevision',
      'inputCut',
      'expectedDependencyBasis',
      'adoption',
      'decision',
    ]);
    const subject = object(payload.subject);
    const decision = object(payload.decision);
    keys(subject, ['kind']);
    keys(decision, ['kind', 'note']);
    if (payload.kind !== 'decision.record' || subject.kind !== 'organization' || decision.kind !== 'adoption.review')
      return invalid();
  }
  if (journal.export !== undefined) {
    const action = object(journal.export);
    keys(action, ['endpoint', 'key', 'payload', 'payloadSha256', 'status'], ['record', 'rejection']);
    commitment(action);
    if (action.endpoint !== '/v1/subject-exports' || actionKeys.has(String(action.key))) return invalid();
    const payload = object(JSON.parse(String(action.payload)));
    keys(payload, ['subject', 'decisionId', 'scope']);
    const subject = object(payload.subject);
    keys(subject, ['kind']);
    if (subject.kind !== 'organization' || !id(payload.decisionId) || payload.scope !== 'whole_tenant_prefixes')
      return invalid();
    if (action.record !== undefined) exportRecord(action.record);
  }
  return journal as unknown as ReviewJournal;
}

export async function readReviewJournal(path: string): Promise<ReviewJournal | undefined> {
  try {
    const value = await readJournalEnvelope(path, maxJournalBytes);
    return value === undefined ? undefined : validateJournal(value);
  } catch {
    return invalid();
  }
}

export async function saveReviewJournal(path: string, journal: ReviewJournal): Promise<void> {
  validateJournal(journal);
  await writeJournalEnvelope(path, journal, maxJournalBytes);
}

export async function lockReviewJournal(path: string): Promise<() => Promise<void>> {
  return lockPrivateJournal(path, 'Adoption review');
}
