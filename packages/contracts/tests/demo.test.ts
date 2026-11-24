import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { PartnerOrderAdapter, digest } from '../../adapters/src/index.js';
import { LedgerClient } from '../src/client.js';
import {
  CommandSchema,
  FlightCreateSchema,
  InputSchema,
  ReceiptKindSchema,
  OrderQuerySchema,
  ReceiptQuerySchema,
  RulePackVersionParamsSchema,
  ProposedCommandLinkInputSchema,
  ProposedCommandLinkSourceSchema,
  DecisionPacketCreateSchema,
  DecisionPacketQuerySchema,
  FlightRuleSelectionParamsSchema,
  FlightRuleSelectionRecordParamsSchema,
  FlightRuleSelectionRecordResponseSchema,
  FlightRuleSelectionRecordV1Schema,
  FlightRuleSelectionRecordV2Schema,
  DecisionPacketRecordSchema,
  DECISION_PACKET_V2_LIMITS,
} from '../src/index.js';
import {
  openApiDocument,
  ReceiptSchema,
  FindingRecordSchema,
  FlightRuleSelectionResponseSchema,
  EvaluationRecordSchema,
} from '../src/openapi.js';
import { canonicalDigest } from '../../integrity/src/index.js';
import manifest from '../fixtures/demo/manifest.json' with { type: 'json' };
import {
  acceptedReceipt,
  adoptShownPack,
  reviewShownAdoption,
  awaitingFlightOrdersQuery,
  completedReceipt,
  decision,
  findingTreatmentDecision,
  deliveryCases,
  draftAuthorizationPackRead,
  draftProcedurePackRead,
  identity,
  landing,
  lateLanding,
  orderInput,
  partnerOrder,
  reportedAuthorization,
  nprmPackRead,
  unlinkedEvidenceQuery,
  ruleSelectionRead,
  ruleSelectionScheduled,
  ruleSelectionEligible,
  ruleSelectionExpired,
  ruleSelectionPending,
} from '../fixtures/demo/v1/ready.js';
import {
  commandLink,
  mission,
  site,
  proposedCommandLinkLoss,
  proposedCommandLinkRestoration,
  commandLinkLossSource,
  commandLinkRestorationSource,
} from '../fixtures/demo/v1/proposed.js';
import {
  authorizeLinkStatusSource,
  commandLinkLossObservation,
  commandLinkRestorationObservation,
} from '../fixtures/demo/v1/command-link.js';
import { commandLinkProcedurePackRead, restoredCommandLinkFinding } from '../fixtures/demo/v1/command-link-findings.js';
import { getRulePackVersion } from '../../domain/src/rule-pack-registry.js';
import {
  commandLinkDecisionPacketCreate,
  commandLinkDecisionPacketQuery,
  commandLinkExecutionPacketSelection,
} from '../fixtures/demo/v1/decision-packets.js';
import {
  adoptedCommandLinkFinding,
  adoptedCommandLinkSelection,
  commandLinkEvaluator,
  draftCommandLinkFinding,
  expiredCommandLinkFinding,
  expiredCommandLinkSelection,
} from '../fixtures/demo/v1/c2-execution.js';
import {
  ruleSelectionRecordRead,
  ruleSelectionRecordV1,
  ruleSelectionRecordV2,
} from '../fixtures/demo/v1/rule-selection.js';

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);

describe('versioned simulator handoff', () => {
  it('pins prospective C2 execution while preserving one finding and legacy records', () => {
    const finding = ajv.compile(FindingRecordSchema);
    const evaluation = ajv.compile(EvaluationRecordSchema);
    for (const shown of [draftCommandLinkFinding, adoptedCommandLinkFinding, expiredCommandLinkFinding]) {
      expect(finding(shown), JSON.stringify(finding.errors)).toBe(true);
      expect(shown.id).toBe(draftCommandLinkFinding.id);
      expect(shown.initialEvaluation).toEqual(draftCommandLinkFinding.initialEvaluation);
      expect(shown.owner).toEqual(draftCommandLinkFinding.owner);
      expect(shown.treatments).toEqual(draftCommandLinkFinding.treatments);
    }
    const v1 = ajv.compile(FlightRuleSelectionRecordV1Schema);
    const v2 = ajv.compile(FlightRuleSelectionRecordV2Schema);
    expect(v1(ruleSelectionEligible.selection), JSON.stringify(v1.errors)).toBe(true);
    for (const selected of [adoptedCommandLinkSelection, expiredCommandLinkSelection]) {
      expect(v2(selected), JSON.stringify(v2.errors)).toBe(true);
      const {
        version,
        flightId,
        organizationId,
        adoptionRevision,
        projectedAdoptionRevision,
        selection,
        execution,
        nextBoundary,
      } = selected;
      expect(selected.selectionDigest).toBe(
        canonicalDigest({
          version,
          flightId,
          organizationId,
          adoptionRevision,
          projectedAdoptionRevision,
          selection,
          execution,
          nextBoundary,
        }),
      );
      expect(v1(selected)).toBe(false);
    }
    const pack = getRulePackVersion('ledger.demo-procedures', 3)!;
    const reference = ({ id, version, digest }: { id: string; version: number; digest: string }) => ({
      id,
      version,
      digest,
    });
    expect(commandLinkEvaluator.digest).toBe(
      canonicalDigest({
        id: commandLinkEvaluator.id,
        version: 1,
        algorithm: 'reported-command-link-evidence.1',
        clock: 'wall',
        leaf: reference(
          pack.leaves.find((item) => 'bindingId' in item && item.bindingId === 'ledger.command-link-status')!,
        ),
        binding: reference(pack.bindings.find((item) => item.id === 'ledger.command-link-status')!),
      }),
    );
    const adopted = adoptedCommandLinkFinding.latestEvaluation;
    const { profile: _profile, ...missingProfile } = adopted;
    const { execution: _execution, ...missingExecution } = adopted;
    expect(evaluation(missingProfile)).toBe(false);
    expect(evaluation(missingExecution)).toBe(false);
    expect(expiredCommandLinkFinding.latestEvaluation.execution.mode).toBe('builtin_draft');
    expect(expiredCommandLinkFinding.latestEvaluation.execution.adoption).toEqual(adopted.execution.adoption);
    expect(commandLinkExecutionPacketSelection).toMatchObject({
      selectionId: adopted.execution.selection.id,
      selectionDigest: adopted.execution.selection.digest,
      evaluator: adopted.execution.evaluator,
      adoptionId: adopted.execution.adoption!.id,
    });
    const record = {
      id: 'selected-packet-v2',
      format: 'ledger.decision-packet.2',
      tenantId: 'fixture-tenant',
      flightId: adoptedCommandLinkFinding.flightId,
      decisionId: commandLinkExecutionPacketSelection.decisionId,
      issuedBy: 'resolved-operator',
      issuedAt: adopted.recordedAt,
      byteLength: 1024,
      packetSha256: 'a'.repeat(64),
      manifestDigest: 'b'.repeat(64),
      scope: 'selected_c2_finding_treatment_records',
      counts: { events: 5, receipts: 1, artifacts: 1, artifactBytes: 100 },
      limits: DECISION_PACKET_V2_LIMITS,
    };
    const metadata = ajv.compile(DecisionPacketRecordSchema);
    expect(metadata(record), JSON.stringify(metadata.errors)).toBe(true);
    expect(metadata({ ...record, format: 'ledger.decision-packet.1' })).toBe(false);
  });
  it('retains versioned C2 selections and reads exact historical records separately from current state', async () => {
    const params = ajv.compile(FlightRuleSelectionParamsSchema);
    expect(params(ruleSelectionRead), JSON.stringify(params.errors)).toBe(true);
    const validate = ajv.compile(FlightRuleSelectionResponseSchema);
    const pack = getRulePackVersion('ledger.demo-procedures', 3)!;
    for (const shown of [ruleSelectionScheduled, ruleSelectionEligible, ruleSelectionExpired, ruleSelectionPending]) {
      expect(validate(shown), JSON.stringify(validate.errors)).toBe(true);
      const retained = shown.selection!;
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
      const reference = ({ id, version, digest }: { id: string; version: number; digest: string }) => ({
        id,
        version,
        digest,
      });
      expect(selection.adoption).toMatchObject({
        pack: { id: pack.packId, version: pack.version, digest: pack.digest },
        leaf: reference(
          pack.leaves.find((leaf) => 'bindingId' in leaf && leaf.bindingId === 'ledger.command-link-status')!,
        ),
        binding: reference(pack.bindings.find((binding) => binding.id === 'ledger.command-link-status')!),
      });
      expect(retained.selectionDigest).toBe(
        canonicalDigest({
          version,
          flightId,
          organizationId,
          adoptionRevision,
          projectedAdoptionRevision,
          selection,
          execution,
          nextBoundary,
        }),
      );
      expect(retained.dependencyBasis).toBe(canonicalDigest(retained.basisManifest));
    }
    const pending = ruleSelectionPending.selection!;
    expect(pending.nextBoundary).toEqual({
      at: pending.selection.adoption!.effectiveInterval.start,
      adoptionId: pending.selection.adoption!.id,
      kind: 'start',
    });
    expect(
      validate({
        ...ruleSelectionPending,
        selection: null,
        convergence: { status: 'pending', reason: 'bootstrap' },
      }),
    ).toBe(true);
    expect(
      validate({
        ...ruleSelectionEligible,
        selection: { ...ruleSelectionEligible.selection, execution: { status: 'active', baseline: 'builtin_draft' } },
      }),
    ).toBe(false);
    const paths: string[] = [];
    const client = new LedgerClient('http://ledger.invalid', 'fixture-token', async (url) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      return Response.json(path.endsWith('/rule-selection') ? ruleSelectionEligible : ruleSelectionRecordV1);
    });
    expect(await client.ruleSelection(ruleSelectionRead.id)).toEqual(ruleSelectionEligible);
    const recordParams = ajv.compile(FlightRuleSelectionRecordParamsSchema);
    expect(recordParams(ruleSelectionRecordRead), JSON.stringify(recordParams.errors)).toBe(true);
    const recordResponse = ajv.compile(FlightRuleSelectionRecordResponseSchema);
    for (const retained of [ruleSelectionRecordV1, ruleSelectionRecordV2]) {
      expect(recordResponse(retained), JSON.stringify(recordResponse.errors)).toBe(true);
      expect(recordResponse({ ...retained, convergence: { status: 'current', reason: null } })).toBe(false);
    }
    expect(recordResponse({ selection: null })).toBe(false);
    expect(ruleSelectionRecordV1.selection).toEqual(ruleSelectionEligible.selection);
    expect(ruleSelectionRecordV2.selection.execution).toEqual(adoptedCommandLinkSelection.execution);
    expect(await client.ruleSelectionRecord(ruleSelectionRecordRead.id, ruleSelectionRecordRead.selectionId)).toEqual(
      ruleSelectionRecordV1,
    );
    expect(paths).toEqual([
      `/v1/flights/${ruleSelectionRead.id}/rule-selection`,
      `/v1/flights/${ruleSelectionRecordRead.id}/rule-selections/${ruleSelectionRecordRead.selectionId}`,
    ]);
  });
  it('keeps selected C2 packets separate from chain exports', async () => {
    for (const [schema, example] of [
      [DecisionPacketCreateSchema, commandLinkDecisionPacketCreate],
      [DecisionPacketQuerySchema, commandLinkDecisionPacketQuery],
    ] as const) {
      const validate = ajv.compile(schema);
      expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
      expect(validate({ ...example, scope: 'whole_tenant_prefixes' })).toBe(false);
    }
    const paths: string[] = [];
    const client = new LedgerClient('http://ledger.invalid', 'fixture-token', async (input) => {
      paths.push(String(input));
      return new Response(
        JSON.stringify({ record: { format: 'ledger.decision-packet.1' }, requestId: 'packet-read' }),
        { headers: { 'content-type': 'application/json' } },
      );
    });
    await client.createDecisionPacket(commandLinkDecisionPacketCreate, 'packet-fixture');
    expect(paths).toEqual(['http://ledger.invalid/v1/decision-packets']);
    expect(openApiDocument.paths).toHaveProperty('/v1/decision-packets');
  });
  it('keeps a restored command-link review open with typed original and latest evidence', () => {
    const validate = ajv.compile(FindingRecordSchema);
    expect(validate(restoredCommandLinkFinding), JSON.stringify(validate.errors)).toBe(true);
    const pack = getRulePackVersion(commandLinkProcedurePackRead.packId, commandLinkProcedurePackRead.version)!;
    expect(pack.leaves.some((leaf) => leaf.id === restoredCommandLinkFinding.latestEvaluation.leafId)).toBe(true);
    expect(restoredCommandLinkFinding).toMatchObject({
      status: 'acknowledged',
      initialEvaluation: { evidenceState: 'insufficient', outcome: 'attention' },
      latestEvaluation: { evidenceState: 'supported', outcome: 'pass', explanation: { kind: 'command_link' } },
    });
  });
  it('defines exact command-link source mapping and explicit scoped authority', async () => {
    const proposed = ajv.compile(ProposedCommandLinkInputSchema);
    const original = ajv.compile(ProposedCommandLinkSourceSchema);
    const enabled = ajv.compile(InputSchema);
    for (const [input, source] of [
      [proposedCommandLinkLoss, commandLinkLossSource],
      [proposedCommandLinkRestoration, commandLinkRestorationSource],
    ] as const) {
      expect(proposed(input), JSON.stringify(proposed.errors)).toBe(true);
      expect(original(source), JSON.stringify(original.errors)).toBe(true);
      // The retired intake no longer accepts this input kind; records of its shape stay in retained evidence.
      expect(enabled(input)).toBe(false);
      const { sourceSessionId, occurredAt, ...payload } = source;
      expect({ sourceSessionId, occurredAt, payload }).toEqual({
        sourceSessionId: input.sourceSessionId,
        occurredAt: input.occurredAt,
        payload: input.payload,
      });
    }
    expect(manifest.extensions.commandLinkStatus).toMatchObject({
      implementation: 'ready',
      review: 'simulator_reviewed',
      proposalReview: 'simulator_reviewed',
      intake: false,
      kind: 'observation',
    });
    const grant = authorizeLinkStatusSource(
      { id: 'link-source', revision: 1, capabilities: ['input:write'], observationGrants: [] },
      'command-link',
    );
    const command = ajv.compile(CommandSchema);
    expect(command(grant), JSON.stringify(command.errors)).toBe(true);
    expect(grant.observationGrants).toEqual([{ sourceId: 'command-link', observationType: 'link.status' }]);
    expect(grant.capabilities).toEqual(['input:write']);
    const accepted = ajv.compile(InputSchema);
    for (const observation of [commandLinkLossObservation, commandLinkRestorationObservation])
      expect(accepted(observation), JSON.stringify(accepted.errors)).toBe(true);
    expect(proposed({ ...proposedCommandLinkLoss, occurredAt: '2026-10-15t14:12:00Z' })).toBe(false);
    expect(manifest.extensions.flightEvidenceV2.review).toBe('simulator_reviewed');
    for (const format of ['ledger.decision-evidence.1', 'ledger.flight-evidence.2']) {
      const client = new LedgerClient(
        'http://ledger.invalid',
        'fixture-token',
        async () => new Response('retained bytes', { headers: { 'x-evidence-format': format } }),
      );
      const downloaded = await client.exportDownload('retained-export');
      expect(downloaded.format).toBe(format);
      expect(new TextDecoder().decode(downloaded.bytes)).toBe('retained bytes');
    }
    const unsupported = new LedgerClient(
      'http://ledger.invalid',
      'fixture-token',
      async () => new Response('retained bytes', { headers: { 'x-evidence-format': 'unknown' } }),
    );
    await expect(unsupported.exportDownload('retained-export')).rejects.toMatchObject({ status: 502 });
  });
  it('reviews one exact adoption using the displayed organization basis', () => {
    const pack = getRulePackVersion(nprmPackRead.packId, nprmPackRead.version)!;
    const shown = {
      organization: { id: 'organization:fixture-tenant', label: 'Operator', revision: 2, projectedRevision: 1 },
      decisions: [],
      limit: 100 as const,
      hasOlder: false,
      meta: {
        requestId: 'review-read',
        projectionRevision: 1,
        inputCut: { streams: { 'organization-stream': 1 }, basisRevision: 2, principalRevision: 3 },
        dependencyBasis: 'b'.repeat(64),
        computedAt: '2026-10-15T14:00:00Z',
        outstandingWork: 1,
      },
    };
    const command = reviewShownAdoption(
      shown,
      { id: 'retained-adoption', acceptedRevision: 1, pack },
      'Reviewed the adopted pack; communications assessment needs manual review.',
    );
    const validate = ajv.compile(CommandSchema);
    expect(validate(command), JSON.stringify(validate.errors)).toBe(true);
    expect(command.inputCut).toEqual(shown.meta.inputCut);
    expect(command.adoption).toEqual({
      id: 'retained-adoption',
      acceptedRevision: 1,
      pack: { packId: pack.packId, version: pack.version, digest: pack.digest },
    });
    expect(validate({ ...command, subject: { kind: 'organization', id: 'foreign-organization' } })).toBe(false);
    expect(validate({ ...command, decision: { ...command.decision, kind: 'risk.accept' } })).toBe(false);
    expect(manifest.extensions.organizationAdoptionReview.review).toBe('simulator_reviewed');
    expect(manifest.proposed.intake).toBe(false);
  });
  it('builds adoption from the displayed organization basis and exact retained NPRM references', () => {
    const pack = getRulePackVersion(nprmPackRead.packId, nprmPackRead.version)!;
    const cut = { streams: { 'displayed-organization-stream': 2 }, basisRevision: 2, principalRevision: 1 };
    const command = adoptShownPack(
      {
        organization: {
          id: 'organization:fixture-tenant',
          label: 'Fictional operator',
          revision: 2,
          projectedRevision: 2,
        },
        asOf: '2026-10-15T14:00:00Z',
        adoptions: [],
        limit: 100,
        hasOlder: false,
        meta: {
          requestId: 'fixture-read',
          projectionRevision: 2,
          inputCut: cut,
          dependencyBasis: 'a'.repeat(64),
          computedAt: '2026-10-15T14:00:00Z',
          outstandingWork: 0,
        },
      },
      pack,
      { start: '2026-10-15T14:00:00Z', end: '2026-10-16T14:00:00Z' },
      'Adopt the exact proposed pack for this fictional organization.',
      'shadow',
    );
    const validate = ajv.compile(CommandSchema);
    expect(validate(command), JSON.stringify(validate.errors)).toBe(true);
    expect(command.inputCut).toEqual(cut);
    expect(command.pack.digest).toBe(pack.digest);
    expect(command.pack.bindings).toEqual([]);
    expect(validate({ ...command, pack: { ...command.pack, version: 1e20 } })).toBe(false);
    expect(
      validate({ ...command, pack: { ...command.pack, leaves: [{ ...command.pack.leaves[0], version: 1e20 }] } }),
    ).toBe(false);
    expect(validate({ ...command, organizationId: 'organization:another-tenant' })).toBe(false);
    expect(pack.leaves.map((leaf) => leaf.coverage)).toEqual(['manual', 'unsupported']);
    expect(manifest.extensions.organizationPackAdoption.review).toBe('simulator_reviewed');
    expect(manifest.proposed.intake).toBe(false);
  });
  it('exposes an exact draft procedure-pack read without implying adoption or enabling proposed inputs', async () => {
    const params = ajv.compile(RulePackVersionParamsSchema);
    expect(params(draftProcedurePackRead), JSON.stringify(params.errors)).toBe(true);
    expect(params(draftAuthorizationPackRead), JSON.stringify(params.errors)).toBe(true);
    expect(params({ ...draftProcedurePackRead, version: 0 })).toBe(false);
    const calls: { path: string; authorization: string | null }[] = [];
    const ledger = new LedgerClient('http://ledger.invalid', 'fixture-credential', async (url, init) => {
      calls.push({
        path: new URL(String(url)).pathname,
        authorization: new Headers(init?.headers).get('authorization'),
      });
      return Response.json({
        pack: { packId: draftProcedurePackRead.packId, version: draftProcedurePackRead.version },
      });
    });
    await ledger.rulePackVersion(draftProcedurePackRead.packId, draftProcedurePackRead.version);
    await ledger.rulePackVersion(draftAuthorizationPackRead.packId, draftAuthorizationPackRead.version);
    expect(calls).toEqual([
      { path: '/v1/rule-packs/ledger.demo-procedures/versions/1', authorization: 'Bearer fixture-credential' },
      { path: '/v1/rule-packs/ledger.demo-procedures/versions/2', authorization: 'Bearer fixture-credential' },
    ]);
    expect(openApiDocument.paths['/v1/rule-packs/{packId}/versions/{version}'].get.operationId).toBe('rulePackVersion');
    expect(manifest.extensions.draftProcedurePack).toMatchObject({
      implementation: 'ready',
      review: 'simulator_reviewed',
      packId: draftProcedurePackRead.packId,
      version: draftProcedurePackRead.version,
      authority: ['flight:read'],
      adopted: false,
    });
    expect(manifest.extensions.draftAuthorizationEvidencePack).toMatchObject({
      implementation: 'ready',
      review: 'simulator_reviewed',
      packId: draftAuthorizationPackRead.packId,
      version: draftAuthorizationPackRead.version,
      activation: false,
      adopted: false,
    });
    expect(manifest.proposed.intake).toBe(false);
  });

  it('keeps readiness aligned with the served API and validates existing request/receipt examples', () => {
    expect(openApiDocument['x-ledger-demo-contract-version']).toBe(manifest.version);
    expect(openApiDocument.info.version).toBe(manifest.api.version);
    const input = ajv.compile(InputSchema);
    const command = ajv.compile(CommandSchema);
    const receipt = ajv.compile(ReceiptSchema);
    const flight = ajv.compile(FlightCreateSchema);
    expect(InputSchema.properties.kind.anyOf!.map((kind) => kind.const)).toEqual(manifest.ready.inputKinds);
    const demoCommandKinds = CommandSchema.anyOf
      .map((kind) => kind.properties.kind.const)
      .filter((kind) => !kind.startsWith('sms.'));
    expect([...new Set(demoCommandKinds)]).toEqual(manifest.ready.commandKinds);
    for (const value of [orderInput, landing, lateLanding, reportedAuthorization, deliveryCases.conflictingRetry.body])
      expect(input(value), JSON.stringify(input.errors)).toBe(true);
    expect(flight(orderInput.payload.fulfillments[0]), JSON.stringify(flight.errors)).toBe(true);
    expect(command(decision), JSON.stringify(command.errors)).toBe(true);
    expect(command(findingTreatmentDecision), JSON.stringify(command.errors)).toBe(true);
    expect(manifest.extensions.findings.review).toBe('simulator_reviewed');
    for (const value of [acceptedReceipt, completedReceipt])
      expect(receipt(value), JSON.stringify(receipt.errors)).toBe(true);
    expect(manifest.proposed.intake).toBe(false);
  });

  it('bounds queue reads and excludes only supported receipt kinds without changing the reviewed handoff', () => {
    const orders = ajv.compile(OrderQuerySchema);
    const receipts = ajv.compile(ReceiptQuerySchema);
    expect(orders(awaitingFlightOrdersQuery), JSON.stringify(orders.errors)).toBe(true);
    expect(orders({ view: 'all', limit: 25 })).toBe(true);
    expect(orders({ ...awaitingFlightOrdersQuery, view: 'aircraft-available' })).toBe(false);
    expect(orders({ ...awaitingFlightOrdersQuery, limit: 201 })).toBe(false);
    expect(receipts(unlinkedEvidenceQuery), JSON.stringify(receipts.errors)).toBe(true);
    expect(receipts({ linkStatus: 'unlinked', limit: 25 })).toBe(true);
    expect(ReceiptQuerySchema.properties.excludeKind.anyOf.map((kind) => kind.const).sort()).toEqual(
      ReceiptKindSchema.anyOf.map((kind) => kind.const).sort(),
    );
    expect(receipts({ ...unlinkedEvidenceQuery, excludeKind: 'safety.report' })).toBe(false);
    expect(manifest.review).toBe('ready_contract_reviewed');
    expect(manifest.extensions.queueReads.review).toBe('simulator_reviewed');
  });

  it('maps the vendor fixture through real intake and preserves original bytes, capture identity and retry keys', async () => {
    const raw = new TextEncoder().encode(` ${JSON.stringify(partnerOrder)}\n`);
    const calls: { path: string; key: string | null; body: BodyInit | null | undefined }[] = [];
    const upload = {
      id: 'resolved-upload-1',
      byteLength: raw.byteLength,
      contentType: 'application/json',
      sha256: digest(raw),
    };
    const artifact = {
      id: orderInput.artifactId,
      uploadId: upload.id,
      byteLength: upload.byteLength,
      contentType: upload.contentType,
      sha256: upload.sha256,
      key: 'tenant-alpha/resolved-upload-1/content',
    };
    let finalized = false;
    const ledger = new LedgerClient('http://ledger.invalid', 'fixture-credential', async (url, init) => {
      const path = new URL(String(url)).pathname;
      calls.push({ path, key: new Headers(init?.headers).get('idempotency-key'), body: init?.body });
      if (path === '/v1/uploads')
        return Response.json({
          upload: {
            ...upload,
            status: finalized ? 'finalized' : 'pending',
            artifactId: finalized ? artifact.id : undefined,
          },
        });
      if (path.endsWith('/content')) return Response.json({ upload: { ...upload, status: 'stored' } });
      if (path.endsWith('/finalize')) {
        finalized = true;
        return Response.json({ artifact });
      }
      if (path === '/v1/inputs') return Response.json({ receipt: acceptedReceipt }, { status: 201 });
      throw new Error(`Unexpected fixture request: ${path}`);
    });
    const adapter = new PartnerOrderAdapter({
      ledger,
      sourceId: identity.sourceId,
      sourceSessionId: identity.sourceSessionId,
      baseUrl: 'http://vendor.invalid',
      apiKey: 'fixture-vendor-credential',
    });
    await adapter.ingest(raw);
    const firstDelivery = calls.splice(0);
    await adapter.ingest(raw);
    expect(calls).toEqual(firstDelivery.filter((call) => !call.path.endsWith('/content')));
    const submitted = calls.find((call) => call.path === '/v1/inputs')!;
    expect(JSON.parse(submitted.body as string)).toEqual(orderInput);
    expect(submitted.key).toBe(`order:${partnerOrder.order_id}:1:webhook`);
    expect(firstDelivery.find((call) => call.path.endsWith('/content'))!.body).toEqual(raw);
  });

  it('keeps proposed geometry coordinates and source incident identities explicit', () => {
    const ring = site.footprint.geometry.coordinates[0]!;
    expect(ring[0]).toEqual(ring.at(-1));
    for (const [longitude, latitude] of [...ring, ...mission.route.geometry.coordinates]) {
      expect(longitude).toBeGreaterThanOrEqual(-180);
      expect(longitude).toBeLessThanOrEqual(180);
      expect(latitude).toBeGreaterThanOrEqual(-90);
      expect(latitude).toBeLessThanOrEqual(90);
    }
    expect(commandLink.incidentId).not.toBe(commandLink.sourceEventId);
  });
});
