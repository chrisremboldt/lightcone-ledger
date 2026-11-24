import type { PoolClient } from '@ledger/persistence';

/** The organization's IANA time zone, UTC when none is recorded. */
export async function organizationTimeZone(client: PoolClient, tenantId: string): Promise<string> {
  const row = (await client.query<{ time_zone: string }>('SELECT time_zone FROM tenants WHERE id=$1', [tenantId]))
    .rows[0];
  return row?.time_zone ?? 'UTC';
}
