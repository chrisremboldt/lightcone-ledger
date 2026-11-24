import type { ControlBody, SmsAssessedControl, SmsHazardControl, SmsRecordDraft } from '@ledger/contracts';
import { DomainError, type PoolClient } from '@ledger/persistence';
import { controlParameterProblem, controlWording, describeControl, findControlType } from './control-types.js';
import type { SmsRecordRow, SmsVersionRow } from './sms-envelope.js';

export type ControlVersionRow = SmsVersionRow & { body: ControlBody };

function requireInterval(body: ControlBody): void {
  const from = Date.parse(body.effectiveFrom);
  const until = body.effectiveUntil === undefined ? undefined : Date.parse(body.effectiveUntil);
  if (!Number.isFinite(from) || (until !== undefined && !(Number.isFinite(until) && until > from)))
    throw new DomainError(400, 'invalid_effective_interval', 'A control must end after it takes effect');
}

/** Checks a control draft against its registered type and its hazard. Other kinds pass unchanged. */
export async function requireControlDraft(
  client: PoolClient,
  tenantId: string,
  draft: SmsRecordDraft,
  existing?: SmsVersionRow,
): Promise<void> {
  if (draft.kind !== 'control') return;
  const body = draft.body;
  const problem = controlParameterProblem(body.controlType, body.parameters);
  if (problem) throw new DomainError(400, 'invalid_control', problem);
  requireInterval(body);
  if (existing && (existing.body as ControlBody).hazardId !== body.hazardId)
    throw new DomainError(400, 'control_hazard_fixed', 'A control stays on the hazard it was proposed for');
  const hazard = (
    await client.query<{ kind: string; status: string }>(
      'SELECT kind,status FROM sms_records WHERE tenant_id=$1 AND id=$2 FOR SHARE',
      [tenantId, body.hazardId],
    )
  ).rows[0];
  if (hazard?.kind !== 'hazard')
    throw new DomainError(400, 'hazard_unavailable', 'The hazard was not found in your organization');
  if (!existing && hazard.status === 'closed')
    throw new DomainError(409, 'record_closed', 'This hazard is closed; reopen it before proposing a control');
}

async function controlVersions(
  client: PoolClient,
  tenantId: string,
  hazardId: string,
  ids: string[],
): Promise<Map<string, { record: SmsRecordRow; version: ControlVersionRow }>> {
  const rows = await client.query<SmsRecordRow & { version: ControlVersionRow }>(
    `SELECT r.*,to_jsonb(v) AS version FROM sms_records r
     JOIN sms_record_versions v ON v.tenant_id=r.tenant_id AND v.record_id=r.id AND v.version_number=r.version_number
     WHERE r.tenant_id=$1 AND r.id=ANY($2) AND r.kind='control' AND v.body->>'hazardId'=$3`,
    [tenantId, ids, hazardId],
  );
  return new Map(rows.rows.map(({ version, ...record }) => [record.id, { record, version }]));
}

/** How an assessment lists one control version and a risk acceptance binds it, described by its registered type. */
export function assessedControlEntry(version: ControlVersionRow): SmsAssessedControl {
  const { controlType, parameters, effectiveFrom, effectiveUntil } = version.body;
  const description = describeControl(controlType, parameters);
  const type = findControlType(controlType.id, controlType.version);
  if (description === undefined || !type)
    throw new DomainError(
      409,
      'control_type_unavailable',
      `The control “${version.title}” uses a control type that is not registered here`,
    );
  return {
    recordId: version.record_id,
    versionNumber: version.version_number,
    bodyDigest: version.body_digest,
    title: version.title,
    controlType,
    type: type.title,
    description,
    effectiveFrom,
    effectiveUntil: effectiveUntil ?? null,
  };
}

/** The controls an assessment lists: each the current, open version of a control on this hazard. */
export async function assessedControls(
  client: PoolClient,
  tenantId: string,
  hazardId: string,
  references: { recordId: string; versionNumber: number }[],
): Promise<{ controls: SmsAssessedControl[]; eventIds: Map<string, string> }> {
  const ids = references.map((reference) => reference.recordId);
  if (new Set(ids).size !== ids.length)
    throw new DomainError(400, 'duplicate_control', 'The same control is listed twice');
  const found = await controlVersions(client, tenantId, hazardId, ids);
  const controls = references.map((reference) => {
    const control = found.get(reference.recordId);
    if (!control) throw new DomainError(400, 'control_unavailable', 'A listed control is not a control on this hazard');
    if (control.record.status === 'closed')
      throw new DomainError(409, 'control_closed', `The control “${control.version.title}” is withdrawn`);
    if (control.version.version_number !== reference.versionNumber)
      throw new DomainError(409, 'control_changed', `A newer version of “${control.version.title}” exists; review it`);
    return assessedControlEntry(control.version);
  });
  return { controls, eventIds: new Map([...found].map(([id, control]) => [id, control.version.id])) };
}

/** The assessed control versions, each still current, open and unchanged, or a conflict. */
export async function requireAssessedControlsCurrent(
  client: PoolClient,
  tenantId: string,
  hazardId: string,
  controls: SmsAssessedControl[],
): Promise<void> {
  if (!controls.length) return;
  const found = await controlVersions(
    client,
    tenantId,
    hazardId,
    controls.map((control) => control.recordId),
  );
  for (const control of controls) {
    const current = found.get(control.recordId);
    if (
      !current ||
      current.record.status === 'closed' ||
      current.version.version_number !== control.versionNumber ||
      current.version.body_digest !== control.bodyDigest
    )
      throw new DomainError(
        409,
        'control_changed',
        'A control changed or was withdrawn after the assessment; reassess this hazard',
      );
  }
}

/** Keeps one row per control version a risk acceptance binds, in the acceptance's own transaction. */
export async function recordAcceptedControls(
  client: PoolClient,
  tenantId: string,
  hazardId: string,
  acceptanceId: string,
  controls: SmsAssessedControl[],
  acceptedAt: Date,
): Promise<void> {
  for (const control of controls)
    await client.query(
      `INSERT INTO accepted_hazard_controls(tenant_id,acceptance_id,hazard_id,control_id,control_version_number,
       control_body_digest,control_type_id,control_type_version,control_type_digest,effective_from,effective_until,
       accepted_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        tenantId,
        acceptanceId,
        hazardId,
        control.recordId,
        control.versionNumber,
        control.bodyDigest,
        control.controlType.id,
        control.controlType.version,
        control.controlType.digest,
        control.effectiveFrom,
        control.effectiveUntil,
        acceptedAt,
      ],
    );
}

interface HazardControlRow {
  id: string;
  title: string;
  status: string;
  version_number: number;
  body: ControlBody;
  body_digest: string;
  owner_id: string;
  owner_name: string;
  accepted: boolean;
}

/** The control in its type's words for a person, when the type gives them; never recorded. */
function wordingOf(
  controlType: { id: string; version: number; digest: string },
  parameters: Record<string, unknown>,
): { wording?: string } {
  const wording = controlWording(controlType, parameters);
  return wording === undefined ? {} : { wording };
}

/** Every control proposed on a hazard, newest first, marked when the hazard's latest acceptance binds it. */
export async function hazardControls(
  client: PoolClient,
  tenantId: string,
  hazard: SmsRecordRow,
): Promise<SmsHazardControl[]> {
  const rows = await client.query<HazardControlRow>(
    `SELECT r.id,r.title,r.status,r.version_number,v.body,v.body_digest,r.owner_id,o.name AS owner_name,
     EXISTS(SELECT 1 FROM accepted_hazard_controls a WHERE a.tenant_id=r.tenant_id AND a.hazard_id=$2
       AND a.acceptance_id=$3 AND a.control_id=r.id AND a.control_version_number=r.version_number) AS accepted
     FROM sms_records r
     JOIN sms_record_versions v ON v.tenant_id=r.tenant_id AND v.record_id=r.id AND v.version_number=r.version_number
     JOIN principals o ON o.tenant_id=r.tenant_id AND o.id=r.owner_id
     WHERE r.tenant_id=$1 AND r.kind='control' AND v.schema='sms.control.1' AND v.body->>'hazardId'=$2
     ORDER BY r.opened_at DESC,r.id`,
    [tenantId, hazard.id, hazard.latest_acceptance_id ?? ''],
  );
  return rows.rows.map((row) => {
    const { controlType, parameters, effectiveFrom, effectiveUntil } = row.body;
    return {
      id: row.id,
      title: row.title,
      status: row.status,
      versionNumber: row.version_number,
      bodyDigest: row.body_digest,
      owner: { id: row.owner_id, name: row.owner_name },
      controlType: { ...controlType, title: findControlType(controlType.id, controlType.version)?.title ?? null },
      parameters,
      description: describeControl(controlType, parameters) ?? null,
      ...wordingOf(controlType, parameters),
      effectiveFrom,
      effectiveUntil: effectiveUntil ?? null,
      accepted: row.accepted,
    };
  });
}
