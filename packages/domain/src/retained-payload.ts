import { randomUUID } from 'node:crypto';
import { sha256 } from '@ledger/integrity';
import type { AuthContext, ObjectStore, PoolClient } from '@ledger/persistence';

/** Retains a JSON statement as a finalized upload and artifact, for a record made without original bytes. */
export async function retainPayload(
  client: PoolClient,
  principal: AuthContext,
  payload: unknown,
  store: ObjectStore,
  filename = 'submitted-report.json',
): Promise<string> {
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const uploadId = randomUUID();
  const artifactId = randomUUID();
  const objectKey = `${principal.tenantId}/${uploadId}/content`;
  const digest = sha256(bytes);
  await store.putIfAbsent(objectKey, bytes, 'application/json');
  await client.query(
    `INSERT INTO uploads(id,tenant_id,principal_id,content_type,byte_length,filename,object_key,status,sha256)
     VALUES($1,$2,$3,'application/json',$4,$5,$6,'finalized',$7)`,
    [uploadId, principal.tenantId, principal.id, bytes.byteLength, filename, objectKey, digest],
  );
  await client.query(
    `INSERT INTO artifacts(id,tenant_id,upload_id,object_key,sha256,byte_length,content_type,object_version)
     VALUES($1,$2,$3,$4,$5,$6,'application/json',$5)`,
    [artifactId, principal.tenantId, uploadId, objectKey, digest, bytes.byteLength],
  );
  await client.query('UPDATE uploads SET artifact_id=$1 WHERE id=$2', [artifactId, uploadId]);
  return artifactId;
}
