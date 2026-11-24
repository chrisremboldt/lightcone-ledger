import type { OrganizationDecisionCommand, SubjectEvidenceBundle, SubjectExportRecord } from '@ledger/contracts';
import { canonicalDigest, sha256 } from '@ledger/integrity';
import type { ReviewPlan } from './adoption-review-plan.js';
import { AdoptionPending } from './pack-adoption-review.js';
import { readPrivateText, writePrivateBytes } from './private-journal.js';

export const maxSubjectExportBytes = 32 * 1024 * 1024;
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const same = (left: unknown, right: unknown): boolean => canonicalDigest(left) === canonicalDigest(right);

export function validateReviewExport(value: unknown, plan: ReviewPlan, decisionId: string): SubjectExportRecord {
  const record = value as SubjectExportRecord | undefined;
  if (
    !record ||
    typeof record.id !== 'string' ||
    !record.id ||
    record.id.length > 200 ||
    record.tenantId !== plan.tenantId ||
    record.format !== 'ledger.subject-evidence.2' ||
    record.subject?.kind !== 'organization' ||
    record.subject.id !== `organization:${plan.tenantId}` ||
    record.decisionId !== decisionId ||
    record.issuedBy !== plan.principalId ||
    typeof record.issuedAt !== 'string' ||
    !Number.isFinite(Date.parse(record.issuedAt)) ||
    record.scope !== 'whole_tenant_prefixes' ||
    !Number.isSafeInteger(record.byteLength) ||
    record.byteLength < 1 ||
    record.byteLength > maxSubjectExportBytes ||
    !digest(record.bundleSha256) ||
    !digest(record.manifestDigest) ||
    !digest(record.snapshotDigest) ||
    record.anchorStatus !== 'not_externally_anchored' ||
    record.interpretation !== 'evidence-cut.1' ||
    !object(record.limits) ||
    record.limits.maxBundleBytes !== maxSubjectExportBytes ||
    !object(record.counts) ||
    !object(record.cuts) ||
    !object(record.interpretations)
  )
    throw new AdoptionPending(
      'export_commitment_invalid',
      'The export response did not confirm the requested review and bounded v2 commitments',
    );
  return structuredClone(record);
}

interface Verification {
  status: 'verified' | 'integrity_only';
  format: string;
  tenantId: string;
  subject: { kind: string; id: string };
  decisionId: string;
  manifestDigest: string;
}
interface OfflineVerifier {
  parseStrictJson(source: string): unknown;
  verifySubjectBundle(bundle: unknown, options: { expectedManifestDigest: string }): Verification;
}

export async function verifyReviewExport(
  bytes: Uint8Array,
  record: SubjectExportRecord,
  plan: ReviewPlan,
  command: OrganizationDecisionCommand,
): Promise<'verified' | 'integrity_only'> {
  if (
    bytes.byteLength > maxSubjectExportBytes ||
    bytes.byteLength !== record.byteLength ||
    sha256(bytes) !== record.bundleSha256
  )
    throw new AdoptionPending(
      'export_bytes_mismatch',
      'Downloaded export bytes differ from the retained length or SHA-256',
    );
  try {
    const verifier = (await import(
      new URL('../../../tools/verifier/index.mjs', import.meta.url).href
    )) as OfflineVerifier;
    const bundle = verifier.parseStrictJson(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    ) as SubjectEvidenceBundle;
    const verified = verifier.verifySubjectBundle(bundle, { expectedManifestDigest: record.manifestDigest });
    const subject = { kind: 'organization', id: `organization:${plan.tenantId}` };
    const decision = bundle.decision;
    if (
      !['verified', 'integrity_only'].includes(verified.status) ||
      verified.format !== record.format ||
      verified.tenantId !== plan.tenantId ||
      verified.decisionId !== record.decisionId ||
      !same(verified.subject, subject) ||
      verified.manifestDigest !== record.manifestDigest ||
      bundle.manifest.exportId !== record.id ||
      bundle.manifest.issuedBy !== record.issuedBy ||
      bundle.manifest.issuedAt !== record.issuedAt ||
      !same(bundle.manifest.counts, record.counts) ||
      !same(bundle.manifest.limits, record.limits) ||
      !same(bundle.cuts, record.cuts) ||
      canonicalDigest(bundle.snapshot) !== record.snapshotDigest ||
      decision.id !== record.decisionId ||
      !same(decision.subject, subject) ||
      decision.kind !== 'adoption.review' ||
      decision.note !== plan.note ||
      !same(decision.adoption, plan.adoption) ||
      decision.acceptedRevision !== command.expectedRevision + 1 ||
      decision.acceptedBasisRevision !== command.expectedRevision ||
      !same(decision.renderedInputCut, command.inputCut) ||
      decision.dependencyBasis !== command.expectedDependencyBasis ||
      decision.actor.id !== plan.principalId ||
      decision.actor.principalRevision !== command.inputCut.principalRevision
    )
      throw new AdoptionPending(
        'export_commitment_mismatch',
        'The verified bundle does not match the retained review or export response',
      );
    for (const cut of ['rendered', 'accepted', 'issuance'] as const) {
      const inventory = bundle.interpretations[cut];
      const summary = record.interpretations[cut];
      if (
        summary.digest !== canonicalDigest(inventory) ||
        summary.eventCount !== inventory.events.length ||
        !same(summary.missingCausationIds, inventory.missingCausationIds) ||
        summary.causalClosure !== (inventory.missingCausationIds.length ? 'incomplete' : 'closed')
      )
        throw new AdoptionPending(
          'export_commitment_mismatch',
          'The retained export summary differs from its verified inventory',
        );
    }
    const renderedIds = new Set(bundle.interpretations.rendered.events.map((event) => event.eventId));
    const addedAcceptedIds = bundle.interpretations.accepted.events
      .filter((event) => !renderedIds.has(event.eventId))
      .map((event) => event.eventId);
    if (!same(record.addedAcceptedEventIds, addedAcceptedIds))
      throw new AdoptionPending(
        'export_commitment_mismatch',
        'The retained export differs on evidence accepted after the rendered cut',
      );
    return verified.status;
  } catch (error) {
    if (error instanceof AdoptionPending) throw error;
    throw new AdoptionPending(
      'export_verification_failed',
      'Offline verification could not confirm the export against its retained manifest digest',
    );
  }
}

export async function retainReviewBundle(path: string, bytes: Uint8Array, expectedSha256: string): Promise<void> {
  try {
    const previous = await readPrivateText(path, maxSubjectExportBytes);
    if (sha256(previous) !== expectedSha256)
      throw new AdoptionPending(
        'bundle_path_conflict',
        'The bundle path already contains different bytes; the actor will not replace them',
      );
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await writePrivateBytes(path, bytes);
}
