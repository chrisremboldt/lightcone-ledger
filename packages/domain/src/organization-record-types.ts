import {
  declaredRecordChangeProblems,
  declaredRecordDefinition,
  findOperatorRecordType,
  isOperatorRecordDefinition,
  observationTypeKey,
  type ObservationRegistry,
  type OperatorRecordDefinition,
  type PackAdoptionAcceptance,
  type RulePackRecordType,
  type RulePackVersion,
} from '@ledger/contracts';
import { DomainError, type PoolClient } from '@ledger/persistence';
import { observationRegistry, registerObservationRecordTypes } from './observation-registry.js';

/**
 * The record types an organization has: those built into Ledger and those its adopted packs declare
 * (docs/design/declared-record-types.md). Every reader that offers or accepts records asks this, never the process's
 * registry, which also holds the declarations of packs other organizations adopted.
 */
export interface OrganizationRecordTypes {
  /** Every record type the organization has, ordered by id and then version. */
  readonly definitions: readonly OperatorRecordDefinition[];
  find(recordType: string, recordVersion: number): OperatorRecordDefinition | undefined;
  /** The process's registry with only these record types: what intake validates the organization's records against. */
  readonly registry: ObservationRegistry;
}

const definitionsByDigest = new Map<string, OperatorRecordDefinition>();

/** The definition a pinned declaration makes; the same digest always makes the same definition. */
export function pinnedRecordDefinition(packId: string, declared: RulePackRecordType): OperatorRecordDefinition {
  let definition = definitionsByDigest.get(declared.digest);
  if (!definition) {
    definition = declaredRecordDefinition(packId, declared);
    definitionsByDigest.set(declared.digest, definition);
  }
  return definition;
}

/** The record types of one set of pinned pack versions, over the built-in ones, as the interface every reader reads. */
export function recordTypesOfPacks(
  packs: readonly Pick<RulePackVersion, 'packId' | 'recordTypes'>[],
): OrganizationRecordTypes {
  const process = observationRegistry();
  const recordTypes: Record<string, OperatorRecordDefinition> = {};
  for (const definition of Object.values(process.recordTypes))
    if (isOperatorRecordDefinition(definition) && !definition.declaredBy)
      recordTypes[observationTypeKey(definition.recordType, definition.recordVersion)] = definition;
  // The first pack version listed wins a type and version two of them declare: callers list the latest first.
  for (const pack of packs)
    for (const declared of pack.recordTypes ?? []) {
      const key = observationTypeKey(declared.id, declared.version);
      recordTypes[key] ??= pinnedRecordDefinition(pack.packId, declared);
    }
  const definitions = Object.values(recordTypes).sort(
    (left, right) => left.recordType.localeCompare(right.recordType) || left.recordVersion - right.recordVersion,
  );
  // Record types registered in code without field metadata stay, as the process registry holds them.
  const others = Object.fromEntries(
    Object.entries(process.recordTypes).filter(([, definition]) => !isOperatorRecordDefinition(definition)),
  );
  const registry: ObservationRegistry = Object.freeze({
    types: process.types,
    recordTypes: Object.freeze({ ...others, ...recordTypes }),
  });
  return {
    definitions,
    registry,
    find: (recordType, recordVersion) => recordTypes[observationTypeKey(recordType, recordVersion)],
  };
}

/**
 * Which record types exist for this organization at this time: the built-in ones and the declarations pinned by its
 * adoptions that have not ended by `at` (in effect, or still to come, so records can be entered before the rules
 * start) and that no later adoption revises. An accepted adoption counts at once, before its projection: what it
 * pins is fixed when it is accepted. A plain read: it takes no lock.
 */
export async function organizationRecordTypes(
  client: PoolClient,
  tenantId: string,
  at: string = new Date().toISOString(),
): Promise<OrganizationRecordTypes> {
  const rows = await client.query<{ record: PackAdoptionAcceptance }>(
    `SELECT a.record FROM organization_pack_adoptions a
     WHERE a.tenant_id=$1 AND a.organization_id=$2 AND a.effective_end>$3::timestamptz
       AND a.record->'pack' ? 'recordTypes'
       AND NOT EXISTS (SELECT 1 FROM organization_pack_adoptions r WHERE r.tenant_id=a.tenant_id AND r.revises_id=a.id)
     ORDER BY a.pack_id COLLATE "C",(a.record->'pack'->>'version')::bigint DESC,a.accepted_revision DESC`,
    [tenantId, `organization:${tenantId}`, at],
  );
  return recordTypesOfPacks(rows.rows.map(({ record }) => record.pack));
}

/**
 * The registry an organization's observation is validated against. An observation carrying a record of a type no
 * pack declares is validated against the process's registry, with no read; one carrying any other record type,
 * against the organization's own record types, so a record of a type only another organization adopted is refused.
 */
export async function intakeRegistry(
  client: PoolClient,
  tenantId: string,
  payload: unknown,
): Promise<ObservationRegistry> {
  const values = (payload as { values?: { recordType?: unknown; recordVersion?: unknown } } | null)?.values;
  if (typeof values?.recordType !== 'string' || typeof values.recordVersion !== 'number') return observationRegistry();
  const registered = findOperatorRecordType(observationRegistry(), values.recordType, values.recordVersion);
  if (registered && !(isOperatorRecordDefinition(registered) && registered.declaredBy)) return observationRegistry();
  return (await organizationRecordTypes(client, tenantId)).registry;
}

/** The process's registry with one record type as the organization has it, to validate a record of that type. */
export function registryWithRecordType(definition: OperatorRecordDefinition): ObservationRegistry {
  const process = observationRegistry();
  return Object.freeze({
    types: process.types,
    recordTypes: Object.freeze({
      ...process.recordTypes,
      [observationTypeKey(definition.recordType, definition.recordVersion)]: definition,
    }),
  });
}

/** The organization's record type, or a 404 naming it. */
export function requireRecordType(
  types: OrganizationRecordTypes,
  recordType: string,
  recordVersion: number,
): OperatorRecordDefinition {
  const definition = types.find(recordType, recordVersion);
  if (!definition)
    throw new DomainError(
      404,
      'record_type_not_found',
      `Record type ${recordType} version ${recordVersion} is not one your organization has. A record type is built into Ledger, or declared by a pack your organization has adopted.`,
    );
  return definition;
}

/**
 * Why the declarations of a pack's versions cannot be registered together, or undefined. A type and version is
 * declared with one content; each later version of a type keeps what every earlier one holds.
 */
export function declaredRecordTypesProblem(versions: readonly RulePackVersion[]): string | undefined {
  const byKey = new Map<string, { declared: RulePackRecordType; packVersion: number }>();
  const byId = new Map<string, RulePackRecordType[]>();
  for (const version of versions)
    for (const declared of version.recordTypes ?? []) {
      const key = observationTypeKey(declared.id, declared.version);
      const earlier = byKey.get(key);
      if (earlier && earlier.declared.digest !== declared.digest)
        return `Record type ${declared.id} version ${declared.version} is declared differently by pack versions ${earlier.packVersion} and ${version.version}. Any change to a declaration, even to a label, is a new version of the type.`;
      if (earlier) continue;
      byKey.set(key, { declared, packVersion: version.version });
      byId.set(declared.id, [...(byId.get(declared.id) ?? []), declared]);
    }
  for (const declarations of byId.values()) {
    const ordered = [...declarations].sort((left, right) => left.version - right.version);
    for (const [index, later] of ordered.entries())
      for (const earlier of ordered.slice(0, index)) {
        const problems = declaredRecordChangeProblems(earlier, later);
        if (problems.length) return problems.join(' ');
      }
  }
  return undefined;
}

/**
 * Registers the declarations of registered pack versions in the process's registry, so that code reading records
 * already on file finds a declared type as it finds a built-in one. A type and version registered with the same
 * digest is not registered again; with another, it is refused.
 */
export function registerDeclaredRecordTypes(packId: string, versions: readonly RulePackVersion[]): void {
  const added = new Map<string, OperatorRecordDefinition>();
  for (const version of versions)
    for (const declared of version.recordTypes ?? []) {
      const key = observationTypeKey(declared.id, declared.version);
      const registered = findOperatorRecordType(observationRegistry(), declared.id, declared.version);
      if (registered) {
        const digest = isOperatorRecordDefinition(registered) ? registered.declaredBy?.digest : undefined;
        if (digest !== declared.digest)
          throw new Error(`Record type ${key} of pack ${packId} is already registered with different content`);
        continue;
      }
      if (!added.has(key)) added.set(key, pinnedRecordDefinition(packId, declared));
    }
  registerObservationRecordTypes(...added.values());
}
