import { randomUUID } from 'node:crypto';
import type { OrganizationCoverageResponse, PackAdoptionCommand, RulePackVersion } from '@ledger/contracts';
import { seededOrganizations } from '@ledger/persistence';
import { seededOrganizationPack } from '@ledger/standard-packs';
import type { createApp } from './index.js';

type App = Awaited<ReturnType<typeof createApp>>;

/** The organization already holds a newer version of the seeded pack, or one that starts later; the seed leaves it. */
export class SeedAdoptionConflict extends Error {}

/** The pack every seeded flight organization adopts, and how long the seeded adoption runs. */
export const SEEDED_PACK = seededOrganizationPack;
const SEEDED_YEARS = 10;

/**
 * Adopts one pack version in active mode for the organization of the person holding the token, through the same
 * read and command a person uses. An older version adopted until a later time is succeeded from now on, so a database
 * seeded before the pack gained a version takes the new one. Returns false when that exact version is already adopted.
 */
export async function adoptRulePack(
  app: App,
  token: string,
  pack: { packId: string; version: number },
  note: string,
): Promise<boolean> {
  const call = async <T>(method: 'GET' | 'POST', url: string, payload?: object) => {
    const response = await app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() },
      ...(payload ? { payload } : {}),
    });
    if (response.statusCode >= 300) throw new Error(`Seed request ${method} ${url} failed: ${response.body}`);
    return response.json() as T;
  };
  const shown = await call<OrganizationCoverageResponse>('GET', '/v1/organization/coverage');
  if (
    shown.adoptions.some((adoption) => adoption.pack.packId === pack.packId && adoption.pack.version === pack.version)
  )
    return false;
  const start = new Date();
  const current = shown.adoptions.find(
    (adoption) =>
      adoption.pack.packId === pack.packId &&
      !adoption.revisedBy &&
      !adoption.succeededBy &&
      Date.parse(adoption.effectiveInterval.end) > start.getTime(),
  );
  if (
    current &&
    (current.pack.version > pack.version || Date.parse(current.effectiveInterval.start) >= start.getTime())
  )
    throw new SeedAdoptionConflict(
      `${shown.organization.id} already adopted ${pack.packId} version ${current.pack.version} from ` +
        `${current.effectiveInterval.start} until ${current.effectiveInterval.end}, so the seed leaves it in place ` +
        `rather than adopt version ${pack.version}.`,
    );
  const retained = await call<{ pack: RulePackVersion }>(
    'GET',
    `/v1/rule-packs/${encodeURIComponent(pack.packId)}/versions/${pack.version}`,
  );
  const reference = ({ id, version, digest }: { id: string; version: number; digest: string }) => ({
    id,
    version,
    digest,
  });
  const end = new Date(start);
  end.setUTCFullYear(end.getUTCFullYear() + SEEDED_YEARS);
  const command: PackAdoptionCommand = {
    kind: 'rule-pack.adopt',
    expectedRevision: shown.organization.revision,
    inputCut: {
      ...shown.meta.inputCut,
      basisRevision: shown.organization.revision,
      principalRevision: shown.meta.inputCut.principalRevision!,
    },
    expectedDependencyBasis: shown.meta.dependencyBasis!,
    pack: {
      packId: retained.pack.packId,
      version: retained.pack.version,
      digest: retained.pack.digest,
      leaves: retained.pack.leaves.map(reference),
      bindings: retained.pack.bindings.map(reference),
    },
    effectiveInterval: { start: start.toISOString(), end: end.toISOString() },
    note,
    mode: 'active',
    ...(current ? { succeeds: current.id } : {}),
  };
  await call('POST', '/v1/commands', command);
  return true;
}

/** Each seeded flight organization's dispatcher adopts the demo procedures. Returns the tenants adopted now. */
export async function adoptSeededRulePacks(app: App): Promise<string[]> {
  const adopted: string[] = [];
  for (const name of seededOrganizations) {
    const note = 'Adopted as the operating procedures of the fictional flight organization.';
    if (await adoptRulePack(app, `ledger-dev-${name}-operator`, SEEDED_PACK, note)) adopted.push(`tenant-${name}`);
  }
  return adopted;
}
