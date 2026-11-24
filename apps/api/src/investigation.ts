import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Value } from '@sinclair/typebox/value';
import {
  INVESTIGATION_LIMITS,
  InvestigationPinSchema,
  InvestigationRequestSchema,
  InvestigationResponseSchema,
  InvestigationRunnerResultSchema,
  bindInvestigationProposal,
  capabilityValues,
  collectFindingInvestigation,
  type InvestigationContext,
  type InvestigationRequest,
  type InvestigationProposal,
  type InvestigationRunner,
  type Principal,
  type TimelineResponse,
} from '@ledger/contracts';
import { ApiError } from '@ledger/contracts/client';
import { canonicalDigest } from '@ledger/integrity';
import { DomainError, withScope, type AuthContext, type Pool } from '@ledger/persistence';
import { requireRow } from '@ledger/domain';
import { createInvestigationClient, investigationApiOrigin } from './investigation-transport.js';

export interface InvestigationOptions {
  apiOrigin: string;
  runner: InvestigationRunner;
}

const paramsSchema = {
  type: 'object',
  properties: {
    id: InvestigationPinSchema.properties.flightId,
    findingId: InvestigationPinSchema.properties.findingId,
  },
  required: ['id', 'findingId'],
  additionalProperties: false,
} as const;
const emptyQuerySchema = { type: 'object', properties: {}, additionalProperties: false } as const;
const RUNNER_TIMEOUT_MS = 180_000;

function basisChanged(): DomainError {
  return new DomainError(
    409,
    'investigation_basis_changed',
    'The selected finding or displayed basis changed. Refresh the record before investigating again.',
  );
}

function matchRequest(shown: TimelineResponse, flightId: string, findingId: string, input: InvestigationRequest): void {
  const finding = shown.findings?.find((candidate) => candidate.id === findingId);
  if (shown.flight.id !== flightId || !finding || finding.flightId !== flightId)
    throw new DomainError(404, 'finding_not_found', 'The finding was not found in this flight.');
  if (
    shown.flight.revision !== input.basis.revision ||
    shown.flight.basisRevision !== input.basis.basisRevision ||
    shown.meta.dependencyBasis !== input.basis.dependencyBasis ||
    canonicalDigest(shown.meta.inputCut) !== canonicalDigest(input.basis.inputCut) ||
    finding.latestEvaluation.id !== input.evaluation.id ||
    canonicalDigest(finding.latestEvaluation) !== input.evaluation.digest
  )
    throw basisChanged();
  if (shown.flight.outstandingWork)
    throw new DomainError(
      409,
      'investigation_context_unavailable',
      'Wait for the selected flight record to finish updating before investigating.',
    );
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) {
      operation.catch(() => {});
      return abort();
    }
    signal.addEventListener('abort', abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

function collectionError(error: unknown): DomainError {
  if (error instanceof DomainError) return error;
  if (error instanceof ApiError) {
    if ([401, 403, 404].includes(error.status))
      return new DomainError(error.status, 'investigation_access_changed', 'Access to this investigation changed.');
    if (error.status === 413)
      return new DomainError(413, 'investigation_too_large', 'The selected evidence exceeds this investigation limit.');
  }
  return new DomainError(
    409,
    'investigation_context_unavailable',
    'The exact selected evidence could not be collected. Review the current record before investigating again.',
  );
}

export function registerInvestigationRoutes(
  app: FastifyInstance,
  dependencies: {
    pool: Pool;
    principal: (request: FastifyRequest) => AuthContext;
    token: (request: FastifyRequest) => string;
    investigation?: InvestigationOptions;
  },
): void {
  const { pool, principal, token, investigation } = dependencies;
  const apiOrigin = investigation ? investigationApiOrigin(investigation.apiOrigin) : undefined;
  let active = 0;

  async function authorize(request: FastifyRequest, flightId: string, findingId: string): Promise<Principal> {
    return withScope(
      pool,
      principal(request),
      async (client, who) => {
        if (who.kind !== 'human')
          throw new DomainError(403, 'human_required', 'An active human must request an investigation.');
        await requireRow(client, 'flight_views', flightId);
        const finding = await client.query<{ id: string }>(
          `SELECT v.id FROM finding_views v JOIN findings f ON f.tenant_id=v.tenant_id AND f.id=v.id
           WHERE v.id=$1 AND (v.flight_id=$2 OR (f.subject_scope='ledger' AND f.subject_kind='flight' AND f.subject_id=$2))`,
          [findingId, flightId],
        );
        if (!finding.rowCount)
          throw new DomainError(404, 'finding_not_found', 'The finding was not found in this flight.');
        return {
          id: who.id,
          tenantId: who.tenantId,
          name: who.name,
          capabilities: capabilityValues.filter((capability) => who.capabilities.includes(capability)),
          commandLinkSources: [...(who.commandLinkSources ?? [])],
          missionSources: [...(who.missionSources ?? [])],
          monitoringSources: [...(who.monitoringSources ?? [])],
          revision: who.revision,
        };
      },
      'flight:read',
      true,
      5000,
    );
  }

  app.post<{ Params: { id: string; findingId: string }; Body: InvestigationRequest }>(
    '/v1/flights/:id/findings/:findingId/investigation',
    {
      bodyLimit: INVESTIGATION_LIMITS.maxContextBytes,
      schema: {
        params: paramsSchema,
        querystring: emptyQuerySchema,
        body: InvestigationRequestSchema,
        response: { 200: InvestigationResponseSchema },
      },
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      const { id: flightId, findingId } = request.params;
      const human = await authorize(request, flightId, findingId);
      if (!investigation || !apiOrigin)
        throw new DomainError(503, 'investigation_unavailable', 'Finding investigation is not enabled on this host.');
      if (!human.capabilities.includes('evidence:read'))
        throw new DomainError(403, 'capability_required', 'Capability evidence:read is required');
      if (active >= 2)
        throw new DomainError(429, 'investigation_busy', 'Two investigations are already active. Try again shortly.');
      active++;
      const controller = new AbortController();
      const timeout = () =>
        controller.abort(new DomainError(504, 'investigation_timeout', 'The investigation deadline was exceeded.'));
      let timer = setTimeout(timeout, INVESTIGATION_LIMITS.totalTimeoutMs);
      const disconnected = () => controller.abort(new Error('Investigation request disconnected.'));
      const closed = () => {
        if (!reply.raw.writableEnded) disconnected();
      };
      request.raw.once('aborted', disconnected);
      reply.raw.once('close', closed);
      if (request.raw.aborted || reply.raw.destroyed) disconnected();
      let stage: 'collection' | 'runner' | 'return' = 'collection';
      try {
        const client = createInvestigationClient(app, apiOrigin, token(request), flightId, controller.signal);
        const timelinePath = `/v1/flights/${encodeURIComponent(flightId)}/timeline?limit=1&decisionLimit=1`;
        const readTimeline = () =>
          client.readJson<TimelineResponse>(timelinePath, {
            maxBytes: INVESTIGATION_LIMITS.maxJsonReadBytes,
            signal: controller.signal,
          });
        const shown = await readTimeline();
        matchRequest(shown, flightId, findingId, request.body);
        const context: InvestigationContext = await collectFindingInvestigation(
          client,
          shown,
          human,
          findingId,
          controller.signal,
        );
        controller.signal.throwIfAborted();
        clearTimeout(timer);
        timer = setTimeout(timeout, RUNNER_TIMEOUT_MS);
        stage = 'runner';
        const result = await abortable(
          investigation.runner(structuredClone(context), controller.signal),
          controller.signal,
        );
        if (!Value.Check(InvestigationRunnerResultSchema, result))
          throw new DomainError(
            502,
            'investigation_result_invalid',
            'The investigator returned an invalid advisory result.',
          );
        let proposal: InvestigationProposal;
        try {
          proposal = bindInvestigationProposal(context, result.advice);
        } catch {
          throw new DomainError(
            502,
            'investigation_result_invalid',
            'The investigator returned an invalid advisory result.',
          );
        }
        stage = 'return';
        const current = await authorize(request, flightId, findingId);
        if (!current.capabilities.includes('evidence:read'))
          throw new DomainError(403, 'capability_required', 'Capability evidence:read is required');
        if (current.id !== human.id || current.tenantId !== human.tenantId || current.revision !== human.revision)
          throw basisChanged();
        matchRequest(await readTimeline(), flightId, findingId, request.body);
        controller.signal.throwIfAborted();
        return { proposal, execution: structuredClone(result.execution) };
      } catch (error) {
        if (controller.signal.aborted) {
          if (controller.signal.reason instanceof DomainError) throw controller.signal.reason;
          throw new DomainError(499, 'investigation_cancelled', 'The investigation request was cancelled.');
        }
        if (error instanceof DomainError) throw error;
        if (stage !== 'runner') throw collectionError(error);
        throw new DomainError(503, 'investigation_unavailable', 'The investigator is temporarily unavailable.');
      } finally {
        clearTimeout(timer);
        request.raw.removeListener('aborted', disconnected);
        reply.raw.removeListener('close', closed);
        active--;
      }
    },
  );
}
