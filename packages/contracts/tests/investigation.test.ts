import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { canonicalDigest, sha256 } from '../../integrity/src/index.js';
import {
  INVESTIGATION_LIMITS,
  INVESTIGATION_ROUTE,
  InvestigationAdviceSchema,
  InvestigationExecutionSchema,
  InvestigationProposalSchema,
  InvestigationRequestSchema,
  InvestigationResponseSchema,
  InvestigationRunnerResultSchema,
  bindInvestigationProposal,
  parseInvestigationAdvice,
  validateInvestigationContext,
  validateInvestigationProposal,
} from '../src/investigation.js';
import { LedgerClient } from '../src/client.js';
import { openApiDocument } from '../src/openapi.js';
import {
  insufficientInvestigationAdvice,
  insufficientInvestigationContext,
  insufficientInvestigationProposal,
  investigationAdvice,
  investigationContext,
  investigationOriginals,
  investigationProposal,
  investigationTimelineItems,
  proposedInvestigationRequest,
  proposedInvestigationResponse,
} from '../fixtures/demo/v1/investigation.js';

describe('advisory finding investigation', () => {
  it('binds exact local authority, historical evaluation execution and verified public evidence pins', async () => {
    expect(Value.Check(InvestigationRequestSchema, proposedInvestigationRequest)).toBe(true);
    expect(Value.Check(InvestigationResponseSchema, proposedInvestigationResponse)).toBe(true);
    expect(Value.Check(InvestigationExecutionSchema, proposedInvestigationResponse.execution)).toBe(true);
    expect(
      Value.Check(InvestigationRunnerResultSchema, {
        advice: investigationAdvice,
        execution: proposedInvestigationResponse.execution,
      }),
    ).toBe(true);
    expect(proposedInvestigationResponse.proposal).toEqual(investigationProposal);
    for (const [context, advice, proposal] of [
      [investigationContext, investigationAdvice, investigationProposal],
      [insufficientInvestigationContext, insufficientInvestigationAdvice, insufficientInvestigationProposal],
    ] as const) {
      await expect(validateInvestigationContext(context)).resolves.toBeUndefined();
      expect(Value.Check(InvestigationAdviceSchema, advice)).toBe(true);
      expect(Value.Check(InvestigationProposalSchema, proposal)).toBe(true);
      expect(validateInvestigationProposal(context, proposal)).toBe(true);
      const { digest, ...content } = context;
      expect(digest).toBe(canonicalDigest(content));
      expect(proposal.context).toEqual(context.pin);
      expect(proposal.context).not.toBe(context.pin);
      expect(proposal.contextDigest).toBe(digest);
      expect(context.pin.evaluation.digest).toBe(canonicalDigest(context.selectedEvaluation.record));
      expect(context.initialEvaluation.digest).toBe(canonicalDigest(context.initialEvaluation.record));
      expect(context.history.scope).toBe('initial_and_selected_evaluations');
      expect(context.history.treatments.length).toBeLessThanOrEqual(INVESTIGATION_LIMITS.maxTreatments);
      expect(Buffer.byteLength(JSON.stringify(context))).toBeLessThanOrEqual(INVESTIGATION_LIMITS.maxContextBytes);
    }
    expect(investigationContext.selectedEvaluation.record.profile).toBe('ledger.c2-evaluation.2');
    expect(investigationContext.selectedEvaluation.record.execution?.selection.version).toBe('flight.rule-selection.2');
    expect(investigationContext.selectedEvaluation.record.inputCut.principalRevision).toBe(1);
    expect(investigationContext.pin.basis.inputCut.principalRevision).toBe(4);
    expect(investigationContext.comparison.addedCitationIds).toEqual([investigationContext.citations[1]!.receiptId]);
    expect(insufficientInvestigationContext.allowedActions).not.toContain('resolve');
    expect(insufficientInvestigationProposal.advice.suggestedTreatment).toBeNull();
    for (const citation of investigationContext.citations) {
      const original = investigationOriginals.find((item) => item.artifactId === citation.artifact.id)!;
      const item = investigationTimelineItems.find((item) => item.id === citation.eventId)!;
      expect(citation.id).toBe(citation.receiptId);
      expect(citation.artifact.sha256).toBe(sha256(original.bytes));
      expect(citation.artifact.byteLength).toBe(Buffer.byteLength(original.bytes));
      expect(citation.publicTimelineItemDigest).toBe(canonicalDigest(item));
      expect(item.receiptId).toBe(citation.receiptId);
      expect(item.artifactId).toBe(citation.artifact.id);
      expect(citation.artifact.byteLength).toBeLessThanOrEqual(INVESTIGATION_LIMITS.maxOriginalBytes);
    }
    const copied = bindInvestigationProposal(investigationContext, investigationAdvice);
    copied.advice.summary = 'Edited advisory copy';
    copied.context.basis.inputCut.streams['changed-stream'] = 1;
    expect(investigationAdvice.summary).not.toBe(copied.advice.summary);
    expect(investigationContext.pin.basis.inputCut.streams).not.toHaveProperty('changed-stream');
    const controller = new AbortController();
    const calls: {
      url: string;
      method?: string;
      body: unknown;
      authorization: string | null;
      key: string | null;
      signal?: AbortSignal | null;
    }[] = [];
    const client = new LedgerClient('https://ledger.invalid', 'fixture-token', async (url, init) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(url),
        method: init?.method,
        body: JSON.parse(String(init?.body)),
        authorization: headers.get('authorization'),
        key: headers.get('idempotency-key'),
        signal: init?.signal,
      });
      return Response.json(proposedInvestigationResponse);
    });
    expect(
      await client.investigateFinding('flight/one', 'finding/#one', proposedInvestigationRequest, controller.signal),
    ).toEqual(proposedInvestigationResponse);
    expect(calls).toEqual([
      {
        url: 'https://ledger.invalid/v1/flights/flight%2Fone/findings/finding%2F%23one/investigation',
        method: 'POST',
        body: proposedInvestigationRequest,
        authorization: 'Bearer fixture-token',
        key: null,
        signal: controller.signal,
      },
    ]);
    const operation = openApiDocument.paths[INVESTIGATION_ROUTE].post;
    expect(operation.operationId).toBe('investigateFinding');
    expect(operation.security).toEqual([{ bearerAuth: [] }]);
    expect(operation.parameters).toMatchObject([
      { name: 'id', in: 'path' },
      { name: 'findingId', in: 'path' },
    ]);
    expect(operation.parameters).toHaveLength(2);
    expect(operation.requestBody?.content['application/json'].schema).toEqual(InvestigationRequestSchema);
    expect(operation.responses[200].content['application/json'].schema).toEqual(InvestigationResponseSchema);
  });

  it('rejects unknown fields, actions, citations, missing-fact IDs and substituted proposal pins', async () => {
    expect(Value.Check(InvestigationResponseSchema, { ...proposedInvestigationResponse, accepted: true })).toBe(false);
    for (const [field, value] of [
      ['principalId', 'another-person'],
      ['apiUrl', 'https://other.invalid'],
      ['key', 'caller-key'],
    ])
      expect(Value.Check(InvestigationRequestSchema, { ...proposedInvestigationRequest, [field]: value })).toBe(false);
    for (const advice of [
      { ...investigationAdvice, apiUrl: 'https://other.invalid' },
      { ...investigationAdvice, principalId: 'another-person' },
      { ...investigationAdvice, version: 'invented-version' },
      { ...investigationAdvice, key: 'producer-selected-key' },
      { ...investigationAdvice, provider: 'model-selected-provider' },
      { ...investigationAdvice, model: 'model-selected-identity' },
      { ...investigationAdvice, execution: proposedInvestigationResponse.execution },
      { ...investigationAdvice, comparison: { ...investigationAdvice.comparison, inputCut: {} } },
      { ...investigationAdvice, suggestedTreatment: { ...investigationAdvice.suggestedTreatment, action: 'depart' } },
      { ...investigationAdvice, citations: ['unknown-receipt'] },
      {
        ...investigationAdvice,
        citations: [investigationContext.citations[0]!.id, investigationContext.citations[0]!.id],
      },
      {
        ...investigationAdvice,
        missingEvidence: [{ id: 'invented-missing-fact', note: 'An unsupported absence claim.' }],
      },
      { ...investigationAdvice, summary: 'Hidden\u0000control' },
      { ...investigationAdvice, summary: 'x'.repeat(INVESTIGATION_LIMITS.maxAdviceBytes + 1) },
    ])
      expect(() => parseInvestigationAdvice(investigationContext, advice)).toThrow(TypeError);
    expect(() =>
      parseInvestigationAdvice(insufficientInvestigationContext, {
        ...insufficientInvestigationAdvice,
        missingEvidence: [
          insufficientInvestigationAdvice.missingEvidence[0],
          insufficientInvestigationAdvice.missingEvidence[0],
        ],
      }),
    ).toThrow('unique');
    expect(() =>
      parseInvestigationAdvice(insufficientInvestigationContext, {
        ...insufficientInvestigationAdvice,
        suggestedTreatment: { action: 'resolve', note: 'Resolve', rationale: 'Unsupported resolution', citations: [] },
      }),
    ).toThrow('not allowed');
    for (const proposal of [
      { ...investigationProposal, contextDigest: '0'.repeat(64) },
      { ...investigationProposal, context: { ...investigationProposal.context, tenantId: 'another-tenant' } },
      {
        ...investigationProposal,
        context: {
          ...investigationProposal.context,
          evaluation: { ...investigationProposal.context.evaluation, id: 'another-evaluation' },
        },
      },
      { ...investigationProposal, automaticAcceptance: true },
    ])
      expect(validateInvestigationProposal(investigationContext, proposal)).toBe(false);
    expect(
      Value.Check(InvestigationExecutionSchema, { ...proposedInvestigationResponse.execution, apiKey: 'extra' }),
    ).toBe(false);
    expect(
      Value.Check(InvestigationRunnerResultSchema, {
        advice: investigationAdvice,
        execution: proposedInvestigationResponse.execution,
        accepted: true,
      }),
    ).toBe(false);
    for (const evaluation of ['initialEvaluation', 'selectedEvaluation'] as const) {
      const changed = structuredClone(investigationContext);
      changed[evaluation].record.title = 'Changed evaluation with its original supplied digest';
      await expect(validateInvestigationContext(changed)).rejects.toThrow('evaluation digest');
    }
    const changedContext = structuredClone(investigationContext);
    changedContext.finding.owner!.name = 'Changed owner display name';
    await expect(validateInvestigationContext(changedContext)).rejects.toThrow('context digest');
    const mismatchedRevision = structuredClone(investigationContext);
    mismatchedRevision.pin.basis.inputCut.principalRevision += 1;
    await expect(validateInvestigationContext(mismatchedRevision)).rejects.toThrow('pins');
    const missingRevision = structuredClone(investigationContext);
    Reflect.deleteProperty(missingRevision.pin.basis.inputCut, 'principalRevision');
    await expect(validateInvestigationContext(missingRevision)).rejects.toThrow('pins');
  });
});
