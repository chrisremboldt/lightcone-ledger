import {
  findObservationType,
  subjectReferenceKey,
  type ObservationReferenceField,
  type ObservationRegistry,
  type RuleRead,
  type SubjectReference,
} from '@ledger/contracts';
import type { PoolClient } from '@ledger/persistence';
import { observationRegistry } from './observation-registry.js';

/**
 * The reference index (docs/design/fan-out-and-related-reads.md, section 4): one row per reference field of each
 * accepted observation. Which fields are references comes from the observation registry; nothing here names a type.
 */

/** A reference field as an observation wrote it. A source reference is the observation's source's own id. */
export interface WrittenReference {
  field: string;
  referenceKind: string;
  scope: 'ledger' | 'source';
  id: string;
}

/** The value at a dot path into an observation object, or undefined. */
export function valueAt(object: unknown, path: string): unknown {
  let value = object;
  for (const part of path.split('.')) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, part)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

/** The { id, scope } a reference field holds, or undefined when it holds anything else. */
export function referenceValue(value: unknown): { id: string; scope: 'ledger' | 'source' } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { id, scope } = value as Record<string, unknown>;
  if (typeof id !== 'string' || !id.trim() || id.length > 200) return undefined;
  return scope === 'ledger' || scope === 'source' ? { id, scope } : undefined;
}

function referenceFields(registry: ObservationRegistry, type: string, version: number): ObservationReferenceField[] {
  return [...(findObservationType(registry, type, version)?.referenceFields?.(registry) ?? [])];
}

function applies(field: ObservationReferenceField, observation: Record<string, unknown>): boolean {
  return (field.when ?? []).every((condition) => valueAt(observation, condition.field) === condition.value);
}

/** Every filled reference field of an observation, as written. */
export function observationReferences(
  observation: Record<string, unknown>,
  registry: ObservationRegistry = observationRegistry(),
): WrittenReference[] {
  const fields = referenceFields(registry, String(observation.type), Number(observation.version));
  const byField = new Map<string, WrittenReference>();
  for (const field of fields) {
    if (byField.has(field.field) || !applies(field, observation)) continue;
    const reference = referenceValue(valueAt(observation, field.field));
    if (reference) byField.set(field.field, { field: field.field, referenceKind: field.referenceKind, ...reference });
  }
  return [...byField.values()];
}

/**
 * The kinds of subject a read's observations may name at a field, as the registry declares them for the read's
 * type and versions, narrowed by the read's own conditions. Empty when no type declares the field.
 */
export function declaredReferenceKinds(
  read: Pick<RuleRead, 'type' | 'versions' | 'where'>,
  field: string,
  registry: ObservationRegistry = observationRegistry(),
): string[] {
  const kinds = new Set<string>();
  for (const version of read.versions)
    for (const candidate of referenceFields(registry, read.type, version)) {
      if (candidate.field !== field) continue;
      const excluded = (candidate.when ?? []).some((condition) =>
        (read.where ?? []).some(
          (where) => where.field === condition.field && 'oneOf' in where && !where.oneOf.includes(condition.value),
        ),
      );
      if (!excluded) kinds.add(candidate.referenceKind);
    }
  return [...kinds];
}

/** The subject reference a written reference names before any resolution. */
export function writtenSubject(reference: Omit<WrittenReference, 'field'>, sourceId: string): SubjectReference {
  const kind = reference.referenceKind as SubjectReference['kind'];
  return reference.scope === 'ledger'
    ? { scope: 'ledger', kind, id: reference.id }
    : { scope: 'source', kind, id: reference.id, sourceId };
}

async function insertReferences(
  client: PoolClient,
  tenantId: string,
  observationId: string,
  sourceId: string,
  references: WrittenReference[],
): Promise<number> {
  let inserted = 0;
  for (const reference of references) {
    const result = await client.query(
      `INSERT INTO observation_references(tenant_id,observation_id,field,reference_kind,reference_scope,reference_id,
         reference_source_id,reference_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
      [
        tenantId,
        observationId,
        reference.field,
        reference.referenceKind,
        reference.scope,
        reference.id,
        reference.scope === 'source' ? sourceId : null,
        subjectReferenceKey(writtenSubject(reference, sourceId)),
      ],
    );
    inserted += result.rowCount ?? 0;
  }
  return inserted;
}

/** Indexes the references of one accepted observation. Called by intake in the transaction that stores it. */
export async function indexObservationReferences(
  client: PoolClient,
  tenantId: string,
  observationId: string,
  sourceId: string,
  observation: Record<string, unknown>,
): Promise<number> {
  return insertReferences(client, tenantId, observationId, sourceId, observationReferences(observation));
}

export interface ReferenceBackfillPage {
  /** Observations read in this page. */
  scanned: number;
  /** Reference rows added; rows already present are left as they are. */
  indexed: number;
  /** The id to continue after, or null when every observation has been read. */
  after: string | null;
}

/**
 * Indexes the references of observations accepted before the index existed, one page in observation id order.
 * Idempotent and resumable: rows already indexed are kept, and a run continues from the id it last returned. Runs
 * with an owner connection, across tenants, as a maintenance command.
 */
export async function backfillObservationReferencesPage(
  client: PoolClient,
  options: { after?: string; limit?: number } = {},
  registry: ObservationRegistry = observationRegistry(),
): Promise<ReferenceBackfillPage> {
  const types = Object.values(registry.types)
    .filter((definition) => (definition.referenceFields?.(registry) ?? []).length)
    .map((definition) => definition.type);
  const limit = Math.min(Math.max(options.limit ?? 500, 1), 5000);
  const rows = await client.query<{
    id: string;
    tenant_id: string;
    source_id: string;
    observation: Record<string, unknown>;
  }>(`SELECT id,tenant_id,source_id,observation FROM observations WHERE id>$1 ORDER BY id LIMIT $2`, [
    options.after ?? '',
    limit,
  ]);
  let indexed = 0;
  for (const row of rows.rows)
    if (types.includes(String(row.observation.type)))
      indexed += await insertReferences(
        client,
        row.tenant_id,
        row.id,
        row.source_id,
        observationReferences(row.observation, registry),
      );
  return { scanned: rows.rows.length, indexed, after: rows.rows.length === limit ? rows.rows.at(-1)!.id : null };
}
