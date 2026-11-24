import {
  AUTHORITY_PRINCIPAL_MAX_RESPONSE_BYTES,
  type AuthorityPrincipal,
  type AuthorityPrincipalResponse,
  type ObservationGrant,
} from '@ledger/contracts';
import { DomainError, type AuthContext, type PoolClient } from '@ledger/persistence';
import { getObservationGrants } from './observations.js';

export interface AuthorityPrincipalRow {
  id: string;
  tenant_id: string;
  name: string;
  kind: AuthorityPrincipal['kind'];
  active: boolean;
  revision: string;
  capabilities: AuthorityPrincipal['capabilities'];
  command_link_sources: string[];
  mission_sources: string[];
  monitoring_sources: string[];
}

/** The columns authorityPrincipal reads. */
export const AUTHORITY_PRINCIPAL_COLUMNS =
  'id,tenant_id,name,kind,active,revision,capabilities,command_link_sources,mission_sources,monitoring_sources';

export function authorityPrincipal(
  row: AuthorityPrincipalRow,
  observationGrants: ObservationGrant[],
): AuthorityPrincipal {
  const revision = Number(row.revision);
  if (!Number.isSafeInteger(revision) || revision < 1)
    throw new DomainError(500, 'unsupported_principal_revision', 'Principal authority could not be read');
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    kind: row.kind,
    active: row.active,
    revision,
    capabilities: row.capabilities,
    commandLinkSources: row.command_link_sources,
    missionSources: row.mission_sources,
    monitoringSources: row.monitoring_sources,
    observationGrants,
  };
}

export async function getPrincipalAuthority(
  client: PoolClient,
  principal: AuthContext,
  id: string,
): Promise<AuthorityPrincipalResponse> {
  if (!principal.capabilities.includes('authority:write'))
    throw new DomainError(403, 'capability_required', 'Reading principal authority requires authority:write');
  const row = (
    await client.query<AuthorityPrincipalRow>(
      `SELECT ${AUTHORITY_PRINCIPAL_COLUMNS} FROM principals WHERE tenant_id=$1 AND id=$2`,
      [principal.tenantId, id],
    )
  ).rows[0];
  if (!row) throw new DomainError(404, 'principal_not_found', 'Principal was not found in this organization');
  const response: AuthorityPrincipalResponse = {
    principal: authorityPrincipal(row, await getObservationGrants(client, row.tenant_id, row.id)),
  };
  if (Buffer.byteLength(JSON.stringify(response), 'utf8') > AUTHORITY_PRINCIPAL_MAX_RESPONSE_BYTES)
    throw new DomainError(413, 'principal_authority_too_large', 'Principal authority exceeds its response size limit');
  return response;
}
