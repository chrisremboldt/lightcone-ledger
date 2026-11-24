import { projectDocumentControl } from '@ledger/domain';
import type {
  DocumentBody,
  SmsConfidentiality,
  SmsDecisionRecord,
  SmsDocumentAcknowledgement,
  SmsDocumentIssue,
  SmsExportScope,
  SmsLink,
  SmsWithheldItem,
} from '@ledger/contracts';

interface PacketVersion {
  eventId: string;
  versionNumber: number;
  schema: string;
  title: string | null;
  body: Record<string, unknown> | null;
  bodyDigest: string;
  ownerId: string;
  dueAt: string | null;
  links: SmsLink[] | null;
  recordedBy: string;
  recordedAt: string;
}
interface PacketRecord {
  id: string;
  kind: string;
  recordClass: string;
  confidentiality: SmsConfidentiality;
  status: string;
  versions: PacketVersion[];
  links?: SmsLink[];
  linkChanges?: { revision: number; added: SmsLink[]; removed: SmsLink[]; recordedBy: string; recordedAt: string }[];
  attachments: {
    id: string;
    label: string;
    confidentiality: SmsConfidentiality;
    sha256: string;
    byteLength: number;
    contentType: string;
    recordedBy: string;
    recordedAt: string;
  }[];
  documentAcknowledgements?: SmsDocumentAcknowledgement[];
}
interface PacketDecision {
  id: string;
  subjectId: string;
  kind: string;
  note: string;
  outcome: Record<string, any>;
  actor: { principalId: string };
  recordedAt: string;
}
interface PacketSignature {
  decisionId: string;
  subjectId: string;
  signerId: string;
  meaning: string;
  intent: string;
  contentDigest: string;
  reauthentication: { method: string };
  signedAt: string;
}
export interface SmsPacketBundle {
  manifest: {
    exportId: string;
    issuedBy: string;
    issuedAt: string;
    scope: SmsExportScope;
    counts: { records: number; decisions: number; signatures: number; attachments: number; withheld: number };
    limitations: string[];
  };
  manifestDigest: string;
  records: PacketRecord[];
  decisions: PacketDecision[];
  signatures: PacketSignature[];
  withheld: SmsWithheldItem[];
  people: { id: string; name: string }[];
}

const KIND_ORDER = ['hazard', 'report', 'assurance', 'risk_matrix', 'document'];
const KIND: Record<string, string> = {
  hazard: 'Hazard',
  report: 'Safety report',
  assurance: 'Safety assurance record',
  risk_matrix: 'Risk matrix',
  document: 'SMS document',
};
const STATUS: Record<string, string> = {
  identified: 'Identified',
  received: 'Received',
  awaiting_acceptance: 'Awaiting risk acceptance',
  accepted: 'Risk accepted',
  needs_reassessment: 'Needs reassessment',
  draft: 'Draft',
  adopted: 'Adopted',
  signed: 'Signed',
  closed: 'Closed',
};
const RECORD_CLASS: Record<string, string> = {
  srm_output: 'Safety risk management output, §5.97(a)',
  safety_assurance_output: 'Safety assurance output, §5.97(b)',
  training_record: 'Training record, §5.97(c)',
  safety_communication: 'Safety communication, §5.97(d)',
  sms_documentation: 'SMS documentation',
};
const CONFIDENTIALITY: Record<SmsConfidentiality, string> = {
  ordinary: 'Ordinary',
  safety_report: 'Safety report',
  restricted_asset_information: 'Restricted asset information',
};
const DECISION: Record<string, string> = {
  'risk.assess': 'Risk assessed',
  'risk.accept': 'Risk accepted',
  'matrix.adopt': 'Matrix adopted',
  'document.adopt': 'Document adopted',
  'document.review': 'Document reviewed',
  'document.issue': 'Document issued',
  'document.distribute': 'Document distributed',
  'document.withdraw': 'Scheduled issue withdrawn',
  'document.periodic-review': 'Periodic review',
  'assurance.sign': 'Safety assurance record signed',
  'action.close': 'Action closed',
  'record.close': 'Closed',
  'record.reopen': 'Reopened',
};
const CONFIRMATION: Record<string, string> = {
  openid_connect: 'Signed in again with the identity provider',
  local_fixture: 'Local test confirmation',
};
const RELATION: Record<string, string> = { cites: 'Cites', affects: 'Affects', derived_from: 'Derived from' };

export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
const humanize = (id: string) => {
  const words = id.replaceAll(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};
const time = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')} UTC`;
const day = (iso: string) => iso.slice(0, 10);
const sourceDate = (value: string) => (value.length === 10 ? value : time(value));
const count = (value: number, noun: string) => `${value} ${noun}${value === 1 ? '' : 's'}`;
const mono = (value: string) => `<code>${escapeHtml(value)}</code>`;
const field = (label: string, value: string) => `<dt>${escapeHtml(label)}</dt><dd>${value}</dd>`;
const text = (value: unknown) => `<p class="text">${escapeHtml(value)}</p>`;
const bytes = (count: number) =>
  count < 1024
    ? `${count} B`
    : count < 1048576
      ? `${(count / 1024).toFixed(1)} KB`
      : `${(count / 1048576).toFixed(1)} MB`;

function currentVersion(record: PacketRecord): PacketVersion {
  return record.versions.reduce((latest, version) => (version.versionNumber > latest.versionNumber ? version : latest));
}
function recordTitle(record: PacketRecord): string {
  return currentVersion(record).title ?? `${KIND[record.kind] ?? humanize(record.kind)} (content withheld)`;
}

function hazardBody(body: Record<string, any>): string {
  return [
    field('Description', text(body.description)),
    field('Worst credible consequence', text(body.consequence)),
    body.operation ? field('Operation', escapeHtml(body.operation)) : '',
    field(
      'Source',
      escapeHtml(humanize(String(body.source?.kind ?? 'unknown'))) +
        (body.source?.reference ? `, ${escapeHtml(body.source.reference)}` : ''),
    ),
  ].join('');
}
function documentBody(body: DocumentBody): string {
  return [
    field('Document type', escapeHtml(humanize(String(body.documentType)))),
    body.revisionLabel ? field('Revision', escapeHtml(body.revisionLabel)) : '',
    body.documentNumber ? field('Document number', escapeHtml(body.documentNumber)) : '',
    body.origin
      ? field('Origin', body.origin === 'received' ? 'Received document' : 'Authored in the organization')
      : '',
    body.source
      ? field(
          'Source',
          text(
            `${body.source.organization} · ${body.source.reference ?? ''} · revision ${body.source.revision}; received ${time(body.source.receivedAt)}${body.source.issuedAt ? `; issued ${sourceDate(body.source.issuedAt)}` : ''}`,
          ),
        )
      : '',
    body.changeReason ? field('Reason for this revision', text(body.changeReason)) : '',
    body.reviewDueAt ? field('Review due', escapeHtml(time(body.reviewDueAt))) : '',
    field('Summary', text(body.summary)),
    body.text ? field('Text', text(body.text)) : '',
  ].join('');
}
function matrixBody(body: Record<string, any>): string {
  const severities: { id: string; label: string }[] = body.severities ?? [];
  const likelihoods: { id: string; label: string }[] = body.likelihoods ?? [];
  const levels = new Map<string, { label: string; acceptance: string }>(
    (body.levels ?? []).map((level: { id: string; label: string; acceptance: string }) => [level.id, level]),
  );
  const cell = (severity: string, likelihood: string) => {
    const level = (body.cells ?? []).find(
      (entry: { severity: string; likelihood: string }) =>
        entry.severity === severity && entry.likelihood === likelihood,
    )?.level;
    const found = levels.get(level);
    return `<td class="level-${escapeHtml(found?.acceptance ?? 'unknown')}">${escapeHtml(found?.label ?? level ?? '')}</td>`;
  };
  const rows = [...severities]
    .reverse()
    .map(
      (severity) =>
        `<tr><th scope="row">${escapeHtml(severity.label)}</th>${likelihoods.map((likelihood) => cell(severity.id, likelihood.id)).join('')}</tr>`,
    );
  const acceptance: Record<string, string> = {
    low: 'a person who may accept low risk',
    medium: 'a person who may accept medium risk',
    high: 'a person who may accept high risk',
    not_acceptable: 'nobody',
  };
  return [
    field('Name', escapeHtml(body.name)),
    field(
      'Levels',
      [...levels.values()]
        .map(
          (level) =>
            `${escapeHtml(level.label)}: accepted by ${escapeHtml(acceptance[level.acceptance] ?? level.acceptance)}`,
        )
        .join('<br>'),
    ),
    field(
      'Cells',
      `<table class="matrix"><thead><tr><th>Severity / likelihood</th>${likelihoods
        .map((likelihood) => `<th scope="col">${escapeHtml(likelihood.label)}</th>`)
        .join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`,
    ),
  ].join('');
}
function genericBody(body: Record<string, unknown>): string {
  return Object.entries(body)
    .map(([key, value]) =>
      field(humanize(key), typeof value === 'string' ? text(value) : mono(JSON.stringify(value, null, 2))),
    )
    .join('');
}
function bodyFields(kind: string, body: Record<string, unknown>): string {
  if (kind === 'hazard') return hazardBody(body);
  if (kind === 'document') return documentBody(body as unknown as DocumentBody);
  if (kind === 'risk_matrix') return matrixBody(body);
  return genericBody(body);
}

function position(value: { severity: string; likelihood: string; level: string } | undefined): string {
  if (!value) return 'not recorded';
  return `${humanize(value.level)} (${humanize(value.severity)}, ${humanize(value.likelihood)})`;
}
function decisionSummary(decision: PacketDecision): string {
  const outcome = decision.outcome ?? {};
  if (decision.kind === 'risk.assess') {
    const controls = (outcome.controls ?? []) as { type: string; description: string }[];
    return [
      `Initial risk ${position(outcome.initial)}.`,
      `Predicted residual risk ${position(outcome.residual)}.`,
      controls.length
        ? `Controls: ${controls.map((control) => `${humanize(control.type)}: ${control.description}`).join('; ')}.`
        : 'No controls proposed.',
    ].join(' ');
  }
  if (decision.kind === 'risk.accept') return `Accepted ${humanize(String(outcome.level))} residual risk.`;
  if (decision.kind === 'matrix.adopt') return `Adopted version ${outcome.matrix?.versionNumber}.`;
  if (decision.kind === 'document.adopt') return `Adopted version ${outcome.document?.versionNumber}.`;
  if (decision.kind === 'document.review')
    return `Reviewed version ${outcome.document?.versionNumber} with ${count(outcome.attachments?.length ?? 0, 'file')}.`;
  if (decision.kind === 'document.issue')
    return `Issued version ${outcome.document?.versionNumber}, effective ${time(outcome.effectiveFrom)}${outcome.effectiveUntil ? ` until ${time(outcome.effectiveUntil)}` : ''}. Recipients: ${(outcome.recipients ?? []).map((person: { name: string }) => person.name).join(', ') || 'none'}.${outcome.acknowledgementDueAt ? ` Acknowledgement due ${time(outcome.acknowledgementDueAt)}.` : ''}`;
  if (decision.kind === 'document.distribute')
    return `Assigned this exact issue to ${(outcome.recipients ?? []).map((person: { name: string }) => person.name).join(', ')}.`;
  if (decision.kind === 'document.withdraw') return 'Withdrew the scheduled issue before it took effect.';
  if (decision.kind === 'assurance.sign') return `Signed version ${outcome.assurance?.versionNumber}.`;
  if (decision.kind === 'action.close')
    return `Closed action ${outcome.actionId}, set by version ${outcome.setIn?.versionNumber}: ${outcome.action?.what}`;
  if (decision.kind === 'document.periodic-review')
    return `Confirmed version ${outcome.versionNumber} in force remains current. Next review due ${time(outcome.nextReviewDueAt)}.`;
  return `${STATUS[outcome.priorStatus] ?? humanize(String(outcome.priorStatus))} to ${STATUS[outcome.status] ?? humanize(String(outcome.status))}.`;
}

function scopeLine(scope: SmsExportScope, titles: Map<string, string>): string {
  if (scope.kind === 'period')
    return `Records with activity from ${escapeHtml(time(scope.from))} up to ${escapeHtml(time(scope.to))}, and the records they depend on`;
  return `${escapeHtml(titles.get(scope.recordId) ?? scope.recordId)} and the records it depends on`;
}

function readerTable(issue: SmsDocumentIssue, receipts: SmsDocumentAcknowledgement[]): string {
  if (!issue.recipients.length) return '<p>No readers were assigned this issue.</p>';
  const statement = receipts.find((receipt) => receipt.issueId === issue.id)?.statement;
  const rows = issue.recipients
    .map(
      (person) =>
        `<tr><td>${escapeHtml(person.name)}</td><td class="nowrap">${escapeHtml(time(person.assignedAt))}</td><td class="nowrap">${person.dueAt ? escapeHtml(time(person.dueAt)) : 'No deadline'}</td><td class="nowrap">${person.acknowledgedAt ? escapeHtml(time(person.acknowledgedAt)) : 'Not acknowledged'}</td></tr>`,
    )
    .join('');
  return `<h4>Readers</h4>${statement ? `<p>Each acknowledgement records: “${escapeHtml(statement)}”</p>` : ''}
  <table><thead><tr><th>Reader</th><th>Assigned</th><th>Due</th><th>Acknowledged</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function controlledDocumentContent(record: PacketRecord, bundle: SmsPacketBundle, decisions: PacketDecision[]): string {
  const latest = currentVersion(record);
  const control = projectDocumentControl(
    { id: record.id, version_number: latest.versionNumber, status: record.status },
    record.versions.map((version) => ({ ...version, title: version.title ?? 'Document' })),
    decisions as unknown as SmsDecisionRecord[],
    record.documentAcknowledgements ?? [],
    bundle.manifest.issuedAt,
  );
  const issued = control.issues
    .map((issue) => {
      const version = record.versions.find((entry) => entry.versionNumber === issue.versionNumber)!;
      const files = record.attachments.filter((file) => issue.attachmentIds.includes(file.id));
      const state = issue.status === 'current' ? 'In force' : humanize(issue.status);
      return `<section class="issued-document"><h3>${escapeHtml(state)} · ${escapeHtml(issue.revisionLabel ?? `Version ${issue.versionNumber}`)}</h3>
      <p>Effective ${escapeHtml(time(issue.effectiveFrom))}${issue.effectiveUntil ? ` until ${escapeHtml(time(issue.effectiveUntil))}` : ''}.</p>
      <dl class="fields">${bodyFields('document', version.body!)}</dl>
      <p>Files in this issue: ${files.map((file) => `${escapeHtml(file.label)} (${mono(file.sha256)})`).join('; ') || 'Text only'}.</p>
      ${readerTable(issue, control.acknowledgements)}
      </section>`;
    })
    .join('');
  const working = control.issues.some((issue) => issue.versionNumber === latest.versionNumber)
    ? ''
    : `<h3>Working version ${latest.versionNumber} · not issued</h3><dl class="fields">${bodyFields('document', latest.body!)}</dl>`;
  return `${issued || '<p>No revision has been issued through document control.</p>'}${working}`;
}

function recordSection(
  record: PacketRecord,
  bundle: SmsPacketBundle,
  name: (id: string) => string,
  titles: Map<string, string>,
): string {
  const current = currentVersion(record);
  const withheldBody = current.body === null;
  const decisions = bundle.decisions
    .filter((decision) => decision.subjectId === record.id)
    .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
  const signatures = bundle.signatures.filter((signature) => signature.subjectId === record.id);
  const links = record.links ?? current.links ?? [];
  const linkText = (link: SmsLink) =>
    `${escapeHtml(RELATION[link.relation] ?? link.relation)}: ${
      link.target.kind === 'sms_record'
        ? `<a href="#record-${escapeHtml(link.target.id)}">${escapeHtml(titles.get(link.target.id) ?? link.target.id)}</a>`
        : link.target.kind === 'external'
          ? escapeHtml(link.target.label) + (link.target.reference ? ` (${escapeHtml(link.target.reference)})` : '')
          : `${link.target.kind === 'flight' ? 'Flight' : 'Finding'} ${escapeHtml(link.target.id)}`
    }`;
  const meta = [
    field('Kind', escapeHtml(KIND[record.kind] ?? humanize(record.kind))),
    field(
      record.kind === 'document' ? 'Working revision status' : 'Status',
      escapeHtml(STATUS[record.status] ?? humanize(record.status)),
    ),
    field('Record class', escapeHtml(RECORD_CLASS[record.recordClass] ?? humanize(record.recordClass))),
    field('Confidentiality', escapeHtml(CONFIDENTIALITY[record.confidentiality])),
    field('Owner', escapeHtml(name(current.ownerId))),
    field('Due', current.dueAt ? escapeHtml(day(current.dueAt)) : 'None'),
    field(
      record.kind === 'document' ? 'Latest working version' : 'Current version',
      `${current.versionNumber}, recorded ${escapeHtml(time(current.recordedAt))}`,
    ),
  ].join('');
  const content = withheldBody
    ? `<p class="withheld">Content withheld. ${escapeHtml(CONFIDENTIALITY[record.confidentiality])} content is not included in ordinary exports. Its digest is ${mono(current.bodyDigest)}.</p>`
    : record.kind === 'document'
      ? controlledDocumentContent(record, bundle, decisions)
      : `<dl class="fields">${bodyFields(record.kind, current.body!)}</dl>`;
  const linkList = links.length
    ? `<h3>Links</h3><ul>${links.map((link) => `<li>${linkText(link)}</li>`).join('')}</ul>`
    : '';
  const changes = [...(record.linkChanges ?? [])].sort((a, b) => b.revision - a.revision);
  const linkChangeTable = changes.length
    ? `<h3>Link changes</h3><table><thead><tr><th>When</th><th>By</th><th>Change</th></tr></thead><tbody>${changes
        .map(
          (change) =>
            `<tr><td class="nowrap">${escapeHtml(time(change.recordedAt))}</td><td>${escapeHtml(name(change.recordedBy))}</td><td>${[
              ...change.added.map((link) => `Added ${linkText(link)}`),
              ...change.removed.map((link) => `Removed ${linkText(link)}`),
            ].join('<br>')}</td></tr>`,
        )
        .join('')}</tbody></table>`
    : '';
  const decisionTable = decisions.length
    ? `<h3>Decisions</h3><table><thead><tr><th>When</th><th>Decision</th><th>By</th><th>Outcome</th><th>Note</th></tr></thead><tbody>${decisions
        .map(
          (decision) =>
            `<tr><td class="nowrap">${escapeHtml(time(decision.recordedAt))}</td><td>${escapeHtml(DECISION[decision.kind] ?? decision.kind)}</td><td>${escapeHtml(name(decision.actor?.principalId))}</td><td>${escapeHtml(decisionSummary(decision))}</td><td>${escapeHtml(decision.note)}</td></tr>`,
        )
        .join('')}</tbody></table>`
    : '';
  const signatureList = signatures.length
    ? `<h3>Signatures</h3>${signatures
        .map(
          (signature) =>
            `<div class="signature"><blockquote>${escapeHtml(signature.intent)}</blockquote><p>${escapeHtml(name(signature.signerId))}, ${escapeHtml(time(signature.signedAt))}. ${escapeHtml(CONFIRMATION[signature.reauthentication?.method] ?? 'Confirmation recorded')}.</p><p class="digest">Signed content ${mono(signature.contentDigest)}</p></div>`,
        )
        .join('')}`
    : '';
  const versionTable = `<h3>Versions</h3><table><thead><tr><th>Version</th><th>Recorded</th><th>By</th><th>Content digest</th></tr></thead><tbody>${[
    ...record.versions,
  ]
    .sort((a, b) => b.versionNumber - a.versionNumber)
    .map(
      (version) =>
        `<tr><td>${version.versionNumber}</td><td class="nowrap">${escapeHtml(time(version.recordedAt))}</td><td>${escapeHtml(name(version.recordedBy))}</td><td>${mono(version.bodyDigest)}</td></tr>`,
    )
    .join('')}</tbody></table>`;
  const attachmentTable = record.attachments.length
    ? `<h3>Files</h3><table><thead><tr><th>File</th><th>Size</th><th>In this export</th><th>SHA-256</th></tr></thead><tbody>${record.attachments
        .map(
          (attachment) =>
            `<tr><td>${escapeHtml(attachment.label)}</td><td class="nowrap">${escapeHtml(bytes(attachment.byteLength))}</td><td>${
              attachment.confidentiality === 'ordinary'
                ? 'Included'
                : `Withheld: ${escapeHtml(CONFIDENTIALITY[attachment.confidentiality])}`
            }</td><td>${mono(attachment.sha256)}</td></tr>`,
        )
        .join('')}</tbody></table>`
    : '';
  return `<section class="record" id="record-${escapeHtml(record.id)}"><h2>${escapeHtml(recordTitle(record))}</h2><dl class="meta">${meta}</dl>${content}${linkList}${linkChangeTable}${decisionTable}${signatureList}${versionTable}${attachmentTable}</section>`;
}

const STYLE = `
:root{--paper:#0d0d0d;--sheet:#141414;--line:#2e2e38;--ink:#f9fafb;--ink-2:#c6c6c6;--muted:#8d8d8d;--plan:#0096e0;
--magenta:#e2008c;--amber:#ff600a;--alert:#e0002a;--advisory:#ffe11f;
--sans:'Open Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;
--mono:'Roboto Mono',ui-monospace,'SF Mono',Menlo,Consolas,monospace}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:13px/1.5 var(--sans)}
main{max-width:960px;margin:0 auto;padding:32px 24px 64px}
h1{font-size:22px;font-weight:600;margin:0 0 4px}
h2{font-size:17px;font-weight:600;margin:0 0 12px}
h3{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:20px 0 8px}
a{color:var(--plan)}
code{font:11.5px/1.4 var(--mono);color:var(--ink-2);word-break:break-all}
.lede{color:var(--ink-2);margin:0 0 20px}
.notice{border-left:3px solid var(--plan);padding:8px 12px;background:var(--sheet);margin:16px 0}
.record{border-top:1px solid var(--line);padding:24px 0}
dl{display:grid;grid-template-columns:180px 1fr;gap:4px 16px;margin:0}
dt{color:var(--muted)}dd{margin:0}
.fields{margin-top:12px}
.text{margin:0;white-space:pre-wrap}
.withheld{border-left:3px solid var(--amber);padding:8px 12px;background:var(--sheet)}
table{width:100%;border-collapse:collapse;margin:4px 0}
th,td{text-align:left;vertical-align:top;padding:6px 8px;border-bottom:1px solid var(--line)}
th{font-weight:600;color:var(--ink-2)}
.nowrap{white-space:nowrap}
.matrix td{text-align:center}
.level-low{color:var(--plan)}.level-medium{color:var(--advisory)}.level-high,.level-not_acceptable{color:var(--alert)}
.signature{border-left:3px solid var(--magenta);padding:4px 12px;margin:8px 0}
blockquote{margin:0 0 4px;font-style:italic}
.signature p{margin:0}.digest{color:var(--muted)}
ol.toc{columns:2;padding-left:20px}
@media print{
:root{--paper:#fff;--sheet:#f4f4f4;--line:#d0d0d0;--ink:#111;--ink-2:#333;--muted:#555}
main{max-width:none;padding:0}.record{break-inside:avoid-page}a{color:inherit}}
`;

/** A reading copy of one SMS export bundle; every fact on it comes from the bundle it was rendered from. */
export function renderSmsPacket(bundle: SmsPacketBundle, organization: string): string {
  const people = new Map(bundle.people.map((person) => [person.id, person.name]));
  const name = (id: string) => people.get(id) ?? id;
  const titles = new Map(bundle.records.map((record) => [record.id, recordTitle(record)]));
  const ordered = [...bundle.records].sort(
    (a, b) =>
      (KIND_ORDER.indexOf(a.kind) + 1 || 99) - (KIND_ORDER.indexOf(b.kind) + 1 || 99) ||
      titles.get(a.id)!.localeCompare(titles.get(b.id)!),
  );
  const { manifest } = bundle;
  const counts = manifest.counts;
  const withheld = bundle.withheld.length
    ? `<h3>Withheld items</h3><table><thead><tr><th>Item</th><th>Record</th><th>Class</th><th>Digest</th></tr></thead><tbody>${bundle.withheld
        .map(
          (item) =>
            `<tr><td>${item.kind === 'record_body' ? 'Record content' : 'File'}</td><td>${escapeHtml(titles.get(item.recordId) ?? item.recordId)}</td><td>${escapeHtml(CONFIDENTIALITY[item.confidentiality])}</td><td>${mono(item.sha256)}</td></tr>`,
        )
        .join('')}</tbody></table>`
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SMS records packet, ${escapeHtml(organization)}</title><style>${STYLE}</style></head><body><main>
<h1>SMS records packet</h1>
<p class="lede">${escapeHtml(organization)}. ${scopeLine(manifest.scope, titles)}.</p>
<dl class="meta">
${field('Issued', `${escapeHtml(time(manifest.issuedAt))} by ${escapeHtml(name(manifest.issuedBy))}`)}
${field('Contents', `${count(counts.records, 'record')}, ${count(counts.decisions, 'decision')}, ${count(counts.signatures, 'signature')}, ${count(counts.attachments, 'file')} included, ${count(counts.withheld, 'item')} withheld`)}
${field('Export', mono(`ledger-sms-export-${manifest.exportId}.json`))}
${field('Manifest digest', mono(bundle.manifestDigest))}
</dl>
<p class="notice">This page is a reading copy of the export file named above. The export file is the record. Check it offline with the Ledger verifier and the manifest digest above.</p>
<h3>Records</h3><ol class="toc">${ordered
    .map(
      (record) =>
        `<li><a href="#record-${escapeHtml(record.id)}">${escapeHtml(titles.get(record.id)!)}</a> <span class="digest">${escapeHtml(KIND[record.kind] ?? humanize(record.kind))}, ${escapeHtml(STATUS[record.status] ?? humanize(record.status))}</span></li>`,
    )
    .join('')}</ol>
${ordered.map((record) => recordSection(record, bundle, name, titles)).join('\n')}
<section class="record">${withheld}<h3>Limitations</h3><ul>${manifest.limitations
    .map((limitation) => `<li>${escapeHtml(limitation)}</li>`)
    .join('')}</ul></section>
</main></body></html>`;
}
