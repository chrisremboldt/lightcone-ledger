import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalDigest, sha256 } from '@ledger/integrity';
import type {
  CommandResponse,
  OrganizationCoverageResponse,
  PackAdoptionCommand,
  PackAdoptionRecord,
  Principal,
  RulePackBinding,
  RulePackLeaf,
  RulePackVersion,
} from '@ledger/contracts';
import { ApiError } from '@ledger/contracts/client';
import { openApiDocument } from '../../../packages/contracts/src/openapi.js';
import { recordCompleteV2 } from '../../../packages/domain/src/check-kind-library-records.js';
import { defineCheckedRule } from '../../../packages/domain/src/checked-rules.js';
import { getRulePackVersion } from '../../../packages/domain/src/rule-pack-registry.js';
import { runPackAdoption } from '../src/pack-adoption-actor.js';
import type { ActionJournal } from '../src/pack-adoption-journal.js';
import type { AdoptionPlan } from '../src/pack-adoption-review.js';
import { OracleApi } from '../src/oracle-api.js';

const directories: string[] = [];
const now = '2026-10-15T14:30:00.000Z';
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

function automatedPack(): RulePackVersion {
  const bindingContent: Omit<Extract<RulePackBinding, { inputKind: 'flight.observation' }>, 'digest'> = {
    id: 'ledger.flight-observation',
    version: 1,
    inputKind: 'flight.observation',
    supportedFields: ['activity', 'landingTime'],
    correctionHandling: 'active_claims_selected_by_caller',
  };
  const binding = { ...bindingContent, digest: canonicalDigest(bindingContent) };
  const text = 'Retain each reported landing time with its source.';
  const leafContent: Omit<Extract<RulePackLeaf, { coverage: 'automated' }>, 'digest'> = {
    id: 'fictional.landing-evidence',
    version: 1,
    title: 'Reported landing evidence',
    source: {
      kind: 'operator_procedure',
      reference: 'Fictional Alpha procedure 1',
      text,
      encoding: 'utf-8',
      byteLength: Buffer.byteLength(text),
      sha256: sha256(text),
      textSpan: { start: 0, end: Buffer.byteLength(text), unit: 'utf8_byte' },
    },
    review: 'ai_drafted',
    adopted: false,
    bindingId: binding.id,
    bindingVersion: binding.version,
    bindingDigest: binding.digest,
    dependencies: ['flight.observations'],
    coverage: 'automated',
  };
  const content: Omit<RulePackVersion, 'digest'> = {
    packId: 'fictional.demo-procedures',
    version: 1,
    title: 'Fictional Alpha procedures',
    status: 'draft',
    review: 'ai_drafted',
    adopted: false,
    bindings: [binding],
    leaves: [{ ...leafContent, digest: canonicalDigest(leafContent) }],
  };
  return { ...content, digest: canonicalDigest(content) };
}

function companyPack(version = 3): RulePackVersion {
  const pack = getRulePackVersion('ledger.demo-procedures', version);
  if (!pack) throw new Error('Expected retained company procedure catalog');
  return pack;
}

function resealPack(pack: RulePackVersion): void {
  for (const binding of pack.bindings) {
    const { digest: _digest, ...content } = binding;
    binding.digest = canonicalDigest(content);
  }
  for (const leaf of pack.leaves) {
    if (leaf.coverage === 'automated') {
      const binding = pack.bindings.find(
        (entry) => entry.id === leaf.bindingId && entry.version === leaf.bindingVersion,
      );
      if (!binding) throw new Error('Fixture leaf has no retained binding');
      leaf.bindingDigest = binding.digest;
    }
    const { digest: _digest, ...content } = leaf;
    leaf.digest = canonicalDigest(content);
  }
  const { digest: _digest, ...content } = pack;
  pack.digest = canonicalDigest(content);
}

function regulatoryPack() {
  const prefix = '<html><body>Préface 航空 —\n<p>';
  const manual = 'Keep an identified safety lead available.';
  const separator = '</p>\n<p>';
  const unsupported = 'Demonstrate command-link reliability.';
  const bytes = Buffer.from(`${prefix}${manual}${separator}${unsupported}</p></body></html>`, 'utf8');
  const sourceId = 'fictional-retained-proposal.1';
  const path = `/v1/rule-sources/${sourceId}/content`;
  const document = {
    sourceId,
    url: 'https://fictional.invalid/proposed-requirements',
    sha256: sha256(bytes),
    byteLength: bytes.length,
    contentType: 'text/html; charset=utf-8' as const,
    readPath: path,
  };
  const leaves = [
    {
      id: 'fictional.manual-safety-review',
      text: manual,
      start: Buffer.byteLength(prefix),
      coverage: 'manual' as const,
    },
    {
      id: 'fictional.unsupported-command-link',
      text: unsupported,
      start: Buffer.byteLength(`${prefix}${manual}${separator}`),
      coverage: 'unsupported' as const,
    },
  ].map((entry): RulePackLeaf => {
    const content: Omit<Extract<RulePackLeaf, { coverage: 'manual' | 'unsupported' }>, 'digest'> = {
      id: entry.id,
      version: 1,
      title: entry.text,
      source: {
        kind: 'proposed_regulation',
        reference: entry.id,
        text: entry.text,
        encoding: 'utf-8',
        byteLength: Buffer.byteLength(entry.text),
        sha256: sha256(entry.text),
        textSpan: { start: entry.start, end: entry.start + Buffer.byteLength(entry.text), unit: 'utf8_byte', sourceId },
        document,
      },
      review: 'ai_drafted',
      adopted: false,
      dependencies: [],
      coverage: entry.coverage,
    };
    return { ...content, digest: canonicalDigest(content) };
  });
  const content: Omit<RulePackVersion, 'digest'> = {
    packId: 'fictional.proposed-requirements',
    version: 1,
    title: 'Fictional proposed requirements',
    status: 'draft',
    review: 'ai_drafted',
    adopted: false,
    bindings: [],
    leaves,
  };
  return { pack: { ...content, digest: canonicalDigest(content) }, bytes, path };
}

async function storedJournal(path: string): Promise<ActionJournal> {
  const envelope = JSON.parse(await readFile(path, 'utf8')) as { version: number; body: string; sha256: string };
  expect(envelope.version).toBe(1);
  expect(envelope.sha256).toBe(sha256(envelope.body));
  return JSON.parse(envelope.body) as ActionJournal;
}

async function fixture(catalog = automatedPack(), retainedSources = new Map<string, Uint8Array>()) {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-pack-adoption-'));
  directories.push(directory);
  const statePath = join(directory, 'actor.json');
  const pack = structuredClone(catalog);
  const plan: AdoptionPlan = {
    version: 1,
    apiUrl: 'http://actor.test',
    tenantId: 'tenant-alpha',
    principalId: 'fictional-alpha',
    pack: {
      packId: pack.packId,
      version: pack.version,
      digest: pack.digest,
      leaves: pack.leaves.map(({ id, version, digest }) => ({ id, version, digest })),
      bindings: pack.bindings.map(({ id, version, digest }) => ({ id, version, digest })),
    },
    effectiveInterval: { start: '2026-10-15T14:00:00.000Z', end: '2026-10-15T22:00:00.000Z' },
    note: 'Fictional Alpha adopts this exact procedure pack for the simulated operating day.',
    mode: 'active',
  };
  const principal: Principal & { kind: string } = {
    commandLinkSources: [],
    id: plan.principalId,
    tenantId: plan.tenantId,
    name: 'Fictional Alpha safety lead',
    kind: 'simulated_person',
    capabilities: ['flight:read', 'evidence:read', 'pack:adopt'],
    revision: 7,
  };
  const coverage: OrganizationCoverageResponse = {
    organization: { id: 'organization:tenant-alpha', label: 'Fictional Alpha', revision: 3, projectedRevision: 3 },
    asOf: now,
    adoptions: [],
    packOrigins: [],
    limit: 100,
    hasOlder: false,
    meta: {
      requestId: 'coverage-read',
      projectionRevision: 41,
      inputCut: {
        streams: { 'organization:tenant-alpha': 3 },
        basisRevision: 3,
        principalRevision: principal.revision,
      },
      dependencyBasis: sha256('review-basis-3'),
      computedAt: now,
      outstandingWork: 999,
    },
  };
  const document = structuredClone(openApiDocument);
  const reads: string[] = [];
  const sourceReads: string[] = [];
  const usage = { requests: 0, bytes: 0 };
  const api = {
    async json<T>(path: string): Promise<T> {
      reads.push(path);
      const pathname = new URL(path, plan.apiUrl).pathname;
      let result: unknown;
      if (pathname === '/v1/me') result = { principal, meta: coverage.meta };
      else if (pathname === '/openapi.json') result = document;
      else if (pathname === `/v1/rule-packs/${pack.packId}/versions/${pack.version}`) result = { pack };
      else if (pathname === '/v1/organization/coverage') result = coverage;
      else throw new Error(`Unexpected adoption GET ${path}`);
      usage.requests++;
      usage.bytes += Buffer.byteLength(JSON.stringify(result));
      return structuredClone(result) as T;
    },
    async bytes(path: string): Promise<Uint8Array> {
      sourceReads.push(path);
      const bytes = retainedSources.get(path);
      if (!bytes) throw new Error(`Unexpected retained regulatory source GET ${path}`);
      usage.requests++;
      usage.bytes += bytes.byteLength;
      return Uint8Array.from(bytes);
    },
    usage: () => ({ ...usage }),
  };
  function accept(
    payload: string,
    id = 'adoption-one',
    processing: 'pending' | 'projected' = 'projected',
  ): CommandResponse {
    const command = JSON.parse(payload) as PackAdoptionCommand;
    const adoption: PackAdoptionRecord = {
      id,
      organizationId: coverage.organization.id,
      acceptedRevision: command.expectedRevision + 1,
      actor: {
        id: principal.id,
        name: principal.name,
        kind: principal.kind,
        principalRevision: principal.revision,
        capabilities: [...principal.capabilities],
        checkedCapabilities: ['pack:adopt'],
        policyVersion: 'ledger.pack-adoption-authority.1',
      },
      pack: structuredClone(pack),
      scope: { kind: 'organization', organizationId: coverage.organization.id },
      effectiveInterval: structuredClone(command.effectiveInterval),
      note: command.note,
      mode: command.mode,
      renderedInputCut: structuredClone(command.inputCut),
      acceptedInputCut: structuredClone(command.inputCut),
      dependencyBasis: command.expectedDependencyBasis,
      acceptedAt: now,
      processing: { status: processing },
      state: processing === 'projected' ? 'effective' : 'pending',
      coverage: pack.leaves.map((leaf) => ({
        leafId: leaf.id,
        coverage: leaf.coverage,
        evidenceState:
          leaf.coverage === 'automated'
            ? 'inactive'
            : leaf.coverage === 'manual'
              ? 'manual_review_required'
              : 'unsupported',
      })),
    };
    coverage.adoptions = [adoption];
    coverage.organization.revision = Math.max(coverage.organization.revision, adoption.acceptedRevision);
    if (processing === 'projected') coverage.organization.projectedRevision = coverage.organization.revision;
    coverage.meta.inputCut = {
      streams: { 'organization:tenant-alpha': coverage.organization.revision },
      basisRevision: coverage.organization.revision,
      principalRevision: principal.revision,
    };
    coverage.meta.dependencyBasis = sha256(`review-basis-${coverage.organization.revision}`);
    return {
      command: {
        id,
        kind: 'rule-pack.adopt',
        actorId: principal.id,
        recordedAt: now,
        payload: JSON.parse(payload) as Record<string, unknown>,
      },
      meta: structuredClone(coverage.meta),
    };
  }
  const submit = vi.fn(async (payload: string, _key: string): Promise<CommandResponse> => accept(payload));
  return {
    plan,
    pack,
    principal,
    coverage,
    document,
    api,
    reads,
    sourceReads,
    statePath,
    submit,
    accept,
    run: () => runPackAdoption(plan, statePath, api, submit),
  };
}

describe('a retained fictional pack adoption action', () => {
  it('adopts the exact version-three C2 catalog while preserving prior catalogs and inactive evidence', async () => {
    const pack = companyPack();
    expect(pack.digest).toBe('46f777c1c391b696cffc45b450cb61b8563b28417f67ac087522b57e34e56188');
    const binding = pack.bindings.find((entry) => entry.inputKind === 'command-link.status')!;
    const leaf = pack.leaves.find((entry) => 'bindingId' in entry && entry.bindingId === binding.id)!;
    if (leaf.coverage !== 'automated') throw new Error('Expected automated company C2 procedure');
    expect(binding).toMatchObject({
      id: 'ledger.command-link-status',
      version: 1,
      inputKind: 'command-link.status',
      correctionHandling: 'immutable_receipts_selected_by_caller',
      supportedFields: [
        'sourceId',
        'sourceSessionId',
        'occurredAt',
        'subject.flightId',
        'payload.sourceEventId',
        'payload.incidentId',
        'payload.aircraftId',
        'payload.status',
      ],
    });
    const sourceBytes = Buffer.from(leaf.source.text, 'utf8');
    expect(leaf).toMatchObject({
      version: 1,
      bindingId: binding.id,
      bindingVersion: 1,
      bindingDigest: binding.digest,
      dependencies: ['command-link.reports', 'command-link.scope', 'clock.wall'],
      source: {
        kind: 'operator_procedure',
        reference: 'ledger.demo-procedures.3',
        encoding: 'utf-8',
        byteLength: sourceBytes.byteLength,
        sha256: sha256(sourceBytes),
        textSpan: { start: 0, end: sourceBytes.byteLength, unit: 'utf8_byte' },
      },
    });
    const f = await fixture(pack);
    const accepted = await f.run();
    expect(accepted).toMatchObject({ status: 'accepted', processing: 'projected', state: 'effective', attempts: 1 });
    expect(accepted.coverage).toContainEqual({
      leafId: leaf.id,
      coverage: 'automated',
      evidenceState: 'inactive',
    });
    expect(accepted.coverage!.every((entry) => entry.evidenceState === 'inactive')).toBe(true);
    const command = JSON.parse(f.submit.mock.calls[0]![0]) as PackAdoptionCommand;
    expect(command.pack).toEqual(f.plan.pack);
    expect(command.pack).toMatchObject({ packId: pack.packId, version: 3, digest: pack.digest });
    expect(f.coverage.adoptions[0]!.pack).toEqual(pack);
    expect(f.coverage.adoptions[0]!.pack.adopted).toBe(false);
    expect(f.sourceReads).toEqual([]);

    for (const version of [1, 2]) {
      const previous = await fixture(companyPack(version));
      expect((await previous.run()).status).toBe('accepted');
      const priorCommand = JSON.parse(previous.submit.mock.calls[0]![0]) as PackAdoptionCommand;
      expect(priorCommand.pack).toEqual(previous.plan.pack);
      expect(priorCommand.pack.version).toBe(version);
    }
  });

  it('waits before POST when a resealed C2 catalog changes its reviewed binding, version or source span', async () => {
    for (const change of ['binding-id', 'binding-version', 'source-span', 'pack-version'] as const) {
      const pack = companyPack();
      const binding = pack.bindings.find((entry) => entry.inputKind === 'command-link.status')!;
      const leaf = pack.leaves.find((entry) => 'bindingId' in entry && entry.bindingId === binding.id)!;
      if (leaf.coverage !== 'automated') throw new Error('Expected automated company C2 procedure');
      if (change === 'binding-id') {
        binding.id = 'ledger.command-link-status.future';
        leaf.bindingId = binding.id;
      } else if (change === 'binding-version') {
        binding.version = 2;
        leaf.bindingVersion = binding.version;
      } else if (change === 'source-span') leaf.source.textSpan.end = leaf.source.byteLength + 1;
      else pack.version = 4;
      resealPack(pack);
      const f = await fixture(pack);
      expect((await f.run()).status, change).toBe('pending');
      expect(f.submit, change).not.toHaveBeenCalled();
    }
  });

  it('replays an ambiguous version-three adoption with its original principal, journal version, bytes and key', async () => {
    const f = await fixture(companyPack());
    f.submit.mockImplementationOnce(async (payload, key) => {
      const journal = await storedJournal(f.statePath);
      expect(journal).toMatchObject({
        version: 1,
        principalId: f.plan.principalId,
        tenantId: f.plan.tenantId,
        endpoint: '/v1/commands',
        planDigest: canonicalDigest(f.plan),
      });
      expect(journal.actions).toHaveLength(1);
      expect(journal.actions[0]).toMatchObject({ payload, key, payloadSha256: sha256(payload), status: 'submitted' });
      throw new Error('Lost version-three adoption response after possible acceptance');
    });
    expect(await f.run()).toMatchObject({ status: 'pending', attempts: 1 });
    const original = f.submit.mock.calls[0]!;
    const originalJournal = await readFile(f.statePath, 'utf8');
    f.principal.id = 'different-current-principal';
    expect((await f.run()).status).toBe('pending');
    expect(f.submit).toHaveBeenCalledTimes(1);
    expect(await readFile(f.statePath, 'utf8')).toBe(originalJournal);
    f.principal.id = f.plan.principalId;
    f.coverage.organization.revision = 9;
    f.coverage.organization.projectedRevision = 9;
    f.coverage.meta.inputCut = { streams: { 'organization:tenant-alpha': 9 }, basisRevision: 9, principalRevision: 7 };
    f.coverage.meta.dependencyBasis = sha256('fresh-version-three-review-basis-9');
    expect(await f.run()).toMatchObject({ status: 'accepted', adoptionId: 'adoption-one', attempts: 1 });
    expect(f.submit.mock.calls[1]).toEqual(original);
    const retained = await storedJournal(f.statePath);
    expect(retained.version).toBe(1);
    expect(retained.principalId).toBe(f.plan.principalId);
    expect(retained.actions).toHaveLength(1);
    expect(retained.actions[0]).toMatchObject({
      payload: original[0],
      key: original[1],
      payloadSha256: sha256(original[0]),
      status: 'accepted',
      adoptionId: 'adoption-one',
    });
    const command = JSON.parse(original[0]) as PackAdoptionCommand;
    expect(command).toMatchObject({ expectedRevision: 3, pack: f.plan.pack });
    expect(command.pack.version).toBe(3);
  });

  it('waits without submitting when current authority or the served adoption command is unavailable', async () => {
    const authority = await fixture();
    authority.principal.capabilities = ['flight:read', 'evidence:read'];
    expect((await authority.run()).status).toBe('pending');
    expect(authority.submit).not.toHaveBeenCalled();

    const contract = await fixture();
    const alternatives =
      contract.document.paths['/v1/commands'].post.requestBody.content['application/json'].schema.anyOf;
    const adoption = alternatives.findIndex((schema) => schema.properties.kind.const === 'rule-pack.adopt');
    expect(adoption).toBeGreaterThanOrEqual(0);
    alternatives.splice(adoption, 1);
    expect((await contract.run()).status).toBe('pending');
    expect(contract.submit).not.toHaveBeenCalled();
  });

  it('refuses changed pack references, source content, actor identity or journal bytes before writing', async () => {
    const references = await fixture();
    references.plan.pack.leaves[0]!.digest = '0'.repeat(64);
    expect((await references.run()).status).not.toBe('accepted');
    expect(references.submit).not.toHaveBeenCalled();

    const content = await fixture();
    content.pack.leaves[0]!.source.text += ' Changed after hashing.';
    expect((await content.run()).status).not.toBe('accepted');
    expect(content.submit).not.toHaveBeenCalled();

    const retained = await fixture();
    retained.submit.mockRejectedValueOnce(new Error('Lost submission response'));
    expect((await retained.run()).status).toBe('pending');
    const bytesBeforeDrift = await readFile(retained.statePath, 'utf8');
    retained.plan.principalId = 'another-fictional-actor';
    retained.principal.id = retained.plan.principalId;
    expect((await retained.run()).status).not.toBe('accepted');
    expect(retained.submit).toHaveBeenCalledTimes(1);
    expect(await readFile(retained.statePath, 'utf8')).toBe(bytesBeforeDrift);

    const corrupt = await fixture();
    corrupt.submit.mockRejectedValueOnce(new Error('Lost submission response'));
    await corrupt.run();
    const envelope = JSON.parse(await readFile(corrupt.statePath, 'utf8')) as {
      version: number;
      body: string;
      sha256: string;
    };
    envelope.body += ' ';
    await writeFile(corrupt.statePath, JSON.stringify(envelope));
    expect((await corrupt.run()).status).not.toBe('accepted');
    expect(corrupt.submit).toHaveBeenCalledTimes(1);
  });

  it('checks retained UTF-8 regulatory source spans once and preserves manual and unsupported coverage', async () => {
    const source = regulatoryPack();
    const retained = new Map([[source.path, source.bytes]]);
    const f = await fixture(source.pack, retained);
    expect(f.plan.pack.bindings).toEqual([]);
    const accepted = await f.run();
    expect(accepted.status).toBe('accepted');
    expect(accepted.coverage).toEqual([
      { leafId: 'fictional.manual-safety-review', coverage: 'manual', evidenceState: 'manual_review_required' },
      { leafId: 'fictional.unsupported-command-link', coverage: 'unsupported', evidenceState: 'unsupported' },
    ]);
    expect(f.sourceReads).toEqual([source.path]);
    expect(f.submit).toHaveBeenCalledTimes(1);

    const changedBytes = Uint8Array.from(source.bytes);
    changedBytes[0] = changedBytes[0]! ^ 1;
    const corruptDocument = await fixture(source.pack, new Map([[source.path, changedBytes]]));
    expect((await corruptDocument.run()).status).toBe('pending');
    expect(corruptDocument.submit).not.toHaveBeenCalled();

    const changedSpan = structuredClone(source.pack);
    const leaf = changedSpan.leaves[0]!;
    leaf.source.textSpan.start = source.bytes.toString('utf8').indexOf(leaf.source.text);
    leaf.source.textSpan.end = leaf.source.textSpan.start + Buffer.byteLength(leaf.source.text);
    const { digest: _leafDigest, ...leafContent } = leaf;
    leaf.digest = canonicalDigest(leafContent);
    const { digest: _packDigest, ...packContent } = changedSpan;
    changedSpan.digest = canonicalDigest(packContent);
    const corruptSpan = await fixture(changedSpan, retained);
    expect((await corruptSpan.run()).status).toBe('pending');
    expect(corruptSpan.sourceReads).toEqual([source.path]);
    expect(corruptSpan.submit).not.toHaveBeenCalled();
  });

  it('accepts an automated checked rule that quotes a retained source span, and checks that span', async () => {
    const source = regulatoryPack();
    const quoted = source.pack.leaves[0]!;
    if (quoted.source.kind !== 'proposed_regulation') throw new Error('Expected a retained source');
    const checked = defineCheckedRule({
      id: 'fictional.checked-safety-lead',
      version: 1,
      title: 'Safety lead record held',
      source: quoted.source,
      target: { subjectKind: 'organization' },
      reads: [
        { name: 'record', type: 'operator.record', versions: [1], about: 'target', required: false, select: 'latest' },
      ],
      check: { kind: recordCompleteV2, params: { recordType: 'person.standing', recordVersion: 1 } },
    });
    const { digest: _digest, ...content } = { ...source.pack, leaves: [checked, source.pack.leaves[1]!] };
    const pack = { ...content, digest: canonicalDigest(content) };
    const f = await fixture(pack, new Map([[source.path, source.bytes]]));
    expect((await f.run()).status).toBe('accepted');
    expect(f.sourceReads).toEqual([source.path]);

    const moved = structuredClone(checked);
    moved.source.textSpan.start += 1;
    moved.source.textSpan.end += 1;
    const { digest: _movedDigest, ...movedLeaf } = moved;
    moved.digest = canonicalDigest(movedLeaf);
    const { digest: _packDigest, ...movedContent } = { ...content, leaves: [moved, source.pack.leaves[1]!] };
    const corrupt = await fixture(
      { ...movedContent, digest: canonicalDigest(movedContent) },
      new Map([[source.path, source.bytes]]),
    );
    expect((await corrupt.run()).status).toBe('pending');
    expect(corrupt.submit).not.toHaveBeenCalled();
  });

  it('persists exact submission bytes before POST and reuses their key after an ambiguous response and fresh read basis', async () => {
    const f = await fixture();
    f.submit.mockImplementationOnce(async (payload, key) => {
      const journal = await storedJournal(f.statePath);
      expect(journal).toMatchObject({
        principalId: f.plan.principalId,
        tenantId: f.plan.tenantId,
        endpoint: '/v1/commands',
        planDigest: canonicalDigest(f.plan),
      });
      expect(journal.actions).toHaveLength(1);
      expect(journal.actions[0]).toMatchObject({ payload, key, payloadSha256: sha256(payload), status: 'submitted' });
      throw new Error('Network failed after possible acceptance');
    });
    const pending = await f.run();
    expect(pending).toMatchObject({ status: 'pending', attempts: 1 });
    const original = f.submit.mock.calls[0]!;
    f.coverage.organization.revision = 9;
    f.coverage.organization.projectedRevision = 9;
    f.coverage.meta.inputCut = { streams: { 'organization:tenant-alpha': 9 }, basisRevision: 9, principalRevision: 7 };
    f.coverage.meta.dependencyBasis = sha256('fresh-review-basis-9');
    const resumed = await f.run();
    expect(resumed).toMatchObject({ status: 'accepted', adoptionId: 'adoption-one', attempts: 1 });
    expect(f.submit.mock.calls[1]).toEqual(original);
    const sent = JSON.parse(original[0]) as PackAdoptionCommand;
    expect(sent).toMatchObject({
      kind: 'rule-pack.adopt',
      expectedRevision: 3,
      pack: f.plan.pack,
      effectiveInterval: f.plan.effectiveInterval,
      note: f.plan.note,
      mode: f.plan.mode,
    });
    expect((await storedJournal(f.statePath)).actions[0]).toMatchObject({
      status: 'accepted',
      adoptionId: 'adoption-one',
    });
  });

  it('retains a definitive stale-basis rejection and creates a fresh reviewed action on the next invocation', async () => {
    const f = await fixture();
    f.submit.mockRejectedValueOnce(
      new ApiError(409, { error: { code: 'stale_basis', message: 'Refresh organization basis' } }),
    );
    const rejected = await f.run();
    expect(rejected).toMatchObject({ status: 'rejected', attempts: 1 });
    expect((await storedJournal(f.statePath)).actions[0]).toMatchObject({
      status: 'rejected',
      rejection: { status: 409, code: 'stale_basis' },
    });
    f.coverage.organization.revision = 4;
    f.coverage.organization.projectedRevision = 4;
    f.coverage.meta.inputCut = { streams: { 'organization:tenant-alpha': 4 }, basisRevision: 4, principalRevision: 7 };
    f.coverage.meta.dependencyBasis = sha256('fresh-review-basis-4');
    const reviewedCut = structuredClone(f.coverage.meta.inputCut);
    const reviewedBasis = f.coverage.meta.dependencyBasis;
    expect((await f.run()).status).toBe('accepted');
    const [first, second] = f.submit.mock.calls;
    expect(second![1]).not.toBe(first![1]);
    expect(JSON.parse(first![0])).toMatchObject({ expectedRevision: 3 });
    expect(JSON.parse(second![0])).toMatchObject({
      expectedRevision: 4,
      inputCut: reviewedCut,
      expectedDependencyBasis: reviewedBasis,
      pack: f.plan.pack,
    });
    expect((await storedJournal(f.statePath)).actions.map((action) => action.status)).toEqual(['rejected', 'accepted']);
  });

  it('keeps confirmed acceptance through pending projection, effective coverage and omission from a bounded coverage read without resubmitting', async () => {
    const f = await fixture();
    f.submit.mockImplementationOnce(async (payload) => f.accept(payload, 'adoption-one', 'pending'));
    const pending = await f.run();
    expect(pending).toMatchObject({
      status: 'pending',
      adoptionId: 'adoption-one',
      processing: 'pending',
      state: 'pending',
      attempts: 1,
    });
    expect(
      f.reads.filter((path) => new URL(path, f.plan.apiUrl).pathname === '/v1/organization/coverage').length,
    ).toBeLessThanOrEqual(4);
    const record = f.coverage.adoptions[0]!;
    record.processing.status = 'projected';
    record.state = 'effective';
    f.coverage.organization.projectedRevision = f.coverage.organization.revision;
    const effective = await f.run();
    expect(effective).toMatchObject({
      status: 'accepted',
      adoptionId: 'adoption-one',
      processing: 'projected',
      state: 'effective',
      attempts: 1,
    });
    expect(effective.coverage).toEqual([
      { leafId: f.pack.leaves[0]!.id, coverage: 'automated', evidenceState: 'inactive' },
    ]);
    expect(f.submit).toHaveBeenCalledTimes(1);

    record.actor.id = 'another-fictional-actor';
    expect(await f.run()).toMatchObject({ status: 'pending', code: 'coverage_mismatch', adoptionId: 'adoption-one' });
    expect(f.submit).toHaveBeenCalledTimes(1);
    record.actor.id = f.plan.principalId;

    f.coverage.adoptions = Array.from({ length: 100 }, (_, index) => {
      const end = Date.parse(f.plan.effectiveInterval.start) - (index + 1) * 86_400_000;
      return {
        ...structuredClone(record),
        id: `other-adoption-${index}`,
        state: 'expired' as const,
        effectiveInterval: { start: new Date(end - 8 * 60 * 60_000).toISOString(), end: new Date(end).toISOString() },
      };
    });
    f.coverage.hasOlder = true;
    const omitted = await f.run();
    expect(omitted).toMatchObject({ status: 'pending', adoptionId: 'adoption-one', attempts: 1 });
    expect(f.submit).toHaveBeenCalledTimes(1);
    expect((await storedJournal(f.statePath)).actions[0]).toMatchObject({
      status: 'accepted',
      adoptionId: 'adoption-one',
    });
  });

  it('allows the exact served OpenAPI read while rejecting neighboring and traversing paths before fetch', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({}));
    const api = new OracleApi('http://actor.test', 'fictional-read-token', {}, fetcher);
    await api.json('/openapi.json');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]![0])).toBe('http://actor.test/openapi.json');
    for (const path of [
      '/openapi.json?x=1',
      '/openapi.json/extra',
      '/other',
      '/v1/../openapi.json',
      '/v1/%2e%2e/openapi.json',
    ]) {
      await expect(api.json(path)).rejects.toThrow();
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
