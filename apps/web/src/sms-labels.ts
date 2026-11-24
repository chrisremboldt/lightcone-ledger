import type { Tone } from '@ledger/ui';
import type {
  DocumentType,
  RiskAcceptance,
  RiskAuthority,
  RiskMatrixBody,
  SmsConfidentiality,
  SmsLink,
  SmsRecordClass,
  SmsRecordKind,
  SmsRecordSummary,
} from '@ledger/contracts';
import { timeZone } from './format.js';

const statuses: Record<string, { label: string; tone: Tone }> = {
  identified: { label: 'Needs assessment', tone: 'attention' },
  awaiting_acceptance: { label: 'Awaiting risk acceptance', tone: 'advisory' },
  needs_reassessment: { label: 'Needs reassessment', tone: 'attention' },
  accepted: { label: 'Risk accepted', tone: 'planned' },
  draft: { label: 'Draft, not adopted', tone: 'attention' },
  adopted: { label: 'Adopted', tone: 'planned' },
  signed: { label: 'Signed', tone: 'planned' },
  reviewed: { label: 'Reviewed, awaiting signature', tone: 'advisory' },
  issued: { label: 'Issued', tone: 'planned' },
  received: { label: 'Received', tone: 'neutral' },
  proposed: { label: 'Proposed', tone: 'advisory' },
  closed: { label: 'Closed', tone: 'neutral' },
};

export function statusPresentation(status: string): { label: string; tone: Tone } {
  return statuses[status] ?? { label: status.replaceAll('_', ' '), tone: 'neutral' };
}

const acceptanceTones: Record<RiskAcceptance, Tone> = {
  low: 'neutral',
  medium: 'advisory',
  high: 'alert',
  not_acceptable: 'alert',
};
/** A level's tone, from who may accept it, since an organization names its own levels. */
export function levelTone(acceptance: RiskAcceptance): Tone {
  return acceptanceTones[acceptance] ?? 'neutral';
}
/** A level by the matrix's own label, or by its id when no matrix is at hand. */
export function levelName(level: string, matrix?: Pick<RiskMatrixBody, 'levels'> | null): string {
  const label = matrix?.levels.find((entry) => entry.id === level)?.label;
  if (label) return label;
  const words = level.replaceAll('_', ' ');
  return words[0]!.toUpperCase() + words.slice(1);
}

export const acceptanceLabels: Record<RiskAcceptance, string> = {
  low: 'A person who may accept low risk',
  medium: 'A person who may accept medium risk',
  high: 'A person who may accept high risk',
  not_acceptable: 'Nobody may accept',
};

export const recordClassLabels: Record<SmsRecordClass, string> = {
  srm_output: 'Safety risk management output · kept while its controls remain relevant (§5.97(a))',
  safety_assurance_output: 'Safety assurance output · kept at least 5 years (§5.97(b))',
  training_record: 'Training record · kept while the person is employed (§5.97(c))',
  safety_communication: 'Safety communication · kept at least 24 months (§5.97(d))',
  sms_documentation: 'SMS documentation · every revision kept',
};

export const confidentialityLabels: Record<SmsConfidentiality, string> = {
  ordinary: 'Ordinary',
  safety_report: 'Safety report',
  restricted_asset_information: 'Restricted asset information',
};

export const documentTypeLabels: Record<DocumentType, string> = {
  safety_policy: 'Safety policy',
  accountable_executive_designation: 'Accountable executive designation',
  roles_and_authority: 'Roles and risk authority',
  emergency_response_plan: 'Emergency response plan',
  sms_manual: 'SMS manual',
  procedure: 'Procedure',
  safety_notice: 'Safety notice',
  other: 'Document',
  oem_manual: 'OEM manual',
  service_bulletin: 'Service bulletin',
  specification: 'Specification',
  certificate: 'Certificate',
  recordkeeping_plan: 'Recordkeeping plan',
};

export const recordKindLabels: Record<SmsRecordKind, string> = {
  hazard: 'Hazard',
  document: 'Document',
  risk_matrix: 'Risk matrix',
  report: 'Safety report',
  control: 'Control',
  assurance: 'Safety assurance record',
};

export const linkRelationLabels: Record<SmsLink['relation'], string> = {
  cites: 'Cites',
  affects: 'Affects',
  derived_from: 'Derived from',
};

export const linkedFromLabels: Record<SmsLink['relation'], string> = {
  cites: 'Cited by',
  affects: 'Affected by',
  derived_from: 'Source of',
};

export const authorityLabels: Record<RiskAuthority, string> = {
  low: 'May accept low risk',
  medium: 'May accept up to medium risk',
  high: 'May accept high risk',
};

export function dueLabel(record: Pick<SmsRecordSummary, 'dueAt' | 'overdue'>): string | null {
  if (!record.dueAt) return null;
  const date = new Date(record.dueAt).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: timeZone(),
  });
  return record.overdue ? `Overdue since ${date}` : `Due ${date}`;
}

export function plainError(failure: unknown): { code?: string; message: string } {
  const body = (failure as { body?: { error?: { code?: string; message?: string } } })?.body;
  if (body?.error?.message) return { code: body.error.code, message: body.error.message };
  return { message: failure instanceof Error ? failure.message : 'The request could not be completed.' };
}

export function saveBytes(bytes: Uint8Array, filename: string, contentType: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: contentType }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
