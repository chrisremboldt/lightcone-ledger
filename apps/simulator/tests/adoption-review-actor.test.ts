import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalDigest, sha256 } from '@ledger/integrity';
import { ApiError } from '@ledger/contracts/client';
import type {
  CommandResponse,
  OrganizationCoverageResponse,
  OrganizationDecisionCommand,
  OrganizationDecisionsResponse,
  Principal,
  SubjectDecisionRecord,
  SubjectEvidenceBundle,
  SubjectExportCreate,
  SubjectExportResponse,
} from '@ledger/contracts';
import { openApiDocument } from '../../../packages/contracts/src/openapi.js';
import { verifyBundle } from '../../../tools/verifier/index.mjs';
import { runAdoptionReview } from '../src/adoption-review-actor.js';
import type { ReviewPlan } from '../src/adoption-review-plan.js';
import type { ReviewJournal } from '../src/adoption-review-journal.js';
import {
  exportFixture,
  fixtureTime,
  organizationStream,
  retainedAdoption,
  retainedReview,
  reviewBasis,
  smallRetainedPack,
  subjectBundle,
} from './fixtures/subject-evidence.js';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function journalAt(path: string): Promise<ReviewJournal> {
  const envelope = JSON.parse(await readFile(path, 'utf8')) as { version: number; body: string; sha256: string };
  expect(envelope.version).toBe(1);
  expect(envelope.sha256).toBe(sha256(envelope.body));
  return JSON.parse(envelope.body) as ReviewJournal;
}

async function fixture(exportEnabled = false) {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-adoption-review-'));
  directories.push(directory);
  const statePath = join(directory, 'review.json');
  const { pack, source } = smallRetainedPack();
  const principal: Principal = {
    commandLinkSources: [],
    id: 'fictional-reviewer',
    tenantId: 'tenant-alpha',
    name: 'Fictional Alpha safety reviewer',
    capabilities: ['flight:read', 'decision:write', 'evidence:read'],
    revision: 7,
  };
  const adoption = retainedAdoption(principal.tenantId, pack);
  const plan: ReviewPlan = {
    version: 1,
    apiUrl: 'http://review.test',
    tenantId: principal.tenantId,
    principalId: principal.id,
    adoption: {
      id: adoption.id,
      acceptedRevision: adoption.acceptedRevision,
      pack: { packId: pack.packId, version: pack.version, digest: pack.digest },
    },
    note: 'Fictional review: assessment evidence needs manual review; command-link coverage is unsupported.',
    export: exportEnabled,
  };
  const organization = {
    id: `organization:${plan.tenantId}`,
    label: 'Fictional Alpha',
    revision: 1,
    projectedRevision: 0,
  };
  const meta = {
    requestId: 'review-read',
    projectionRevision: 0,
    inputCut: { streams: { [organizationStream]: 0 }, basisRevision: 1, principalRevision: principal.revision },
    dependencyBasis: canonicalDigest(reviewBasis(plan.tenantId, principal)),
    computedAt: fixtureTime,
    outstandingWork: 999,
  };
  const coverage: OrganizationCoverageResponse = {
    organization: structuredClone(organization),
    asOf: fixtureTime,
    adoptions: [adoption],
    packOrigins: [],
    limit: 100,
    hasOlder: false,
    meta: structuredClone(meta),
  };
  const history: OrganizationDecisionsResponse = {
    organization: structuredClone(organization),
    decisions: [],
    limit: 100,
    hasOlder: false,
    meta: structuredClone(meta),
  };
  const document = structuredClone(openApiDocument);
  const reviews = new Map<string, SubjectDecisionRecord>();
  const exports = new Map<string, ReturnType<typeof exportFixture>>();
  const reads: string[] = [];
  const downloaded: string[] = [];
  const usage = { requests: 0, bytes: 0 };
  const control: {
    processing: 'pending' | 'projected';
    omitReview: boolean;
    beforeDownload?: () => Promise<void>;
    downloadedBytes?: () => Uint8Array;
    exportedBundle?: (bundle: SubjectEvidenceBundle) => SubjectEvidenceBundle;
    exportedRecord?: (value: ReturnType<typeof exportFixture>) => void;
  } = { processing: 'projected', omitReview: false };
  function displayed(projected: number, revision = 1) {
    const basis = reviewBasis(plan.tenantId, principal, projected);
    basis.frontiers[0]!.sequence = revision;
    for (const shown of [coverage, history]) {
      shown.organization.revision = revision;
      shown.organization.projectedRevision = projected;
      shown.meta.inputCut = {
        streams: { [organizationStream]: projected },
        basisRevision: revision,
        principalRevision: principal.revision,
      };
      shown.meta.dependencyBasis = canonicalDigest(basis);
    }
    if (projected >= 1) {
      adoption.processing.status = 'projected';
      adoption.state = 'effective';
    }
  }
  function omitFromHistory(record: SubjectDecisionRecord) {
    history.decisions = Array.from({ length: 100 }, (_, index) => ({
      ...structuredClone(record),
      id: `other-review-${index}`,
      acceptedRevision: index + 3,
    }));
    history.hasOlder = true;
  }
  const api = {
    async json<T>(path: string): Promise<T> {
      reads.push(path);
      const url = new URL(path, plan.apiUrl);
      let value: unknown;
      if (url.pathname === '/openapi.json') value = document;
      else if (url.pathname === '/v1/me') value = { principal, meta: history.meta };
      else if (url.pathname === '/v1/organization/coverage') value = coverage;
      else if (url.pathname === '/v1/organization/decisions') value = history;
      else if (url.pathname === `/v1/rule-packs/${pack.packId}/versions/${pack.version}`) value = { pack };
      else if (url.pathname.startsWith('/v1/subject-exports/')) {
        const exported = exports.get(url.pathname.split('/').at(-1)!);
        if (exported) value = { record: exported.record, meta: history.meta };
      }
      if (!value) throw new Error(`Unexpected review GET ${path}`);
      usage.requests++;
      usage.bytes += Buffer.byteLength(JSON.stringify(value));
      return structuredClone(value) as T;
    },
    async bytes(path: string): Promise<Uint8Array> {
      usage.requests++;
      if (path === `/v1/rule-sources/${source.sourceId}/content`) {
        const bytes = Uint8Array.from(Buffer.from(source.bytesBase64, 'base64'));
        usage.bytes += bytes.byteLength;
        return bytes;
      }
      downloaded.push(path);
      const id = path.match(/^\/v1\/subject-exports\/([^/]+)\/content$/)?.[1];
      const exported = id ? exports.get(id) : undefined;
      if (!exported) throw new Error(`Unexpected review bytes GET ${path}`);
      await control.beforeDownload?.();
      const bytes = control.downloadedBytes?.() ?? exported.bytes;
      usage.bytes += bytes.byteLength;
      return Uint8Array.from(bytes);
    },
    usage: () => ({ ...usage }),
  };
  function acceptReview(payload: string): CommandResponse {
    const command = JSON.parse(payload) as OrganizationDecisionCommand;
    const record = retainedReview(command, principal, plan.tenantId, 'review-one', control.processing);
    reviews.set(record.id, record);
    displayed(control.processing === 'pending' ? 0 : 2, 2);
    history.decisions = [record];
    if (control.omitReview) omitFromHistory(record);
    return {
      command: {
        id: record.id,
        kind: 'decision.record',
        actorId: principal.id,
        recordedAt: fixtureTime,
        payload: JSON.parse(payload) as Record<string, unknown>,
      },
      meta: structuredClone(history.meta),
    };
  }
  function acceptExport(payload: string): SubjectExportResponse {
    const requested = JSON.parse(payload) as SubjectExportCreate;
    expect(requested).toEqual({
      subject: { kind: 'organization' },
      decisionId: 'review-one',
      scope: 'whole_tenant_prefixes',
    });
    let bundle = subjectBundle(adoption, reviews.get(requested.decisionId)!, source);
    bundle = control.exportedBundle?.(bundle) ?? bundle;
    const exported = exportFixture(bundle);
    control.exportedRecord?.(exported);
    exports.set(exported.record.id, exported);
    return { record: structuredClone(exported.record), meta: structuredClone(history.meta) };
  }
  const submit = vi.fn(
    async (
      endpoint: '/v1/commands' | '/v1/subject-exports',
      payload: string,
      _key: string,
    ): Promise<CommandResponse | SubjectExportResponse> =>
      endpoint === '/v1/commands' ? acceptReview(payload) : acceptExport(payload),
  );
  return {
    plan,
    principal,
    adoption,
    pack,
    source,
    document,
    coverage,
    history,
    control,
    api,
    reads,
    downloaded,
    statePath,
    reviews,
    exports,
    submit,
    displayed,
    omitFromHistory,
    acceptReview,
    acceptExport,
    run: () => runAdoptionReview(plan, statePath, api, submit),
  };
}

describe('retained organization adoption review and subject export', () => {
  it('cites the exact pending adoption and submits the current rendered basis without waiting for projection or unrelated work', async () => {
    const f = await fixture();
    f.control.processing = 'pending';
    const result = await f.run();
    expect(result).toMatchObject({ status: 'pending', decisionId: 'review-one', processing: 'pending', attempts: 1 });
    expect(f.submit).toHaveBeenCalledTimes(1);
    const [endpoint, payload] = f.submit.mock.calls[0]!;
    expect(endpoint).toBe('/v1/commands');
    expect(JSON.parse(payload)).toEqual({
      kind: 'decision.record',
      subject: { kind: 'organization' },
      expectedRevision: 1,
      inputCut: { streams: { [organizationStream]: 0 }, basisRevision: 1, principalRevision: 7 },
      expectedDependencyBasis: canonicalDigest(reviewBasis(f.plan.tenantId, f.principal)),
      adoption: f.plan.adoption,
      decision: { kind: 'adoption.review', note: f.plan.note },
    });
    expect(f.reviews.get('review-one')!.acceptedInputCut.streams).toEqual({ [organizationStream]: 1 });
    expect(f.downloaded).toEqual([]);
  });

  it('writes nothing when required capability, served review contract or the exact adoption is unavailable', async () => {
    const capability = await fixture(true);
    capability.principal.capabilities = ['flight:read', 'decision:write'];
    expect((await capability.run()).status).toBe('pending');
    expect(capability.submit).not.toHaveBeenCalled();

    const contract = await fixture();
    const alternatives =
      contract.document.paths['/v1/commands'].post.requestBody.content['application/json'].schema.anyOf;
    const index = alternatives.findIndex(
      (schema) => 'subject' in schema.properties && schema.properties.kind.const === 'decision.record',
    );
    expect(index).toBeGreaterThanOrEqual(0);
    alternatives.splice(index, 1);
    expect((await contract.run()).status).toBe('pending');
    expect(contract.submit).not.toHaveBeenCalled();

    const missing = await fixture();
    missing.coverage.adoptions = [];
    missing.coverage.hasOlder = true;
    expect((await missing.run()).status).toBe('pending');
    expect(missing.submit).not.toHaveBeenCalled();

    const changed = await fixture();
    changed.plan.adoption.pack.digest = '0'.repeat(64);
    expect((await changed.run()).status).toBe('pending');
    expect(changed.submit).not.toHaveBeenCalled();
  });

  it('journals review endpoint, exact bytes and key before POST and replays an ambiguous write unchanged after restart', async () => {
    const f = await fixture();
    f.submit.mockImplementationOnce(async (endpoint, payload, key) => {
      const journal = await journalAt(f.statePath);
      expect(journal).toMatchObject({
        kind: 'adoption-review',
        endpoint,
        planDigest: canonicalDigest(f.plan),
        principalId: f.principal.id,
        tenantId: f.plan.tenantId,
      });
      expect(journal.actions[0]).toMatchObject({ payload, key, payloadSha256: sha256(payload), status: 'submitted' });
      throw new Error('Lost review acceptance response');
    });
    expect(await f.run()).toMatchObject({ status: 'pending', attempts: 1 });
    const retained = f.submit.mock.calls[0]!;
    f.displayed(1);
    expect(await f.run()).toMatchObject({ status: 'accepted', decisionId: 'review-one', attempts: 1 });
    expect(f.submit.mock.calls[1]).toEqual(retained);
    expect((await journalAt(f.statePath)).actions).toHaveLength(1);

    const original = await readFile(f.statePath, 'utf8');
    const originalNote = f.plan.note;
    f.plan.note = 'A different review must not reuse this action journal.';
    expect((await f.run()).status).toBe('pending');
    expect(f.submit).toHaveBeenCalledTimes(2);
    expect(await readFile(f.statePath, 'utf8')).toBe(original);
    f.plan.note = originalNote;
    const corrupt = JSON.parse(original) as { version: number; body: string; sha256: string };
    corrupt.body += ' ';
    await writeFile(f.statePath, JSON.stringify(corrupt));
    expect((await f.run()).status).toBe('pending');
    expect(f.submit).toHaveBeenCalledTimes(2);
  });

  it('refreshes only a definitively stale review and never resubmits an accepted decision omitted from 100 history rows', async () => {
    const f = await fixture();
    f.submit.mockRejectedValueOnce(
      new ApiError(409, { error: { code: 'stale_basis', message: 'Refresh the organization basis' } }),
    );
    expect(await f.run()).toMatchObject({ status: 'rejected', attempts: 1 });
    expect((await journalAt(f.statePath)).actions[0]).toMatchObject({
      status: 'rejected',
      rejection: { status: 409, code: 'stale_basis' },
    });
    f.displayed(1);
    expect(await f.run()).toMatchObject({ status: 'accepted', decisionId: 'review-one', attempts: 2 });
    const [first, second] = f.submit.mock.calls;
    expect(second![2]).not.toBe(first![2]);
    expect(JSON.parse(first![1]).inputCut.streams).toEqual({ [organizationStream]: 0 });
    expect(JSON.parse(second![1]).inputCut.streams).toEqual({ [organizationStream]: 1 });
    f.omitFromHistory(f.reviews.get('review-one')!);
    expect(await f.run()).toMatchObject({
      status: 'pending',
      decisionId: 'review-one',
      processing: 'unknown',
      attempts: 2,
    });
    expect(f.submit).toHaveBeenCalledTimes(2);
  });

  it('exports a confirmed review with pending or omitted projection and replays an ambiguous export without another review', async () => {
    const f = await fixture(true);
    f.control.processing = 'pending';
    f.control.omitReview = true;
    f.submit.mockImplementationOnce(async (_endpoint, payload) => f.acceptReview(payload));
    f.submit.mockImplementationOnce(async (endpoint, payload, key) => {
      expect(endpoint).toBe('/v1/subject-exports');
      expect((await journalAt(f.statePath)).export).toMatchObject({
        endpoint,
        payload,
        key,
        payloadSha256: sha256(payload),
        status: 'submitted',
      });
      throw new Error('Lost export creation response');
    });
    expect(await f.run()).toMatchObject({ status: 'pending', decisionId: 'review-one', attempts: 1 });
    const retained = f.submit.mock.calls[1]!;
    f.submit.mockRejectedValueOnce(
      new ApiError(409, { error: { code: 'export_deadline_exceeded', message: 'Bounded storage I/O timed out' } }),
    );
    expect((await f.run()).status).toBe('pending');
    expect((await journalAt(f.statePath)).export!.status).toBe('submitted');
    const result = await f.run();
    expect(result).toMatchObject({
      status: 'accepted',
      decisionId: 'review-one',
      processing: 'unknown',
      exportId: 'export-one',
      verification: 'verified',
      attempts: 1,
    });
    expect(f.submit.mock.calls[2]).toEqual(retained);
    expect(f.submit.mock.calls[3]).toEqual(retained);
    expect(f.submit.mock.calls.filter(([endpoint]) => endpoint === '/v1/commands')).toHaveLength(1);
    const saved = JSON.parse(await readFile(`${f.statePath}.bundle.json`, 'utf8')) as SubjectEvidenceBundle;
    expect(verifyBundle(saved, { expectedManifestDigest: result.manifestDigest }).status).toBe('verified');
    expect(saved.decision.renderedInputCut.streams).toEqual({ [organizationStream]: 0 });
    expect(saved.decision.acceptedInputCut.streams).toEqual({ [organizationStream]: 1 });
  });

  it('retains the creation response anchor before download and resumes an interrupted download without new POSTs or reanchoring', async () => {
    const f = await fixture(true);
    let interrupted = false;
    f.control.beforeDownload = async () => {
      const journal = await journalAt(f.statePath);
      const expected = f.exports.get('export-one')!.record;
      expect(journal.export).toMatchObject({ endpoint: '/v1/subject-exports', status: 'accepted', record: expected });
      expect(journal.export!.record!.manifestDigest).toBe(expected.manifestDigest);
      if (!interrupted) {
        interrupted = true;
        throw new Error('Download connection interrupted');
      }
    };
    expect(await f.run()).toMatchObject({ status: 'pending', decisionId: 'review-one', exportId: 'export-one' });
    const pinned = structuredClone((await journalAt(f.statePath)).export!.record!);
    const succeeded = await f.run();
    expect(succeeded).toMatchObject({
      status: 'accepted',
      exportId: 'export-one',
      manifestDigest: pinned.manifestDigest,
      verification: 'verified',
      bundlePath: `${f.statePath}.bundle.json`,
    });
    expect(f.submit).toHaveBeenCalledTimes(2);
    expect((await journalAt(f.statePath)).export!.record).toEqual(pinned);
    expect(f.downloaded).toHaveLength(2);
  });

  it('fails closed for download commitments or a valid bundle belonging to another subject or adoption citation', async () => {
    const length = await fixture(true);
    length.control.exportedRecord = (value) => {
      value.record.byteLength++;
    };
    expect((await length.run()).status).toBe('pending');
    await expect(readFile(`${length.statePath}.bundle.json`)).rejects.toMatchObject({ code: 'ENOENT' });

    const digest = await fixture(true);
    digest.control.exportedRecord = (value) => {
      value.record.bundleSha256 = '0'.repeat(64);
    };
    expect((await digest.run()).status).toBe('pending');

    const manifest = await fixture(true);
    manifest.control.exportedRecord = (value) => {
      value.record.manifestDigest = '0'.repeat(64);
    };
    expect((await manifest.run()).status).toBe('pending');

    const citation = await fixture(true);
    citation.control.exportedBundle = (bundle) => {
      const adopted = structuredClone(citation.adoption);
      adopted.id = 'a-different-adoption';
      const reviewed = structuredClone(citation.reviews.get(bundle.decision.id)!);
      reviewed.adoption.id = adopted.id;
      return subjectBundle(adopted, reviewed, citation.source);
    };
    expect((await citation.run()).status).toBe('pending');
    const differentCitation = citation.exports.get('export-one')!;
    expect(
      verifyBundle(JSON.parse(Buffer.from(differentCitation.bytes).toString('utf8')), {
        expectedManifestDigest: differentCitation.record.manifestDigest,
      }).status,
    ).toBe('verified');

    const subject = await fixture(true);
    subject.control.exportedBundle = (bundle) => {
      const adopted = structuredClone(subject.adoption);
      const reviewed = structuredClone(subject.reviews.get(bundle.decision.id)!);
      adopted.organizationId = 'organization:tenant-beta';
      adopted.scope.organizationId = adopted.organizationId;
      reviewed.subject.id = adopted.organizationId;
      reviewed.actor.scope.id = adopted.organizationId;
      reviewed.basisManifest.subjectId = adopted.organizationId;
      reviewed.basisManifest.subjects = [adopted.organizationId];
      reviewed.basisManifest.frontiers[0]!.subjectId = adopted.organizationId;
      reviewed.dependencyBasis = canonicalDigest(reviewed.basisManifest);
      return subjectBundle(adopted, reviewed, subject.source);
    };
    expect((await subject.run()).status).toBe('pending');
    const differentSubject = subject.exports.get('export-one')!;
    expect(
      verifyBundle(JSON.parse(Buffer.from(differentSubject.bytes).toString('utf8')), {
        expectedManifestDigest: differentSubject.record.manifestDigest,
      }).status,
    ).toBe('verified');
    await expect(readFile(`${subject.statePath}.bundle.json`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses exports above 32 MiB before downloading and rejects an oversized actual download without saving it', async () => {
    const metadata = await fixture(true);
    metadata.control.exportedRecord = (value) => {
      value.record.byteLength = 32 * 1024 * 1024 + 1;
    };
    expect((await metadata.run()).status).toBe('pending');
    expect(metadata.downloaded).toEqual([]);

    const actual = await fixture(true);
    actual.control.downloadedBytes = () => new Uint8Array(32 * 1024 * 1024 + 1);
    expect((await actual.run()).status).toBe('pending');
    expect(actual.downloaded).toHaveLength(1);
    await expect(readFile(`${actual.statePath}.bundle.json`)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
