import { useEffect, useId, useRef, useState } from 'react';
import { ApiError, LedgerClient } from '@ledger/contracts/client';
import type { DecisionRecord, EvidenceCutSummary, ExportRecord, Principal } from '@ledger/contracts';
import { Badge, Button, Notice, Spinner } from '@ledger/ui';
import { byteSize, errorMessage, json, shortId, time } from './format.js';
import { actorLabel } from './labels.js';

interface Props {
  active: boolean;
  client: LedgerClient;
  decision: DecisionRecord;
  flightId: string;
  canExport: boolean;
  principal: Principal | null;
}
type Failure = { message: string; details?: unknown };
const cutNames = { rendered: 'Viewed', accepted: 'Accepted', issuance: 'Bundle issued' } as const;
function failure(error: unknown): Failure {
  const body =
    error instanceof ApiError && error.body && typeof error.body === 'object'
      ? (error.body as { error?: { details?: unknown } })
      : null;
  return { message: errorMessage(error), details: body?.error?.details };
}

export function DecisionEvidence({ active: visible, client, decision, flightId, canExport, principal }: Props) {
  const [records, setRecords] = useState<ExportRecord[]>([]);
  const [record, setRecord] = useState<ExportRecord | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(canExport);
  const [issuing, setIssuing] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<Failure | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const requestKey = useRef<string | null>(null);
  const recordSelectorId = useId();
  const active = useRef(true);
  const scope = useRef({ client, decisionId: decision.id });
  scope.current = { client, decisionId: decision.id };
  const isCurrent = () => active.current && scope.current.client === client && scope.current.decisionId === decision.id;

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    if (!visible || !canExport) return;
    let cancelled = false;
    setLoading(true);
    client
      .exports({ flightId, decisionId: decision.id })
      .then((response) => {
        if (cancelled || !isCurrent()) return;
        setRecords(response.records);
        setRecord((previous) => previous ?? response.records[0] ?? null);
        setHasMore(response.hasMore);
        setError(null);
      })
      .catch((error) => {
        if (!cancelled && isCurrent()) setError(failure(error));
      })
      .finally(() => {
        if (!cancelled && isCurrent()) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, decision.id, flightId, canExport, refresh, visible]);

  async function issue() {
    if (issuing || loading || downloading) return;
    requestKey.current ??= crypto.randomUUID();
    setIssuing(true);
    setError(null);
    setStatus(null);
    try {
      const response = await client.createExport(
        { flightId, decisionId: decision.id, scope: 'whole_tenant_prefixes' },
        requestKey.current,
      );
      if (!isCurrent()) return;
      setRecord(response.record);
      setRecords((previous) =>
        [response.record, ...previous.filter((item) => item.id !== response.record.id)].slice(0, 20),
      );
      requestKey.current = null;
      setStatus('Immutable evidence record issued. The decision and its input basis are unchanged.');
    } catch (error) {
      if (isCurrent()) setError(failure(error));
    } finally {
      if (isCurrent()) setIssuing(false);
    }
  }

  async function download() {
    if (!record || downloading || issuing) return;
    setDownloading(true);
    setError(null);
    setStatus(null);
    try {
      const content = await client.exportContent(record.id);
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(content).buffer))]
        .map((value) => value.toString(16).padStart(2, '0'))
        .join('');
      if (digest !== record.bundleSha256 || content.byteLength !== record.byteLength)
        throw new Error('Downloaded bytes do not match the issued record. No file was saved.');
      if (!isCurrent()) return;
      const url = URL.createObjectURL(new Blob([Uint8Array.from(content).buffer], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `ledger-decision-evidence-${record.id}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setStatus(
        'Downloaded bytes match the Ledger record’s SHA-256. Standalone journal verification is a separate check.',
      );
    } catch (error) {
      if (isCurrent()) setError(failure(error));
    } finally {
      if (isCurrent()) setDownloading(false);
    }
  }

  async function copyAnchor() {
    if (!record) return;
    try {
      await navigator.clipboard.writeText(record.manifestDigest);
      setStatus('Manifest digest copied. Retain it outside the bundle as an independent verification anchor.');
    } catch {
      setError({ message: 'Clipboard access is unavailable. Select and copy the full manifest digest below.' });
    }
  }

  const options = record && !records.some((item) => item.id === record.id) ? [record, ...records] : records;
  return (
    <section className="decision-evidence" data-testid="decision-evidence" aria-label="Decision evidence export">
      <div className="export-heading">
        <h4>{record ? 'Evidence bundle issued' : 'Export this decision with its evidence'}</h4>
        {record && <Badge tone="planned">Issued</Badge>}
      </div>
      <p className="export-caption">
        The bundle holds your operator’s whole journal at the viewed, accepted and export-time cuts, with original
        bytes, so it can be checked outside Ledger.
      </p>
      {!canExport ? (
        <p className="muted">Your current role does not grant evidence export access.</p>
      ) : (
        <>
          <div className="export-actions">
            <Button
              kind={record ? 'quiet' : 'primary'}
              aria-disabled={issuing || loading || downloading}
              onClick={() => void issue()}
            >
              {issuing ? (
                <Spinner label="Issuing evidence" />
              ) : record ? (
                'Issue another evidence record'
              ) : (
                'Issue evidence record'
              )}
            </Button>
            <Button
              kind={record ? 'primary' : undefined}
              disabled={!record}
              aria-disabled={downloading || issuing}
              onClick={() => void download()}
            >
              {downloading ? <Spinner label="Checking download" /> : 'Download evidence bundle'}
            </Button>
            <Button
              kind="quiet"
              aria-disabled={loading || issuing}
              onClick={() => {
                if (!loading && !issuing) setRefresh((value) => value + 1);
              }}
              aria-label="Refresh evidence records"
            >
              ↻
            </Button>
          </div>
          {loading && <Spinner label="Reading issued evidence records" />}
          {status && (
            <p className="export-status" role="status">
              {status}
            </p>
          )}
          {error && (
            <Notice tone="alert" title="Evidence export interrupted">
              {error.message}
              {error.details != null && (
                <details>
                  <summary>Export limits and details</summary>
                  <pre>{json(error.details)}</pre>
                </details>
              )}
            </Notice>
          )}
          {record && (
            <>
              {options.length > 1 && (
                <div className="export-selector">
                  <label htmlFor={recordSelectorId}>Evidence record</label>
                  <select
                    id={recordSelectorId}
                    value={record.id}
                    onChange={(event) => {
                      setRecord(options.find((item) => item.id === event.target.value) ?? null);
                      setStatus(null);
                      setError(null);
                    }}
                    disabled={issuing || downloading}
                  >
                    {options.map((item) => (
                      <option key={item.id} value={item.id}>
                        {time(item.issuedAt, true)} · {shortId(item.id)}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {hasMore && (
                <p className="export-caption">
                  The latest 20 records are listed. The selected record remains retained.
                </p>
              )}
              <dl className="inspection-facts export-facts">
                <div>
                  <dt>Bundle issued</dt>
                  <dd>
                    <time dateTime={record.issuedAt}>{time(record.issuedAt, true)}</time>
                  </dd>
                </div>
                <div>
                  <dt>Issued by</dt>
                  <dd>{actorLabel(record.issuedBy, principal)}</dd>
                </div>
                <div>
                  <dt>Exact bundle size</dt>
                  <dd>
                    {byteSize(record.byteLength)} · {record.byteLength.toLocaleString()} bytes
                  </dd>
                </div>
              </dl>
              <details className="export-details">
                <summary>Record details</summary>
                <p className="export-caption">
                  Evidence record <span className="mono">{record.id}</span>. Bounded to 5,000 entries, 16 MB of original
                  bytes and a 32 MB bundle.
                </p>
                <div className="export-anchor">
                  <div className="anchor-heading">
                    <h5>Manifest digest · retain externally</h5>
                    <Badge tone="attention">Not externally anchored</Badge>
                  </div>
                  <code data-testid="export-manifest-digest">{record.manifestDigest}</code>
                  <p>
                    Keep this digest outside the downloaded bundle. It binds the canonical manifest; it is not a
                    person’s signature.
                  </p>
                  <Button kind="quiet" onClick={() => void copyAnchor()}>
                    Copy manifest digest
                  </Button>
                </div>
                <div className="export-inventory">
                  <div className="inventory-heading">
                    <h5>Evidence inventory at retained cuts</h5>
                    <code>{record.interpretation}</code>
                  </div>
                  <p className="export-caption">
                    Deterministic journal inventory. This does not rebuild the flight’s operational projection.
                  </p>
                  <div className="inventory-cuts">
                    {(Object.keys(cutNames) as (keyof typeof cutNames)[]).map((name) => (
                      <InventoryCut key={name} label={cutNames[name]} summary={record.interpretations[name]} />
                    ))}
                  </div>
                  <p className="export-caption">
                    {record.addedAcceptedEventIds.length
                      ? `${record.addedAcceptedEventIds.length} additional journal entr${record.addedAcceptedEventIds.length === 1 ? 'y was' : 'ies were'} present at acceptance beyond the viewed cut.`
                      : 'Viewed and accepted inventories contain the same journal entries.'}
                  </p>
                  <details>
                    <summary>Exact cuts and inventory digests</summary>
                    {(Object.keys(cutNames) as (keyof typeof cutNames)[]).map((name) => (
                      <div className="export-cut-details" key={name}>
                        <strong>{cutNames[name]}</strong>
                        <code>{record.interpretations[name].digest}</code>
                        <pre>{json(record.cuts[name])}</pre>
                        {record.interpretations[name].missingCausationIds.length > 0 && (
                          <>
                            <strong>Missing causation references</strong>
                            <pre>{json(record.interpretations[name].missingCausationIds)}</pre>
                          </>
                        )}
                      </div>
                    ))}
                  </details>
                </div>
                <details className="export-integrity">
                  <summary>Bundle integrity, saved snapshot, and limits</summary>
                  <label className="digest-label">
                    Exact downloaded bytes · SHA-256
                    <code data-testid="export-bundle-digest">{record.bundleSha256}</code>
                  </label>
                  <label className="digest-label">
                    Saved export-time operational snapshot · digest<code>{record.snapshotDigest}</code>
                  </label>
                  <p>
                    The saved <span className="mono">thread.1</span> snapshot reflects export time. It is separate from
                    the retained-cut inventory and was not rebuilt from the journal.
                  </p>
                  <dl className="inspection-facts">
                    <div>
                      <dt>Journal entries / streams</dt>
                      <dd>
                        {record.counts.events.toLocaleString()} / {record.counts.streams.toLocaleString()}
                      </dd>
                    </div>
                    <div>
                      <dt>Receipts / artifacts</dt>
                      <dd>
                        {record.counts.receipts.toLocaleString()} / {record.counts.artifacts.toLocaleString()}
                      </dd>
                    </div>
                    <div>
                      <dt>Artifact bytes retained</dt>
                      <dd>{byteSize(record.counts.artifactBytes)}</dd>
                    </div>
                    <div>
                      <dt>Maximum entries / streams</dt>
                      <dd>
                        {record.limits.maxEvents.toLocaleString()} / {record.limits.maxStreams.toLocaleString()}
                      </dd>
                    </div>
                    <div>
                      <dt>Maximum artifacts / raw bytes</dt>
                      <dd>
                        {record.limits.maxArtifacts.toLocaleString()} / {byteSize(record.limits.maxArtifactBytes)}
                      </dd>
                    </div>
                    <div>
                      <dt>Maximum bundle</dt>
                      <dd>{byteSize(record.limits.maxBundleBytes)}</dd>
                    </div>
                  </dl>
                </details>
                <div className="export-limitations">
                  <h5>Verification limits</h5>
                  <ul>
                    {record.limitations.map((limitation, index) => (
                      <li key={`${index}:${limitation}`}>{limitation}</li>
                    ))}
                  </ul>
                  <p>
                    A byte match to the Ledger record checks download integrity. Independent verification requires a
                    manifest digest retained outside this bundle and the standalone verifier.
                  </p>
                </div>
              </details>
            </>
          )}
        </>
      )}
    </section>
  );
}

function InventoryCut({ label, summary }: { label: string; summary: EvidenceCutSummary }) {
  return (
    <div className="inventory-cut">
      <span>{label}</span>
      <strong>
        {summary.eventCount.toLocaleString()}
        <small> entries</small>
      </strong>
      <Badge tone={summary.causalClosure === 'closed' ? 'neutral' : 'attention'}>
        {summary.causalClosure === 'closed' ? 'Closed causation' : 'Missing references'}
      </Badge>
    </div>
  );
}
