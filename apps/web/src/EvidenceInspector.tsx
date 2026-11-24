import { useEffect, useState } from 'react';
import { LedgerClient } from '@ledger/contracts/client';
import type {
  Artifact,
  ArtifactResponse,
  DecisionRecord,
  Principal,
  ReceiptResponse,
  SourceCapability,
  TimelineItem,
  TimelineResponse,
} from '@ledger/contracts';
import { Badge, Button, Notice, Spinner } from '@ledger/ui';
import { dayTime, errorMessage, json, shortTime, time } from './format.js';
import {
  actorLabel,
  decisionLabel,
  fidelity,
  itemSource,
  kindLabel,
  processing,
  receivedAfter,
  recordTitle,
  retainedLabel,
  sourceLabel,
} from './labels.js';
import { DecisionEvidence } from './DecisionEvidence.js';
import { DecisionPacket } from './DecisionPacket.js';
import { MissionInspection } from './MissionInspection.js';
import { TelemetryRecordInspection } from './TelemetryRecordInspection.js';
import type { DecisionPacketRequests } from './decision-packet-requests.js';
import { decisionPacketOffer } from './decision-packet-eligibility.js';

interface Props {
  active: boolean;
  client: LedgerClient;
  item: TimelineItem | null;
  receiptId: string | null;
  data: TimelineResponse | null;
  decision?: DecisionRecord | null;
  principal: Principal | null;
  packetRequests: DecisionPacketRequests;
  capabilities: SourceCapability[];
  onChanged: () => void;
  onMission?: (releaseId?: string, briefingId?: string) => void;
}

export function EvidenceInspector({
  active,
  client,
  item: suppliedItem,
  receiptId,
  data,
  decision: suppliedDecision,
  principal,
  packetRequests,
  capabilities,
  onMission,
}: Props) {
  const item =
    suppliedItem ?? (receiptId ? data?.items.find((candidate) => candidate.receiptId === receiptId) : null) ?? null;
  const [receipt, setReceipt] = useState<ReceiptResponse | null>(null);
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const artifactId = item?.artifactId ?? receipt?.receipt.artifactId;

  useEffect(() => {
    setReceipt(null);
    setError(null);
    setArtifact(null);
    setPreview(null);
  }, [client, receiptId]);

  useEffect(() => {
    if (!active || !receiptId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    setLoading(true);
    async function poll() {
      try {
        const response = await client.receipt(receiptId!);
        if (!cancelled) {
          setReceipt(response);
          setError(null);
        }
      } catch (failure) {
        if (!cancelled) setError(errorMessage(failure));
      } finally {
        if (!cancelled) {
          setLoading(false);
          timer = setTimeout(() => void poll(), 2000);
        }
      }
    }
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, receiptId, active]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    if (!artifactId) return;
    client
      .request<ArtifactResponse>(`/v1/artifacts/${encodeURIComponent(artifactId)}`)
      .then((response) => {
        if (!cancelled) setArtifact(response.artifact);
      })
      .catch((failure) => {
        if (!cancelled) setError(errorMessage(failure));
      });
    return () => {
      cancelled = true;
    };
  }, [client, artifactId, active]);

  async function evidence(download: boolean) {
    if (!artifactId) return;
    setDownloadBusy(true);
    setError(null);
    try {
      const bytes = await client.evidence(artifactId);
      if (download) {
        const url = URL.createObjectURL(
          new Blob([Uint8Array.from(bytes).buffer], { type: artifact?.contentType ?? 'application/octet-stream' }),
        );
        const link = document.createElement('a');
        link.href = url;
        link.download = `ledger-evidence-${artifactId}`;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      } else {
        if (bytes.length > 256 * 1024)
          throw new Error(
            'This artifact exceeds the 256 KB text preview limit. Download the retained bytes to inspect it.',
          );
        try {
          setPreview(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        } catch {
          throw new Error('This artifact contains binary bytes. Download it to inspect the retained file.');
        }
      }
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setDownloadBusy(false);
    }
  }

  const selectedDecision = suppliedDecision ?? data?.decisions.find((decision) => decision.id === item?.id);
  const packetOffer = selectedDecision ? decisionPacketOffer(selectedDecision, item) : ({ kind: 'none' } as const);
  const correctedBy = item ? (data?.items.filter((candidate) => candidate.correctionOf === item.id) ?? []) : [];
  const original = item?.correctionOf ? data?.items.find((candidate) => candidate.id === item.correctionOf) : undefined;
  const received = receipt?.receipt;
  const occurredAt = item?.occurredAt ?? received?.occurredAt;
  const receivedAt = item?.receivedAt ?? received?.receivedAt;
  const late = item ? receivedAfter(item) : null;
  const sourceId = item?.sourceId ?? received?.sourceId;
  const kind = item?.kind ?? received?.kind;
  const capability =
    capabilities.find((candidate) => candidate.sourceId === sourceId && candidate.capability === kind) ??
    capabilities.find((candidate) => candidate.sourceId === sourceId);

  return (
    <section className="evidence-inspector" data-testid="receipt-inspector" aria-label="Selected record inspection">
      {!item && (
        <div className="inspector-heading">
          <h3>
            {selectedDecision
              ? decisionLabel(selectedDecision.kind)
              : received
                ? kindLabel(received.kind)
                : 'Receipt inspection'}
          </h3>
          {received && <Badge tone="attention">{sourceLabel(received.sourceId)}</Badge>}
        </div>
      )}
      {loading && <Spinner label="Reading the receipt" />}
      {error && <Notice tone="alert">{error}</Notice>}
      {selectedDecision && !item && (
        <dl className="inspection-facts">
          <div>
            <dt>Recorded</dt>
            <dd className="mono">{dayTime(selectedDecision.recordedAt)}</dd>
          </div>
          <div>
            <dt>By</dt>
            <dd>{actorLabel(selectedDecision.actorId, principal)}</dd>
          </div>
          <div className="wide">
            <dt>Note</dt>
            <dd>{selectedDecision.note}</dd>
          </div>
        </dl>
      )}
      {(item || received) && (
        <dl className="inspection-facts">
          <div>
            <dt>Happened</dt>
            <dd>
              <time className="mono" dateTime={occurredAt}>
                {dayTime(occurredAt)}
              </time>
            </dd>
          </div>
          <div>
            <dt>Ledger learned it</dt>
            <dd>
              <time className="mono" dateTime={receivedAt}>
                {dayTime(receivedAt)}
              </time>
              {late && <span className="fact-note">{late}</span>}
            </dd>
          </div>
          <div>
            <dt>Source</dt>
            <dd>
              {item ? itemSource(item, principal) : sourceLabel(received?.sourceId)}
              {capability && (
                <Badge tone={fidelity[capability.fidelity].tone} title={fidelity[capability.fidelity].description}>
                  {fidelity[capability.fidelity].label}
                </Badge>
              )}
            </dd>
          </div>
          <div>
            <dt>Retained</dt>
            <dd>{retainedLabel(artifact, Boolean(artifactId), item)}</dd>
          </div>
        </dl>
      )}
      {item && data && ['mission.release', 'mission.brief', 'mission.briefing-acknowledge'].includes(item.kind) && (
        <MissionInspection
          client={client}
          active={active}
          flightId={data.flight.id}
          item={item}
          onMission={onMission}
        />
      )}
      {!error && kind === 'telemetry.segment' && receiptId && artifactId && sourceId && (
        <TelemetryRecordInspection
          key={receiptId}
          active={active}
          client={client}
          receiptId={receiptId}
          artifactId={artifactId}
          sourceId={sourceId}
          descriptor={item?.payload ?? received?.payload ?? {}}
          processingStatus={received?.id === receiptId ? received.processing.status : undefined}
        />
      )}
      {received?.processing.error && (
        <Notice tone="attention" title="Processing failed">
          {received.processing.error}
        </Notice>
      )}
      {(original || correctedBy.length > 0) && (
        <div className="correction-lineage">
          {original && (
            <p>
              Corrects <strong>{recordTitle(original)}</strong> from {itemSource(original, principal)}. The original
              stays on the record.
            </p>
          )}
          {correctedBy.map((correction) => (
            <p key={correction.id}>
              Corrected by <strong>{actorLabel(correction.actorId, principal)}</strong> at{' '}
              {shortTime(correction.receivedAt)}. This original stays on the record.
            </p>
          ))}
        </div>
      )}
      <div className="inspector-actions">
        {artifactId && (
          <>
            <Button disabled={downloadBusy} onClick={() => void evidence(false)}>
              View original bytes
            </Button>
            <Button kind="quiet" disabled={downloadBusy} onClick={() => void evidence(true)}>
              Download
            </Button>
          </>
        )}
        {(item || received || selectedDecision) && (
          <details className="retained-payload">
            <summary>Raw values</summary>
            <pre>{json(selectedDecision ?? received?.payload ?? item?.payload)}</pre>
          </details>
        )}
      </div>
      {preview !== null && <pre className="artifact-preview">{preview}</pre>}
      {receipt && (
        <details className="processing-trace">
          <summary>Receipt and processing trace</summary>
          <p className="trace-note">Receipt time is never backdated.</p>
          <dl className="inspection-facts">
            <div>
              <dt>Receipt processing</dt>
              <dd>{processing[receipt.receipt.processing.status]}</dd>
            </div>
            <div>
              <dt>Processing attempts</dt>
              <dd>{receipt.receipt.processing.attempts}</dd>
            </div>
            <div>
              <dt>Receipt</dt>
              <dd className="mono">{receipt.receipt.id}</dd>
            </div>
            <div>
              <dt>Journal event</dt>
              <dd className="mono">{receipt.receipt.eventId}</dd>
            </div>
            <div>
              <dt>Request</dt>
              <dd className="mono">{receipt.meta.requestId}</dd>
            </div>
            <div>
              <dt>Projection revision</dt>
              <dd>{receipt.meta.projectionRevision}</dd>
            </div>
            <div>
              <dt>Processing checked at</dt>
              <dd className="mono">{time(receipt.meta.computedAt)}</dd>
            </div>
            {artifact && (
              <div className="wide">
                <dt>SHA-256 of the original bytes</dt>
                <dd className="mono digest">{artifact.sha256}</dd>
              </div>
            )}
          </dl>
        </details>
      )}
      {selectedDecision && (
        <details className="decision-cuts">
          <summary>Viewed and accepted input cuts</summary>
          <div>
            <strong>Viewed</strong>
            <pre>{json(selectedDecision.renderedInputCut)}</pre>
            <strong>Accepted</strong>
            <pre>{json(selectedDecision.acceptedInputCut)}</pre>
          </div>
        </details>
      )}
      {selectedDecision && data && (
        <>
          {packetOffer.kind !== 'none' && selectedDecision.flightId === data.flight.id && (
            <DecisionPacket
              active={active}
              offer={packetOffer}
              key={selectedDecision.id}
              client={client}
              decision={selectedDecision}
              flightId={data.flight.id}
              canExport={data.availableCommands.includes('evidence:read')}
              principal={principal}
              requests={packetRequests}
            />
          )}
          <details>
            <summary>Whole-journal evidence export</summary>
            <DecisionEvidence
              active={active}
              key={selectedDecision.id}
              client={client}
              decision={selectedDecision}
              flightId={data.flight.id}
              canExport={data.availableCommands.includes('evidence:read')}
              principal={principal}
            />
          </details>
        </>
      )}
    </section>
  );
}
