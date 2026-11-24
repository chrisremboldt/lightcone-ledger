import type { LedgerClient } from './client.js';
import { commandLinkReportFields } from './command-link-proposal.js';
import {
  investigationCanonicalJson as canonicalJson,
  investigationDigest as canonicalDigest,
  investigationBytesDigest as bytesDigest,
} from './investigation-digest.js';
import {
  INVESTIGATION_LIMITS,
  validateInvestigationContext,
  type InvestigationCitation,
  type InvestigationContext,
  type InvestigationMissingEvidence,
} from './investigation.js';
import type {
  ArtifactResponse,
  CommandLinkEvaluationEvidence,
  EvaluationRecord,
  FindingRecord,
  FindingTreatment,
  InputCut,
  Principal,
  ReceiptResponse,
  TimelineResponse,
} from './index.js';

interface RecordBasis {
  revision: number;
  basisRevision: number;
  inputCut: InputCut;
  dependencyBasis?: string;
  valid: boolean;
}

function captureRecordBasis(data: TimelineResponse): RecordBasis {
  return {
    revision: data.flight.revision,
    basisRevision: data.flight.basisRevision,
    inputCut: structuredClone(data.meta.inputCut),
    dependencyBasis: data.meta.dependencyBasis,
    valid: Boolean(data.meta.dependencyBasis),
  };
}

function sameRecordBasis(left: RecordBasis, right: RecordBasis): boolean {
  return (
    left.valid &&
    right.valid &&
    left.revision === right.revision &&
    left.basisRevision === right.basisRevision &&
    left.dependencyBasis === right.dependencyBasis &&
    canonicalJson(left.inputCut) === canonicalJson(right.inputCut)
  );
}

/** A retained lost-link evaluation, or a generic one whose check found reported episodes still open. */
function isCommandLinkFinding(evaluation: EvaluationRecord): boolean {
  const explanation = evaluation.explanation;
  if (!('kind' in explanation)) return false;
  return (
    explanation.kind === 'command_link' ||
    (explanation.kind === 'rule' && explanation.ruleEvaluation.check.kind === EPISODE_CHECK)
  );
}

const EPISODE_CHECK = 'episode.open';

/** A cited report; a generic evaluation cites only the record, and its fields are read from the receipt. */
type CitedReport = Pick<
  CommandLinkEvaluationEvidence,
  'flightId' | 'eventId' | 'receiptId' | 'sourceId' | 'occurredAt'
> &
  Partial<CommandLinkEvaluationEvidence>;

function requireContext(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function apiIdentity(client: LedgerClient): string {
  const origin = typeof location === 'undefined' ? undefined : location.origin;
  const url = new URL(client.baseUrl || origin || '');
  requireContext(
    ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === '/',
    'The investigation needs the configured Ledger API origin.',
  );
  return url.origin;
}

function exactFinding(data: TimelineResponse, findingId: string): FindingRecord {
  const matches = data.findings?.filter((finding) => finding.id === findingId) ?? [];
  requireContext(matches.length === 1, 'The selected finding is unavailable in this flight record.');
  const finding = matches[0]!;
  requireContext(
    finding.flightId === data.flight.id &&
      finding.initialEvaluation.flightId === data.flight.id &&
      finding.latestEvaluation.flightId === data.flight.id &&
      isCommandLinkFinding(finding.initialEvaluation) &&
      isCommandLinkFinding(finding.latestEvaluation),
    'Investigation currently supports one exact command-link finding.',
  );
  for (const evaluation of [finding.initialEvaluation, finding.latestEvaluation]) {
    requireContext(
      evaluation.profile === undefined
        ? evaluation.execution === undefined
        : evaluation.profile === 'ledger.c2-evaluation.2' && evaluation.execution?.version === 'flight.c2-execution.1',
      'This evaluation profile is not supported for investigation.',
    );
  }
  return finding;
}

function availableActions(
  data: TimelineResponse,
  finding: FindingRecord,
  principal: Principal,
): FindingTreatment['action'][] {
  if (finding.status === 'resolved' || !data.availableCommands.includes('decision:write')) return [];
  if (!finding.owner) return ['acknowledge'];
  if (finding.owner.id !== principal.id) return [];
  return [
    'respond',
    ...(['pass', 'not_applicable'].includes(finding.latestEvaluation.outcome) ? ['resolve' as const] : []),
  ];
}

function evidence(evaluation: EvaluationRecord): CitedReport[] {
  requireContext(isCommandLinkFinding(evaluation), 'Expected command-link evidence.');
  const explanation = evaluation.explanation as Extract<EvaluationRecord['explanation'], { kind: string }>;
  if (explanation.kind === 'command_link') return explanation.evidence;
  return explanation.evidence.map((item) => ({
    flightId: evaluation.flightId,
    eventId: item.eventId,
    receiptId: item.receiptId,
    sourceId: item.sourceId,
    occurredAt: item.occurredAt,
  }));
}

function sameTime(left: string, right: string): boolean {
  return Number.isFinite(Date.parse(left)) && Date.parse(left) === Date.parse(right);
}

function missingEvidence(
  finding: FindingRecord,
  omittedTreatments: boolean,
  citations: readonly InvestigationCitation[],
): InvestigationMissingEvidence[] {
  const selected = finding.latestEvaluation;
  requireContext(isCommandLinkFinding(selected), 'Expected command-link evaluation.');
  const explanation = selected.explanation as Extract<EvaluationRecord['explanation'], { kind: string }>;
  const missing: InvestigationMissingEvidence[] = [];
  // A generic evaluation counts open episodes without naming them, so every cited loss is listed.
  const losses = new Set(
    explanation.kind === 'command_link'
      ? explanation.groups
          .filter((group) => group.state === 'unresolved' && group.lossEventIds.length)
          .flatMap((group) => group.lossEventIds)
      : explanation.kind === 'rule' && Number(explanation.details.openEpisodeCount ?? 0) > 0
        ? citations.filter((citation) => citation.status === 'lost').map((citation) => citation.eventId)
        : [],
  );
  if (losses.size)
    missing.push({
      id: 'qualifying-restoration-not-in-evaluation',
      code: 'qualifying_restoration_not_in_selected_evaluation',
      evaluationId: selected.id,
      citationIds: evidence(selected)
        .filter((report) => losses.has(report.eventId))
        .map((report) => report.receiptId),
    });
  if (selected.evidenceState === 'insufficient')
    missing.push({
      id: 'evaluation-insufficient',
      code: 'selected_evaluation_insufficient',
      evaluationId: selected.id,
      citationIds: [selected.id],
    });
  if (omittedTreatments)
    missing.push({
      id: 'earlier-treatments-not-collected',
      code: 'earlier_treatments_not_collected',
      evaluationId: selected.id,
      citationIds: [selected.id],
    });
  return missing;
}

export async function collectFindingInvestigation(
  client: LedgerClient,
  displayed: TimelineResponse,
  principal: Principal,
  findingId: string,
  signal?: AbortSignal,
): Promise<InvestigationContext> {
  const apiUrl = apiIdentity(client);
  const configuredUrl = client.baseUrl;
  const human = structuredClone(principal);
  const flightId = displayed.flight.id;
  const finding = structuredClone(exactFinding(displayed, findingId));
  const basis = captureRecordBasis(displayed);
  const allowedActions = availableActions(displayed, finding, human);
  requireContext(
    basis.valid && displayed.flight.outstandingWork === 0,
    'Wait for the displayed flight record to finish updating.',
  );
  requireContext(
    basis.inputCut.principalRevision === human.revision,
    'Refresh the displayed human authority before investigating.',
  );
  const initialDigest = await canonicalDigest(finding.initialEvaluation);
  const selectedDigest = await canonicalDigest(finding.latestEvaluation);
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(
    () => controller.abort(new Error('The bounded investigation read timed out.')),
    INVESTIGATION_LIMITS.totalTimeoutMs,
  );
  let reads = 0;
  let receivedBytes = 0;
  let originalBytes = 0;
  async function readBytes(path: string, maximum: number): Promise<Uint8Array> {
    requireContext(
      client.baseUrl === configuredUrl && apiIdentity(client) === apiUrl,
      'The configured API changed during investigation.',
    );
    requireContext(++reads <= INVESTIGATION_LIMITS.maxReads, 'The investigation exceeded its public-read limit.');
    const remaining = INVESTIGATION_LIMITS.maxTotalReadBytes - receivedBytes;
    requireContext(remaining > 0, 'The investigation exceeded its total read-byte limit.');
    const bytes = await client.readBytes(path, { maxBytes: Math.min(maximum, remaining), signal: controller.signal });
    receivedBytes += bytes.byteLength;
    return bytes;
  }
  async function readJson<T>(path: string, maximum: number = INVESTIGATION_LIMITS.maxJsonReadBytes): Promise<T> {
    const bytes = await readBytes(path, maximum);
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as T;
  }
  async function checkHuman(): Promise<void> {
    const session = await readJson<{ principal: Principal }>('/v1/me', 16384);
    requireContext(
      session.principal.id === human.id &&
        session.principal.tenantId === human.tenantId &&
        session.principal.revision === human.revision,
      'The signed-in identity or authority changed during investigation.',
    );
    requireContext(
      session.principal.capabilities.includes('flight:read') &&
        session.principal.capabilities.includes('evidence:read'),
      'Investigation needs access to the flight and its original evidence.',
    );
  }
  const timelinePath = `/v1/flights/${encodeURIComponent(flightId)}/timeline?limit=1&decisionLimit=1`;
  async function checkSnapshot(snapshot: TimelineResponse): Promise<void> {
    const selected = exactFinding(snapshot, finding.id);
    requireContext(
      snapshot.flight.id === flightId &&
        snapshot.flight.outstandingWork === 0 &&
        sameRecordBasis(basis, captureRecordBasis(snapshot)) &&
        selected.status === finding.status &&
        selected.owner?.id === finding.owner?.id &&
        (await canonicalDigest(selected.initialEvaluation)) === initialDigest &&
        (await canonicalDigest(selected.latestEvaluation)) === selectedDigest,
      'The selected finding or displayed basis changed. Review it before investigating again.',
    );
  }
  try {
    await checkHuman();
    await checkSnapshot(await readJson<TimelineResponse>(timelinePath));
    const reports = new Map<string, CitedReport>();
    for (const report of [...evidence(finding.initialEvaluation), ...evidence(finding.latestEvaluation)]) {
      requireContext(
        report.flightId === flightId && (report.status === undefined || ['lost', 'restored'].includes(report.status)),
        'An evaluation report has an unsupported flight or state.',
      );
      const previous = reports.get(report.receiptId);
      requireContext(
        !previous || (await canonicalDigest(previous)) === (await canonicalDigest(report)),
        'Evaluation evidence has conflicting receipt references.',
      );
      reports.set(report.receiptId, report);
    }
    requireContext(
      reports.size <= INVESTIGATION_LIMITS.maxReports,
      'This finding exceeds the bounded investigation report limit.',
    );
    const citations: InvestigationCitation[] = [];
    for (const cited of reports.values()) {
      const { receipt } = await readJson<ReceiptResponse>(`/v1/receipts/${encodeURIComponent(cited.receiptId)}`, 16384);
      const fields = commandLinkReportFields(receipt.kind, receipt.payload);
      // A generic evaluation's report takes its fields from the accepted record it cites.
      const report = { ...(fields ?? {}), ...cited } as CommandLinkEvaluationEvidence;
      requireContext(
        receipt.id === report.receiptId &&
          receipt.eventId === report.eventId &&
          receipt.sourceId === report.sourceId &&
          commandLinkReportFields(receipt.kind, receipt.payload) !== null &&
          receipt.flightId === flightId &&
          receipt.processing.status === 'completed' &&
          receipt.linkStatus === 'linked' &&
          sameTime(receipt.occurredAt, report.occurredAt) &&
          receipt.artifactId,
        'A collected receipt does not match its exact evaluated report.',
      );
      const accepted = commandLinkReportFields(receipt.kind, receipt.payload)!;
      for (const field of ['sourceEventId', 'incidentId', 'aircraftId', 'status'] as const)
        requireContext(
          accepted[field] === report[field],
          'A report citation does not match the accepted source fields.',
        );
      const { artifact } = await readJson<ArtifactResponse>(
        `/v1/artifacts/${encodeURIComponent(receipt.artifactId)}`,
        16384,
      );
      requireContext(
        artifact.id === receipt.artifactId &&
          /^[a-f0-9]{64}$/.test(artifact.sha256) &&
          Number.isSafeInteger(artifact.byteLength) &&
          artifact.byteLength > 0 &&
          artifact.byteLength <= INVESTIGATION_LIMITS.maxOriginalBytes &&
          /^application\/(?:json|[a-z0-9.+-]+\+json)(?:;|$)/i.test(artifact.contentType),
        'The exact source original has unsupported metadata or exceeds its byte limit.',
      );
      requireContext(
        originalBytes + artifact.byteLength <= INVESTIGATION_LIMITS.maxOriginalTotalBytes,
        'Source originals exceed the investigation byte limit.',
      );
      const original = await readBytes(`/v1/artifacts/${encodeURIComponent(artifact.id)}/content`, artifact.byteLength);
      originalBytes += original.byteLength;
      requireContext(
        original.byteLength === artifact.byteLength && (await bytesDigest(original)) === artifact.sha256,
        'Source original bytes do not match their retained hash.',
      );
      const source = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(original)) as Record<string, unknown>;
      // A report recorded through the dedicated intake keeps its session outside the accepted payload.
      if (report.sourceSessionId === undefined && typeof source.sourceSessionId === 'string')
        report.sourceSessionId = source.sourceSessionId;
      requireContext(
        source &&
          Object.getPrototypeOf(source) === Object.prototype &&
          Object.keys(source).every((key) =>
            [
              'sourceSessionId',
              'occurredAt',
              'sourceEventId',
              'incidentId',
              'aircraftId',
              'status',
              'position',
            ].includes(key),
          ) &&
          source.sourceSessionId === report.sourceSessionId &&
          typeof source.occurredAt === 'string' &&
          sameTime(source.occurredAt, report.occurredAt),
        'The source original does not match the evaluated session and clock.',
      );
      for (const field of ['sourceEventId', 'incidentId', 'aircraftId', 'status'] as const)
        requireContext(source[field] === report[field], 'The source original does not match the evaluated report.');
      requireContext(
        (await canonicalDigest(source.position ?? null)) === (await canonicalDigest(accepted.position ?? null)),
        'The source position differs from its accepted receipt.',
      );
      const eventRead = await readJson<TimelineResponse>(
        `${timelinePath}&selectedItemId=${encodeURIComponent(report.eventId)}`,
      );
      await checkSnapshot(eventRead);
      const item = eventRead.selectedItem;
      const shown = item ? commandLinkReportFields(item.kind, item.payload) : null;
      requireContext(
        item?.id === report.eventId &&
          shown !== null &&
          item.receiptId === receipt.id &&
          item.artifactId === artifact.id &&
          item.sourceId === report.sourceId &&
          shown.sourceSessionId === report.sourceSessionId &&
          sameTime(item.occurredAt, receipt.occurredAt) &&
          sameTime(item.receivedAt, receipt.receivedAt),
        'The exact public timeline item does not match its receipt and original.',
      );
      for (const field of ['sourceEventId', 'incidentId', 'aircraftId', 'status'] as const)
        requireContext(shown![field] === report[field], 'The public event projection differs from evaluated evidence.');
      citations.push({
        id: receipt.id,
        eventId: report.eventId,
        receiptId: receipt.id,
        sourceId: report.sourceId,
        sourceSessionId: report.sourceSessionId,
        sourceEventId: report.sourceEventId,
        incidentId: report.incidentId,
        aircraftId: report.aircraftId,
        status: report.status as 'lost' | 'restored',
        occurredAt: receipt.occurredAt,
        receivedAt: receipt.receivedAt,
        artifact: {
          id: artifact.id,
          sha256: artifact.sha256,
          byteLength: artifact.byteLength,
          contentType: artifact.contentType,
        },
        publicTimelineItemDigest: await canonicalDigest(item),
      });
    }
    await checkSnapshot(await readJson<TimelineResponse>(timelinePath));
    await checkHuman();
    requireContext(client.baseUrl === configuredUrl, 'The configured API changed during investigation.');
    const initialIds = new Set(evidence(finding.initialEvaluation).map((report) => report.receiptId));
    const selectedIds = new Set(evidence(finding.latestEvaluation).map((report) => report.receiptId));
    const omittedTreatments =
      finding.hasOlderTreatments || finding.treatments.length > INVESTIGATION_LIMITS.maxTreatments;
    const context: Omit<InvestigationContext, 'digest'> = {
      version: 'ledger.investigation-context.1',
      pin: {
        apiUrl,
        tenantId: human.tenantId,
        principalId: human.id,
        principalRevision: human.revision,
        flightId,
        findingId: finding.id,
        evaluation: { id: finding.latestEvaluation.id, digest: selectedDigest },
        basis: {
          revision: basis.revision,
          basisRevision: basis.basisRevision,
          inputCut: { ...structuredClone(basis.inputCut), principalRevision: human.revision },
          dependencyBasis: basis.dependencyBasis!,
          view: 'record',
        },
      },
      finding: { status: finding.status, owner: finding.owner, openedAt: finding.openedAt },
      history: {
        scope: 'initial_and_selected_evaluations',
        treatments: finding.treatments.slice(-INVESTIGATION_LIMITS.maxTreatments),
        omittedTreatments,
      },
      initialEvaluation: { record: finding.initialEvaluation, digest: initialDigest },
      selectedEvaluation: { record: finding.latestEvaluation, digest: selectedDigest },
      citations,
      comparison: {
        initial: { id: finding.initialEvaluation.id, digest: initialDigest },
        selected: { id: finding.latestEvaluation.id, digest: selectedDigest },
        addedCitationIds: [...selectedIds].filter((id) => !initialIds.has(id)),
        removedCitationIds: [...initialIds].filter((id) => !selectedIds.has(id)),
      },
      missingEvidence: missingEvidence(finding, omittedTreatments, citations),
      allowedActions,
    };
    requireContext(
      new TextEncoder().encode(JSON.stringify(context)).byteLength <= INVESTIGATION_LIMITS.maxContextBytes - 100,
      'The exact finding context exceeds its bounded byte limit.',
    );
    const collected = { ...context, digest: await canonicalDigest(context) };
    await validateInvestigationContext(collected);
    controller.signal.throwIfAborted();
    return collected;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
