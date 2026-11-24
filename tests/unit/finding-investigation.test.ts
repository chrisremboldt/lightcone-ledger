import { describe, expect, it, vi } from 'vitest';
import type {
  ArtifactResponse,
  CommandLinkEvaluationEvidence,
  CommandLinkInput,
  CommandLinkSource,
  FindingRecord,
  Principal,
  ReceiptResponse,
  TimelineItem,
  TimelineResponse,
} from '../../packages/contracts/src/index.js';
import { INVESTIGATION_LIMITS } from '../../packages/contracts/src/investigation.js';
import { LedgerClient } from '../../packages/contracts/src/client.js';
import { adoptedCommandLinkFinding } from '../../packages/contracts/fixtures/demo/v1/c2-execution.js';
import {
  commandLinkLossEvidence,
  commandLinkRestorationEvidence,
} from '../../packages/contracts/fixtures/demo/v1/command-link-findings.js';
import {
  commandLinkLoss,
  commandLinkLossSource,
  commandLinkRestoration,
  commandLinkRestorationSource,
} from '../../packages/contracts/fixtures/demo/v1/command-link.js';
import { canonicalDigest, sha256 } from '../../packages/integrity/src/index.js';
import { evaluateCommandLinkEvidence } from '../../packages/domain/src/rules/command-link-evidence-v1.js';

import { collectFindingInvestigation } from '../../packages/contracts/src/investigation-collector.js';

type AlterRead = (url: URL, body: unknown, occurrence: number) => unknown;

function fixture(alter: AlterRead = (_url, body) => body) {
  const finding: FindingRecord = structuredClone(adoptedCommandLinkFinding);
  const human: Principal = {
    id: finding.owner!.id,
    tenantId: 'investigation-tenant',
    name: finding.owner!.name,
    revision: 4,
    capabilities: ['flight:read', 'evidence:read', 'decision:write'],
    commandLinkSources: [],
    missionSources: [],
  };
  finding.treatments = Array.from({ length: INVESTIGATION_LIMITS.maxTreatments + 1 }, (_, index) => ({
    ...adoptedCommandLinkFinding.treatments[0]!,
    id: `retained-treatment-${index}`,
    action: index === 0 ? 'acknowledge' : 'respond',
    recordedAt: new Date(Date.parse(finding.openedAt) + (index + 1) * 1000).toISOString(),
  }));
  const meta: TimelineResponse['meta'] = {
    requestId: 'investigation-read',
    projectionRevision: 7,
    inputCut: { ...structuredClone(finding.latestEvaluation.acceptedInputCut), principalRevision: human.revision },
    dependencyBasis: finding.latestEvaluation.dependencyBasis,
    computedAt: '2026-10-15T14:13:00.000Z',
    outstandingWork: 0,
  };
  const history = {
    limit: 1,
    returned: 1,
    hasMore: true,
    nextCursor: 'earlier-page-not-collected',
    selection: 'initial',
    consistency: 'live_projection',
  } as const;
  const displayed: TimelineResponse = {
    flight: {
      id: finding.flightId,
      label: 'Exact C2 finding',
      originationKey: 'investigation-flight',
      aircraft: commandLinkLossSource.aircraftId,
      revision: 7,
      basisRevision: meta.inputCut.basisRevision!,
      activity: 'active',
      coverage: 'recorded',
      orderIds: [],
      sourceIds: [commandLinkLoss.sourceId],
      unresolvedCount: 0,
      conflictCount: 0,
      outstandingWork: 0,
    },
    items: [],
    decisions: [],
    findings: [finding],
    selectedItem: null,
    selectedDecision: null,
    window: {
      items: { ...history, order: 'received_ascending' },
      decisions: { ...history, order: 'recorded_ascending' },
    },
    availableCommands: ['decision:write'],
    meta,
  };
  const routes = new Map<string, unknown>();
  const items = new Map<string, TimelineItem>();
  const originals = new Map<string, Uint8Array>();
  function report(input: CommandLinkInput, original: CommandLinkSource, evidence: CommandLinkEvaluationEvidence) {
    const bytes = new TextEncoder().encode(` \r\n${JSON.stringify(original)}\n`);
    const receivedAt = new Date(Date.parse(evidence.occurredAt) + 1000).toISOString();
    const receipt: ReceiptResponse = {
      receipt: {
        id: evidence.receiptId,
        sourceId: evidence.sourceId,
        kind: 'command-link.status',
        receivedAt,
        occurredAt: evidence.occurredAt,
        status: 'accepted',
        processing: { status: 'completed', attempts: 1 },
        linkStatus: 'linked',
        flightId: finding.flightId,
        artifactId: input.artifactId,
        eventId: evidence.eventId,
        payload: structuredClone(input.payload),
      },
      meta,
    };
    const artifact: ArtifactResponse = {
      artifact: {
        id: input.artifactId,
        uploadId: `upload-${input.artifactId}`,
        sha256: sha256(bytes),
        byteLength: bytes.byteLength,
        contentType: 'application/json',
        key: `retained/${input.artifactId}`,
      },
      meta,
    };
    const item: TimelineItem = {
      id: evidence.eventId,
      lane: 'observed',
      kind: 'command-link.status',
      title: `Reported link ${original.status}`,
      occurredAt: evidence.occurredAt,
      receivedAt,
      actorId: 'source-adapter',
      sourceId: evidence.sourceId,
      payload: { ...structuredClone(input.payload), sourceSessionId: input.sourceSessionId },
      receiptId: evidence.receiptId,
      artifactId: input.artifactId,
      linkStatus: 'linked',
    };
    routes.set(`/v1/receipts/${evidence.receiptId}`, receipt);
    routes.set(`/v1/artifacts/${input.artifactId}`, artifact);
    routes.set(`/v1/artifacts/${input.artifactId}/content`, bytes);
    originals.set(input.artifactId, bytes);
    items.set(item.id, item);
  }
  report(commandLinkLoss, commandLinkLossSource, commandLinkLossEvidence);
  report(commandLinkRestoration, commandLinkRestorationSource, commandLinkRestorationEvidence);
  const timelinePath = `/v1/flights/${finding.flightId}/timeline`;
  const counts = new Map<string, number>();
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe('https://ledger.invalid');
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer captured-human-token');
    const count = (counts.get(url.pathname) ?? 0) + 1;
    counts.set(url.pathname, count);
    let body: unknown;
    if (url.pathname === '/v1/me') body = { principal: structuredClone(human) };
    else if (url.pathname === timelinePath) {
      expect(url.searchParams.get('limit')).toBe('1');
      expect(url.searchParams.get('decisionLimit')).toBe('1');
      expect(url.searchParams.has('cursor')).toBe(false);
      expect(url.searchParams.has('decisionCursor')).toBe(false);
      const selectedId = url.searchParams.get('selectedItemId');
      body = {
        ...structuredClone(displayed),
        selectedItem: selectedId ? structuredClone(items.get(selectedId)) : null,
      };
    } else {
      expect(routes.has(url.pathname), `Unexpected public read: ${url.pathname}`).toBe(true);
      body = structuredClone(routes.get(url.pathname));
    }
    const response = alter(url, body, count);
    return response instanceof Uint8Array
      ? new Response(Uint8Array.from(response).buffer, { headers: { 'content-type': 'application/json' } })
      : Response.json(response);
  });
  const client = new LedgerClient('https://ledger.invalid', 'captured-human-token', fetcher);
  return { client, displayed, finding, human, fetcher, items, originals, report };
}

describe('finding investigation public collection', () => {
  it('pins the human context, verifies exact originals and projection digests, and bounds the compared history', async () => {
    const f = fixture();
    const before = structuredClone(f.displayed);
    const context = await collectFindingInvestigation(f.client, f.displayed, f.human, f.finding.id);
    expect(context.pin).toEqual({
      apiUrl: f.client.baseUrl,
      tenantId: f.human.tenantId,
      principalId: f.human.id,
      principalRevision: f.human.revision,
      flightId: f.finding.flightId,
      findingId: f.finding.id,
      evaluation: { id: f.finding.latestEvaluation.id, digest: canonicalDigest(f.finding.latestEvaluation) },
      basis: {
        revision: f.displayed.flight.revision,
        basisRevision: f.displayed.flight.basisRevision,
        inputCut: f.displayed.meta.inputCut,
        dependencyBasis: f.displayed.meta.dependencyBasis,
        view: 'record',
      },
    });
    expect(context.initialEvaluation).toEqual({
      record: f.finding.initialEvaluation,
      digest: canonicalDigest(f.finding.initialEvaluation),
    });
    expect(context.selectedEvaluation).toEqual({
      record: f.finding.latestEvaluation,
      digest: canonicalDigest(f.finding.latestEvaluation),
    });
    expect(context.history).toEqual({
      scope: 'initial_and_selected_evaluations',
      treatments: f.finding.treatments.slice(-INVESTIGATION_LIMITS.maxTreatments),
      omittedTreatments: true,
    });
    expect(context.allowedActions).toEqual(['respond', 'resolve']);
    expect(context.comparison.addedCitationIds).toEqual([commandLinkRestorationEvidence.receiptId]);
    expect(context.comparison.removedCitationIds).toEqual([]);
    expect(context.missingEvidence).toEqual([
      {
        id: 'earlier-treatments-not-collected',
        code: 'earlier_treatments_not_collected',
        evaluationId: f.finding.latestEvaluation.id,
        citationIds: [f.finding.latestEvaluation.id],
      },
    ]);
    expect(context.citations.map((citation) => citation.id)).toEqual([
      commandLinkLossEvidence.receiptId,
      commandLinkRestorationEvidence.receiptId,
    ]);
    for (const citation of context.citations) {
      expect(citation.artifact.sha256).toBe(sha256(f.originals.get(citation.artifact.id)!));
      expect(citation.artifact.byteLength).toBe(f.originals.get(citation.artifact.id)!.byteLength);
      expect(citation.publicTimelineItemDigest).toBe(canonicalDigest(f.items.get(citation.eventId)));
      expect(citation.sourceSessionId).toBe(commandLinkLossSource.sourceSessionId);
    }
    const { digest, ...preimage } = context;
    expect(digest).toBe(canonicalDigest(preimage));
    expect(f.displayed).toEqual(before);
    const paths = f.fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname);
    expect(paths.filter((path) => path === '/v1/me')).toHaveLength(2);
    expect(paths.filter((path) => path.endsWith('/timeline'))).toHaveLength(4);
    expect(paths.filter((path) => path.endsWith('/content'))).toHaveLength(2);
    expect(paths).toHaveLength(12);

    const reopened = fixture();
    const laterLoss: CommandLinkSource = {
      ...commandLinkLossSource,
      sourceEventId: 'link-event:3',
      occurredAt: '2026-10-15T14:12:40Z',
    };
    const laterEvidence: CommandLinkEvaluationEvidence = {
      ...commandLinkLossEvidence,
      sourceEventId: laterLoss.sourceEventId,
      occurredAt: laterLoss.occurredAt,
      eventId: 'resolved-link-later-loss-event',
      receiptId: 'resolved-link-later-loss-receipt',
    };
    const clock = { mode: 'wall', evaluatedAt: '2026-10-15T14:12:45Z' } as const;
    const evaluated = evaluateCommandLinkEvidence({
      flightId: reopened.finding.flightId,
      reports: [commandLinkLossEvidence, commandLinkRestorationEvidence, laterEvidence],
      clock,
    });
    expect(evaluated.explanation.groups).toEqual([
      expect.objectContaining({
        state: 'unresolved',
        lossEventIds: [commandLinkLossEvidence.eventId, laterEvidence.eventId],
        restorationEventIds: [commandLinkRestorationEvidence.eventId],
      }),
    ]);
    reopened.displayed.flight.revision++;
    reopened.displayed.flight.basisRevision++;
    reopened.displayed.meta.inputCut.basisRevision = reopened.displayed.flight.basisRevision;
    reopened.displayed.meta.inputCut.streams['resolved-link-stream'] = 3;
    reopened.finding.latestEvaluation = {
      ...reopened.finding.latestEvaluation,
      ...evaluated,
      id: 'resolved-link-reopened-evaluation',
      execution: {
        ...reopened.finding.latestEvaluation.execution!,
        trigger: { kind: 'source_report', eventId: laterEvidence.eventId },
      },
      clock,
      inputCut: structuredClone(reopened.displayed.meta.inputCut),
      acceptedInputCut: structuredClone(reopened.displayed.meta.inputCut),
      recordedAt: clock.evaluatedAt,
    };
    const { sourceSessionId, occurredAt, ...payload } = laterLoss;
    reopened.report(
      { ...commandLinkLoss, sourceSessionId, occurredAt, payload, artifactId: 'resolved-link-later-loss-artifact' },
      laterLoss,
      laterEvidence,
    );
    const reopenedContext = await collectFindingInvestigation(
      reopened.client,
      reopened.displayed,
      reopened.human,
      reopened.finding.id,
    );
    expect(reopenedContext.selectedEvaluation.record).toEqual(reopened.finding.latestEvaluation);
    expect(reopenedContext.allowedActions).toEqual(['respond']);
    expect(reopenedContext.missingEvidence).toContainEqual(
      expect.objectContaining({
        code: 'qualifying_restoration_not_in_selected_evaluation',
        evaluationId: reopened.finding.latestEvaluation.id,
        citationIds: expect.arrayContaining([laterEvidence.receiptId]),
      }),
    );
  });

  it('rejects identity, evaluation or exact stream-cut changes during collection without falling back to newer context', async () => {
    for (const changed of ['identity', 'evaluation', 'basis'] as const) {
      const f = fixture((url, body, occurrence) => {
        if (changed === 'identity' && url.pathname === '/v1/me' && occurrence === 2) {
          const response = body as { principal: Principal };
          response.principal.revision++;
        }
        if (changed !== 'identity' && url.searchParams.has('selectedItemId')) {
          const snapshot = body as TimelineResponse;
          if (changed === 'evaluation') snapshot.findings![0]!.latestEvaluation.id = 'newer-evaluation';
          else snapshot.meta.inputCut.streams['newly-accepted-stream'] = 1;
        }
        return body;
      });
      await expect(collectFindingInvestigation(f.client, f.displayed, f.human, f.finding.id)).rejects.toThrow(
        changed === 'identity' ? /identity or authority changed/ : /finding or displayed basis changed/,
      );
      const urls = f.fetcher.mock.calls.map(([url]) => new URL(String(url)));
      expect(urls.some((url) => url.pathname.endsWith('/content'))).toBe(true);
      expect(urls.at(-1)!.pathname).toBe(
        changed === 'identity' ? '/v1/me' : `/v1/flights/${f.finding.flightId}/timeline`,
      );
      expect(urls.filter((url) => url.searchParams.has('selectedItemId'))).toHaveLength(changed === 'identity' ? 2 : 1);
    }
  });

  it('rejects a mismatched cited receipt tuple and altered original bytes even when the JSON meaning is unchanged', async () => {
    for (const changed of ['receipt', 'hash'] as const) {
      const f = fixture((url, body) => {
        if (changed === 'receipt' && url.pathname === `/v1/receipts/${commandLinkLossEvidence.receiptId}`)
          (body as ReceiptResponse).receipt.eventId = 'different-source-event';
        if (changed === 'hash' && url.pathname === `/v1/artifacts/${commandLinkLoss.artifactId}/content`) {
          const bytes = body as Uint8Array;
          bytes[bytes.length - 1] = 32;
        }
        return body;
      });
      await expect(collectFindingInvestigation(f.client, f.displayed, f.human, f.finding.id)).rejects.toThrow(
        changed === 'receipt'
          ? /receipt does not match its exact evaluated report/
          : /bytes do not match their retained hash/,
      );
      const urls = f.fetcher.mock.calls.map(([url]) => new URL(String(url)));
      expect(urls.filter((url) => url.pathname.endsWith('/content'))).toHaveLength(changed === 'receipt' ? 0 : 1);
      expect(urls.some((url) => url.searchParams.has('selectedItemId'))).toBe(false);
    }
  });
});
