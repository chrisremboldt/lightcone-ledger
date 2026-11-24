import type { AcceptedAreaControlResponse, ControlBody } from '@ledger/contracts';
import { DomainError, type AuthContext, type PoolClient } from '@ledger/persistence';
import { controlRecordBriefingContent } from './mission-briefing-integrity.js';

interface ControlRecordRow {
  id: string;
  title: string;
  body: ControlBody;
  body_digest: string;
  owner_id: string;
  owner_name: string;
  hazard_title: string;
}

/**
 * One accepted area control version as route review reads it. A control record is readable here only once a risk
 * acceptance binds that version and its type describes an area.
 */
export async function getAcceptedAreaControl(
  client: PoolClient,
  principal: AuthContext,
  hazardId: string,
  controlId: string,
  version: number,
): Promise<AcceptedAreaControlResponse> {
  const row = (
    await client.query<ControlRecordRow>(
      `SELECT v.id,v.title,v.body,v.body_digest,v.owner_id,o.name AS owner_name,hv.title AS hazard_title
       FROM accepted_hazard_controls a
       JOIN sms_record_versions v ON v.tenant_id=a.tenant_id AND v.record_id=a.control_id
        AND v.version_number=a.control_version_number AND v.body_digest=a.control_body_digest
       JOIN principals o ON o.tenant_id=v.tenant_id AND o.id=v.owner_id
       JOIN sms_records h ON h.tenant_id=a.tenant_id AND h.id=a.hazard_id
       JOIN sms_record_versions hv ON hv.tenant_id=h.tenant_id AND hv.record_id=h.id AND hv.version_number=h.version_number
       WHERE a.tenant_id=$1 AND a.hazard_id=$2 AND a.control_id=$3 AND a.control_version_number=$4 LIMIT 1`,
      [principal.tenantId, hazardId, controlId, version],
    )
  ).rows[0];
  const content = row ? controlRecordBriefingContent(row) : undefined;
  if (!row || !content)
    throw new DomainError(404, 'area_control_not_found', 'The accepted area control was not found within your scope');
  return {
    control: {
      kind: 'control_record',
      hazard: { id: hazardId, title: row.hazard_title },
      controlEventId: row.id,
      bodyDigest: row.body_digest,
      owner: { id: row.owner_id, name: row.owner_name },
      content,
    },
  };
}
