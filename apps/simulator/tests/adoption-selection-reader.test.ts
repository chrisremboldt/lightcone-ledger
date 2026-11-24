import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalDigest, sha256 } from '@ledger/integrity';
import type { FlightRuleSelectionResponse, PackAdoptionCommand, Principal } from '@ledger/contracts';
import { openApiDocument } from '../../../packages/contracts/src/openapi.js';
import {
  FlightRuleSelectionRecordV1Schema,
  FlightRuleSelectionRecordV2Schema,
} from '../../../packages/contracts/src/rule-selection.js';
import {
  ruleSelectionEligible,
  ruleSelectionExpired,
  ruleSelectionPending,
  ruleSelectionRead,
  ruleSelectionScheduled,
} from '../../../packages/contracts/fixtures/demo/v1/rule-selection.js';
import {
  adoptedCommandLinkSelection,
  commandLinkEvaluator,
  expiredCommandLinkSelection,
} from '../../../packages/contracts/fixtures/demo/v1/c2-execution.js';
import { getRulePackVersion } from '../../../packages/domain/src/rule-pack-registry.js';
import { readAdoptionSelection } from '../src/adoption-selection-reader.js';
import type { ActionJournal } from '../src/pack-adoption-journal.js';
import type { AdoptionPlan } from '../src/pack-adoption-review.js';

const directories: string[] = [];
const flightId = ruleSelectionRead.id;
const targetPath = `/v1/flights/${flightId}/rule-selection`;
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

function recommit(response: FlightRuleSelectionResponse): void {
  const retained = response.selection;
  if (!retained) return;
  const {
    version,
    flightId,
    organizationId,
    adoptionRevision,
    projectedAdoptionRevision,
    selection,
    execution,
    nextBoundary,
  } = retained;
  retained.selectionDigest = canonicalDigest({
    version,
    flightId,
    organizationId,
    adoptionRevision,
    projectedAdoptionRevision,
    selection,
    execution,
    nextBoundary,
  });
  retained.dependencyBasis = canonicalDigest(retained.basisManifest);
}

function serveVersionedSelectionUnion(document: typeof openApiDocument, keyword: 'anyOf' | 'oneOf'): void {
  const properties =
    document.paths['/v1/flights/{id}/rule-selection'].get.responses[200].content['application/json'].schema.properties;
  const legacy = structuredClone(FlightRuleSelectionRecordV1Schema);
  const current = structuredClone(FlightRuleSelectionRecordV2Schema);
  Reflect.set(properties, 'selection', {
    anyOf: [{ [keyword]: [current, legacy] }, { type: 'null' }],
  });
}

function serveSelectionVersion(document: typeof openApiDocument, version: 1 | 2): void {
  const properties =
    document.paths['/v1/flights/{id}/rule-selection'].get.responses[200].content['application/json'].schema.properties;
  const record = version === 1 ? FlightRuleSelectionRecordV1Schema : FlightRuleSelectionRecordV2Schema;
  Reflect.set(properties, 'selection', { anyOf: [structuredClone(record), { type: 'null' }] });
}

function versionTwoResponse(template: typeof ruleSelectionEligible): FlightRuleSelectionResponse {
  const response: FlightRuleSelectionResponse = structuredClone(template);
  if (template.selection.selection.state === 'eligible') {
    response.selection = structuredClone(adoptedCommandLinkSelection);
  } else if (template.selection.selection.state === 'expired') {
    response.selection = structuredClone(expiredCommandLinkSelection);
  } else {
    response.selection = {
      ...structuredClone(template.selection),
      version: 'flight.rule-selection.2',
      execution: structuredClone(expiredCommandLinkSelection.execution),
    };
  }
  response.asOf = response.selection.clock.evaluatedAt;
  recommit(response);
  return response;
}

async function fixture(template: FlightRuleSelectionResponse = ruleSelectionEligible) {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-adoption-selection-'));
  directories.push(directory);
  const statePath = join(directory, 'adoption.json');
  const response = structuredClone(template);
  const adoption = response.selection!.selection.adoption!;
  const pack = getRulePackVersion('ledger.demo-procedures', 3)!;
  const plan: AdoptionPlan = {
    version: 1,
    apiUrl: 'http://selection.test',
    tenantId: 'fixture-tenant',
    principalId: 'fictional-selection-reader',
    pack: {
      packId: pack.packId,
      version: pack.version,
      digest: pack.digest,
      leaves: pack.leaves.map(({ id, version, digest }) => ({ id, version, digest })),
      bindings: pack.bindings.map(({ id, version, digest }) => ({ id, version, digest })),
    },
    effectiveInterval: {
      start: new Date(adoption.effectiveInterval.start).toISOString(),
      end: new Date(adoption.effectiveInterval.end).toISOString(),
    },
    note: 'Retain this exact company C2 adoption for inspection on the selected flight.',
    mode: 'active',
  };
  adoption.effectiveInterval = structuredClone(plan.effectiveInterval);
  if (response.selection!.nextBoundary) {
    response.selection!.nextBoundary!.at =
      response.selection!.nextBoundary!.kind === 'start' ? plan.effectiveInterval.start : plan.effectiveInterval.end;
  }
  recommit(response);
  const principal: Principal = {
    id: plan.principalId,
    tenantId: plan.tenantId,
    name: 'Fictional selection reader',
    revision: 9,
    capabilities: ['flight:read'],
    commandLinkSources: [],
  };
  response.meta.inputCut = {
    streams: { 'fresh-response-stream': 27 },
    basisRevision: 42,
    principalRevision: principal.revision,
  };
  response.meta.dependencyBasis = sha256('fresh-response-basis-distinct-from-retained-worker');
  response.meta.projectionRevision = 71;
  response.meta.outstandingWork = 999;
  const command: PackAdoptionCommand = {
    kind: 'rule-pack.adopt',
    expectedRevision: 1,
    inputCut: {
      streams: { 'organization:fixture-tenant': 1 },
      basisRevision: 1,
      principalRevision: principal.revision,
    },
    expectedDependencyBasis: sha256('retained-adoption-basis'),
    pack: structuredClone(plan.pack),
    effectiveInterval: structuredClone(plan.effectiveInterval),
    note: plan.note,
    mode: plan.mode,
  };
  const payload = JSON.stringify(command);
  const journal: ActionJournal = {
    version: 1,
    planDigest: canonicalDigest(plan),
    principalId: plan.principalId,
    tenantId: plan.tenantId,
    endpoint: '/v1/commands',
    actions: [
      {
        key: 'simulator:pack-adopt:retained-selection-fixture',
        payload,
        payloadSha256: sha256(payload),
        status: 'accepted',
        adoptionId: adoption.id,
      },
    ],
  };
  let savedBytes = '';
  const save = async () => {
    const body = JSON.stringify(journal);
    savedBytes = JSON.stringify({ version: 1, body, sha256: sha256(body) }) + '\n';
    await writeFile(statePath, savedBytes, { mode: 0o600 });
  };
  await save();
  const document = structuredClone(openApiDocument);
  const reads: string[] = [];
  const byteReads: string[] = [];
  const usage = { requests: 0, bytes: 0 };
  const api = {
    async json<T>(path: string): Promise<T> {
      reads.push(path);
      let value: unknown;
      if (path === '/openapi.json') value = document;
      else if (path === '/v1/me') value = { principal, meta: response.meta };
      else if (path === targetPath) value = response;
      else throw new Error(`Unexpected adoption-selection GET ${path}`);
      usage.requests++;
      usage.bytes += Buffer.byteLength(JSON.stringify(value));
      return structuredClone(value) as T;
    },
    async bytes(path: string): Promise<Uint8Array> {
      byteReads.push(path);
      throw new Error(`Adoption selection must not download or submit evidence: ${path}`);
    },
    usage: () => ({ ...usage }),
  };
  return {
    plan,
    statePath,
    response,
    principal,
    journal,
    document,
    api,
    reads,
    byteReads,
    save,
    run: () => readAdoptionSelection(plan, statePath, flightId, api),
    async untouched() {
      expect(await readFile(statePath, 'utf8')).toBe(savedBytes);
      expect(await readdir(directory)).toEqual(['adoption.json']);
      expect(byteReads).toEqual([]);
    },
  };
}

describe('read-only retained adoption selection', () => {
  it('matches retained v1 and reviewed v2 selections through nested version unions without changing the accepted journal', async () => {
    for (const template of [
      ruleSelectionScheduled,
      ruleSelectionEligible,
      ruleSelectionExpired,
      versionTwoResponse(ruleSelectionScheduled),
      versionTwoResponse(ruleSelectionEligible),
      versionTwoResponse(ruleSelectionExpired),
    ]) {
      const f = await fixture(template);
      if (template.selection?.selection.state === 'eligible') {
        if (template.selection.version === 'flight.rule-selection.2') serveSelectionVersion(f.document, 2);
        else serveVersionedSelectionUnion(f.document, 'anyOf');
      }
      if (template.selection?.selection.state === 'expired') serveVersionedSelectionUnion(f.document, 'oneOf');
      const retained = f.response.selection!;
      const result = await f.run();
      expect(result).toMatchObject({
        status: 'match',
        kind: 'flight-rule-selection',
        adoptionId: 'resolved-company-v3-adoption',
        acceptedRevision: 2,
        asOf: f.response.asOf,
        convergence: f.response.convergence,
        execution: retained.execution,
        retained: {
          id: retained.id,
          clock: retained.clock,
          selection: retained.selection,
          adoptionRevision: retained.adoptionRevision,
          projectedAdoptionRevision: retained.projectedAdoptionRevision,
          nextBoundary: retained.nextBoundary,
          selectionDigest: retained.selectionDigest,
          dependencyBasis: retained.dependencyBasis,
        },
      });
      if (retained.version === 'flight.rule-selection.2') {
        expect(result.execution).toEqual({
          status: retained.selection.state === 'eligible' ? 'active' : 'inactive',
          baseline: 'builtin_draft',
          policyVersion: 'ledger.company-c2-execution.1',
          evaluator: commandLinkEvaluator,
        });
      } else expect(result.execution).toEqual({ status: 'inactive', baseline: 'builtin_draft' });
      expect(f.principal.capabilities).toEqual(['flight:read']);
      expect(f.reads).toHaveLength(3);
      expect(new Set(f.reads.slice(0, 2))).toEqual(new Set(['/openapi.json', '/v1/me']));
      expect(f.reads[2]).toBe(targetPath);
      await f.untouched();
    }
  });

  it('waits for bootstrap, boundary convergence, pending adoption projection or a different selected candidate', async () => {
    const bootstrap = await fixture();
    bootstrap.response.selection = null;
    bootstrap.response.convergence = { status: 'pending', reason: 'bootstrap' };
    expect((await bootstrap.run()).status).toBe('pending');
    await bootstrap.untouched();

    const stale = await fixture(ruleSelectionScheduled);
    stale.response.asOf = '2026-10-15T14:06:00Z';
    stale.response.convergence = { status: 'pending', reason: 'boundary_due' };
    expect((await stale.run()).status).toBe('pending');
    await stale.untouched();

    const retainedActive = await fixture(versionTwoResponse(ruleSelectionEligible));
    retainedActive.response.asOf = retainedActive.plan.effectiveInterval.end;
    retainedActive.response.convergence = { status: 'pending', reason: 'boundary_due' };
    expect(await retainedActive.run()).toMatchObject({
      status: 'pending',
      execution: { status: 'active', evaluator: commandLinkEvaluator },
      convergence: { status: 'pending', reason: 'boundary_due' },
      retained: {
        clock: retainedActive.response.selection!.clock,
        selection: { state: 'eligible' },
      },
    });
    await retainedActive.untouched();

    const projection = await fixture(ruleSelectionPending);
    expect((await projection.run()).status).toBe('pending');
    await projection.untouched();

    const pendingExecution = await fixture(versionTwoResponse(ruleSelectionPending));
    expect(await pendingExecution.run()).toMatchObject({
      status: 'pending',
      execution: { status: 'inactive', evaluator: commandLinkEvaluator },
      retained: { selection: { state: 'pending' }, adoptionRevision: 2, projectedAdoptionRevision: 1 },
    });
    await pendingExecution.untouched();

    const other = await fixture();
    const retained = other.response.selection!;
    retained.selection.adoption!.id = 'another-company-v3-adoption';
    retained.selection.adoption!.acceptedRevision = 3;
    retained.adoptionRevision = 3;
    retained.projectedAdoptionRevision = 3;
    retained.nextBoundary!.adoptionId = retained.selection.adoption!.id;
    for (const frontier of retained.basisManifest.frontiers) {
      if (frontier.subjectId === retained.organizationId) {
        frontier.sequence = 3;
        frontier.projectedSequence = 3;
        retained.renderedInputCut.streams[frontier.streamId] = 3;
        retained.acceptedInputCut.streams[frontier.streamId] = 3;
      }
    }
    recommit(other.response);
    expect((await other.run()).status).toBe('pending');
    await other.untouched();
  });

  it('fails closed on unsupported versions or execution, foreign provenance and broken selection or basis commitments', async () => {
    const unadvertised = await fixture(versionTwoResponse(ruleSelectionEligible));
    serveSelectionVersion(unadvertised.document, 1);
    expect((await unadvertised.run()).status).toBe('unverifiable');
    expect(unadvertised.reads).toContain(targetPath);
    await unadvertised.untouched();

    const future = await fixture();
    serveVersionedSelectionUnion(future.document, 'anyOf');
    Reflect.set(future.response.selection!, 'version', 'flight.rule-selection.3');
    recommit(future.response);
    expect((await future.run()).status).toBe('unverifiable');
    expect(future.reads).toContain(targetPath);
    await future.untouched();

    const active = await fixture();
    Reflect.set(active.response.selection!.execution, 'status', 'active');
    recommit(active.response);
    expect((await active.run()).status).toBe('unverifiable');
    await active.untouched();

    const unknownEvaluator = await fixture(versionTwoResponse(ruleSelectionEligible));
    Reflect.set(unknownEvaluator.response.selection!.execution, 'evaluator', {
      ...commandLinkEvaluator,
      digest: sha256('unreviewed-evaluator'),
    });
    recommit(unknownEvaluator.response);
    expect((await unknownEvaluator.run()).status).toBe('unverifiable');
    await unknownEvaluator.untouched();

    const unknownPolicy = await fixture(versionTwoResponse(ruleSelectionEligible));
    Reflect.set(unknownPolicy.response.selection!.execution, 'policyVersion', 'ledger.company-c2-execution.2');
    recommit(unknownPolicy.response);
    expect((await unknownPolicy.run()).status).toBe('unverifiable');
    await unknownPolicy.untouched();

    const activePending = await fixture(versionTwoResponse(ruleSelectionPending));
    activePending.response.selection!.execution.status = 'active';
    recommit(activePending.response);
    expect((await activePending.run()).status).toBe('unverifiable');
    await activePending.untouched();

    const references = await fixture(versionTwoResponse(ruleSelectionEligible));
    references.response.selection!.selection.adoption!.binding.digest = sha256('unreviewed-c2-binding');
    recommit(references.response);
    expect((await references.run()).status).toBe('unverifiable');
    await references.untouched();

    const provenance = await fixture();
    provenance.response.selection!.basisManifest.subjectId = 'different-flight';
    recommit(provenance.response);
    expect((await provenance.run()).status).toBe('unverifiable');
    await provenance.untouched();

    const content = await fixture();
    content.response.selection!.selectionDigest = '0'.repeat(64);
    expect((await content.run()).status).toBe('unverifiable');
    await content.untouched();
    const basis = await fixture();
    basis.response.selection!.dependencyBasis = '0'.repeat(64);
    expect((await basis.run()).status).toBe('unverifiable');
    await basis.untouched();
  });

  it('stops before the flight read when accepted local evidence, read authority or the served route is unavailable', async () => {
    const unaccepted = await fixture();
    unaccepted.journal.actions[0]!.status = 'submitted';
    delete unaccepted.journal.actions[0]!.adoptionId;
    await unaccepted.save();
    expect((await unaccepted.run()).status).toBe('pending');
    expect(unaccepted.reads).not.toContain(targetPath);
    await unaccepted.untouched();

    const authority = await fixture();
    authority.principal.capabilities = [];
    expect((await authority.run()).status).toBe('pending');
    expect(authority.reads).not.toContain(targetPath);
    await authority.untouched();

    const contract = await fixture();
    Reflect.deleteProperty(contract.document.paths, '/v1/flights/{id}/rule-selection');
    expect((await contract.run()).status).toBe('pending');
    expect(contract.reads).not.toContain(targetPath);
    await contract.untouched();

    const foreign = await fixture();
    foreign.principal.tenantId = 'different-tenant';
    expect((await foreign.run()).status).not.toBe('match');
    expect(foreign.reads).not.toContain(targetPath);
    await foreign.untouched();
  });
});
