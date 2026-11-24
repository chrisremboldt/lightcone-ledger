import { useEffect, useId, useRef, useState } from 'react';
import { ApiError, LedgerClient } from '@ledger/contracts/client';
import {
  DECISION_PACKET_LIMITATIONS,
  DECISION_PACKET_V2_LIMITATIONS,
  FINDING_PACKET_LIMITATIONS,
  FINDING_PACKET_V2_LIMITATIONS,
  type DecisionRecord,
  type Principal,
} from '@ledger/contracts';
import { Badge, Button, Notice, Spinner } from '@ledger/ui';
import {
  packetKey,
  packetRecordMatches,
  type DecisionPacketRequests,
  type PacketRecord,
  type PacketTarget,
} from './decision-packet-requests.js';
import type { DecisionPacketOffer } from './decision-packet-eligibility.js';
import { byteSize, errorMessage, json, shortId, time } from './format.js';
import { actorLabel } from './labels.js';
import { canonicalDigest } from './safety.js';
import { readFailureOutcome } from './read-failure.js';

interface Props {
  active: boolean;
  /** The packet this decision record offers: the finding's packet, or the older packets issued for it. */
  offer: Exclude<DecisionPacketOffer, { kind: 'none' }>;
  client: LedgerClient;
  decision: DecisionRecord;
  flightId: string;
  canExport: boolean;
  principal: Principal | null;
  requests: DecisionPacketRequests;
}
interface Scope {
  client: LedgerClient;
  apiUrl: string;
  flightId: string;
  decisionId: string;
  target: string;
  principalId: string | null;
  tenantId: string | null;
  revision: number | null;
  canExport: boolean;
}
interface Failure {
  message: string;
  details?: unknown;
}
type Operation = { scope: Scope; kind: 'issuing' | 'downloading' | 'copying' };
interface ReadState {
  scope: Scope;
  records: PacketRecord[];
  hasMore: boolean;
  loading: boolean;
  accessLost: boolean;
  error: Failure | null;
  status: string | null;
  working: Operation['kind'] | null;
}

function sameScope(left: Scope, right: Scope) {
  return (
    left.client === right.client &&
    left.apiUrl === right.apiUrl &&
    left.flightId === right.flightId &&
    left.decisionId === right.decisionId &&
    left.target === right.target &&
    left.principalId === right.principalId &&
    left.tenantId === right.tenantId &&
    left.revision === right.revision &&
    left.canExport === right.canExport
  );
}

function emptyRead(scope: Scope, loading = false): ReadState {
  return { scope, records: [], hasMore: false, loading, accessLost: false, error: null, status: null, working: null };
}

function failure(error: unknown): Failure {
  let body = error instanceof ApiError ? error.body : null;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      body = null;
    }
  }
  const detail =
    body && typeof body === 'object' ? (body as { error?: { message?: unknown; details?: unknown } }).error : null;
  return {
    message: typeof detail?.message === 'string' ? detail.message : errorMessage(error),
    details: detail?.details,
  };
}

/** Lists the packets a target has, newest first, keeping only records that match it. */
async function listPackets(
  client: LedgerClient,
  target: PacketTarget,
  tenantId: string,
): Promise<{ records: PacketRecord[]; hasMore: boolean }> {
  const response =
    target.kind === 'finding'
      ? await client.findingPackets({ findingId: target.findingId, limit: 20 }).then((page) => ({
          records: page.records,
          hasMore: page.page?.hasMore,
          limit: page.page?.limit,
        }))
      : await client.decisionPackets({ flightId: target.flightId, decisionId: target.decisionId });
  if (
    response.limit !== 20 ||
    typeof response.hasMore !== 'boolean' ||
    !Array.isArray(response.records) ||
    response.records.length > 20 ||
    new Set(response.records.map((item) => item.id)).size !== response.records.length ||
    !response.records.every((item) => packetRecordMatches(item, target, tenantId))
  )
    throw new Error('Packet records could not be matched to this exact record. Refresh them before continuing.');
  return { records: response.records, hasMore: response.hasMore };
}

async function readPacket(client: LedgerClient, target: PacketTarget, id: string): Promise<unknown> {
  return (target.kind === 'finding' ? await client.findingPacket(id) : await client.decisionPacket(id)).record;
}

async function packetBytes(client: LedgerClient, target: PacketTarget, record: PacketRecord): Promise<Uint8Array> {
  if (target.kind === 'finding') return client.findingPacketContent(record.id);
  const content = await client.decisionPacketDownload(record.id);
  if (content.format !== record.format)
    throw new Error('Downloaded packet bytes do not match the selected record. No file was saved.');
  return content.bytes;
}

function limitationsOf(record: PacketRecord): readonly string[] {
  switch (record.format) {
    case 'ledger.finding-packet.2':
      return FINDING_PACKET_V2_LIMITATIONS;
    case 'ledger.finding-packet.1':
      return FINDING_PACKET_LIMITATIONS;
    case 'ledger.decision-packet.2':
      return DECISION_PACKET_V2_LIMITATIONS;
    default:
      return DECISION_PACKET_LIMITATIONS;
  }
}

function versionOf(record: PacketRecord): string {
  return record.format.endsWith('.2') ? 'Version 2' : 'Version 1';
}

/** Original bytes the packet carries, and any it left out, in plain words. */
function originalsOf(record: PacketRecord): string {
  if (record.format === 'ledger.finding-packet.1') return 'Digests only';
  if (record.format === 'ledger.finding-packet.2') {
    const carried = byteSize(record.counts.originalBytes);
    return record.counts.leftOutOriginals
      ? `${carried} · ${record.counts.leftOutOriginals} left out, digest only`
      : `${carried} · none left out`;
  }
  return byteSize(record.counts.artifactBytes);
}

/**
 * The packet panel of a decision record. For a treatment of a finding from a rule evaluation it issues and lists the
 * finding's packets; for a treatment of a retained lost-link evaluation it lists the older decision packets issued
 * earlier, which are no longer issued but stay readable.
 */
export function DecisionPacket({
  active: visible,
  offer,
  client,
  decision,
  flightId,
  canExport,
  principal,
  requests,
}: Props) {
  const target: PacketTarget =
    offer.kind === 'finding'
      ? { kind: 'finding', findingId: offer.findingId }
      : { kind: 'decision', flightId, decisionId: decision.id };
  const issuing = target.kind === 'finding';
  const identity: Scope = {
    client,
    apiUrl: client.baseUrl,
    flightId,
    decisionId: decision.id,
    target: packetKey(target),
    principalId: principal?.id ?? null,
    tenantId: principal?.tenantId ?? null,
    revision: principal?.revision ?? null,
    canExport,
  };
  const [state, setState] = useState<ReadState>(() => emptyRead(identity, canExport && principal !== null));
  const [refresh, setRefresh] = useState(0);
  const selectorId = useId();
  const active = useRef(true);
  const scope = useRef(identity);
  const controller = useRef(requests);
  const operation = useRef<Operation | null>(null);
  scope.current = identity;
  controller.current = requests;

  const read = sameScope(state.scope, identity) ? state : emptyRead(identity, canExport && principal !== null);
  const session = requests.sessions[packetKey(target)];
  const record =
    !read.accessLost && principal && session?.record && packetRecordMatches(session.record, target, principal.tenantId)
      ? session.record
      : null;
  const request =
    !read.accessLost &&
    target.kind === 'finding' &&
    session?.request &&
    session.request.body.findingId === target.findingId &&
    session.request.principalId === principal?.id &&
    session.request.tenantId === principal?.tenantId
      ? session.request
      : null;
  const selectedRecord = useRef(record);
  selectedRecord.current = record;
  const sending = request?.state === 'sending' || read.working === 'issuing';
  const busy = read.loading || read.working !== null || sending;
  const candidate = issuing;
  const allowed = canExport && principal !== null && !read.accessLost;
  const options =
    record && !read.records.some((item) => item.id === record.id) ? [record, ...read.records] : read.records;

  function current(expected: Scope) {
    return active.current && sameScope(scope.current, expected) && expected.client.baseUrl === expected.apiUrl;
  }

  /** A 404 naming the finding or decision means it is out of reach; a 404 from one listed packet does not. */
  function showFailure(error: unknown, expected: Scope, subjectRead = false) {
    if (!current(expected)) return;
    const accessLost = readFailureOutcome(error, subjectRead) === 'access_lost';
    setState((previous) => ({
      ...(accessLost || !sameScope(previous.scope, expected) ? emptyRead(expected) : previous),
      accessLost,
      error: failure(error),
      status: null,
    }));
  }

  function begin(kind: Operation['kind']): Operation | null {
    if (!allowed || busy || (operation.current && sameScope(operation.current.scope, identity))) return null;
    const next = { scope: { ...identity }, kind };
    operation.current = next;
    setState((previous) => ({ ...previous, working: kind, error: null, status: null }));
    return next;
  }

  function finish(token: Operation) {
    if (operation.current !== token) return;
    operation.current = null;
    if (current(token.scope)) setState((previous) => ({ ...previous, working: null }));
  }

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  useEffect(() => {
    if (!visible) return;
    const expected = { ...scope.current };
    if (!expected.canExport || !expected.tenantId || !expected.principalId) {
      setState(emptyRead(expected));
      return;
    }
    let cancelled = false;
    setState((previous) => ({
      ...(sameScope(previous.scope, expected) ? previous : emptyRead(expected)),
      loading: true,
      error: null,
      status: null,
    }));
    listPackets(client, target, expected.tenantId)
      .then((response) => {
        if (cancelled || !current(expected)) return;
        setState((previous) => ({
          ...previous,
          records: response.records,
          hasMore: response.hasMore,
          accessLost: false,
          error: null,
        }));
        const latest = controller.current.sessions[expected.target];
        if (!latest?.record && !latest?.request && response.records[0])
          controller.current.select(target, response.records[0]);
      })
      .catch((error) => {
        if (!cancelled) showFailure(error, expected, true);
      })
      .finally(() => {
        if (!cancelled && current(expected)) setState((previous) => ({ ...previous, loading: false }));
      });
    return () => {
      cancelled = true;
    };
  }, [
    visible,
    client,
    identity.apiUrl,
    flightId,
    decision.id,
    identity.target,
    canExport,
    principal?.id,
    principal?.tenantId,
    principal?.revision,
    refresh,
  ]);

  async function issue() {
    if ((!candidate && !request) || request?.state === 'sending') return;
    const token = begin('issuing');
    if (!token) return;
    try {
      if (target.kind === 'finding')
        await controller.current.issue(structuredClone(request?.body ?? { findingId: target.findingId }));
    } catch (error) {
      showFailure(error, token.scope, true);
    } finally {
      finish(token);
    }
  }

  async function download() {
    if (!record) return;
    const token = begin('downloading');
    if (!token) return;
    const snapshot = structuredClone(record);
    const stillSelected = () =>
      current(token.scope) &&
      selectedRecord.current?.id === snapshot.id &&
      selectedRecord.current.manifestDigest === snapshot.manifestDigest &&
      selectedRecord.current.packetSha256 === snapshot.packetSha256;
    try {
      const exact = await readPacket(token.scope.client, target, snapshot.id);
      if (!stillSelected()) return;
      if (
        !packetRecordMatches(exact, target, token.scope.tenantId!) ||
        (await canonicalDigest(exact)) !== (await canonicalDigest(snapshot))
      )
        throw new Error('Exact packet metadata differs from the selected record. No file was saved.');
      if (!stillSelected()) return;
      const bytes = await packetBytes(token.scope.client, target, snapshot);
      if (!stillSelected()) return;
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer))]
        .map((value) => value.toString(16).padStart(2, '0'))
        .join('');
      if (bytes.byteLength !== snapshot.byteLength || digest !== snapshot.packetSha256)
        throw new Error('Downloaded packet bytes do not match the selected record. No file was saved.');
      if (!stillSelected()) return;
      const url = URL.createObjectURL(new Blob([Uint8Array.from(bytes).buffer], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `ledger-${issuing ? 'finding' : 'decision'}-packet-${snapshot.id}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setState((previous) => ({
        ...previous,
        status: 'Downloaded bytes match the selected packet’s SHA-256. Standalone verification is a separate check.',
      }));
    } catch (error) {
      showFailure(error, token.scope);
    } finally {
      finish(token);
    }
  }

  async function copyManifest() {
    if (!record) return;
    const token = begin('copying');
    if (!token) return;
    const snapshot = record;
    try {
      await navigator.clipboard.writeText(snapshot.manifestDigest);
      if (current(token.scope) && selectedRecord.current?.id === snapshot.id)
        setState((previous) => ({ ...previous, status: 'Manifest digest copied. Retain it outside the packet.' }));
    } catch {
      showFailure(
        new Error('Clipboard access is unavailable. Select and copy the full packet manifest digest below.'),
        token.scope,
      );
    } finally {
      finish(token);
    }
  }

  const verifierCommand = issuing
    ? 'node tools/verifier/finding-packet-cli.mjs packet.json --expected-manifest-sha256 DIGEST'
    : 'node tools/verifier/decision-packet-cli.mjs packet.json --expected-manifest-sha256 DIGEST';

  return (
    <section
      className="decision-evidence"
      data-testid={issuing ? 'decision-finding-packet' : 'decision-packet'}
      aria-label={issuing ? 'Finding packet' : 'Selected C2 decision packet'}
    >
      <div className="export-heading">
        <h4>{issuing ? 'Finding packet' : 'Selected C2 decision packet'}</h4>
        {record && <Badge tone="planned">Issued</Badge>}
      </div>
      <p className="export-caption">
        {issuing
          ? 'Contains the finding this decision treats: its evaluations, the records they read with their original bytes, and the decisions recorded about it. Whole-journal export is a separate choice.'
          : 'Decision packets are no longer issued; findings are packaged as finding packets. Packets issued earlier for this decision stay available here and verify with their own verifier.'}
      </p>
      {!canExport || !principal ? (
        <p className="muted">Your current role does not grant packet access.</p>
      ) : (
        <>
          <div className="export-actions">
            {issuing && (
              <Button kind={record ? 'quiet' : 'primary'} disabled={!allowed || busy} onClick={() => void issue()}>
                {sending ? (
                  <Spinner label="Issuing finding packet" />
                ) : request ? (
                  'Retry same packet request'
                ) : (
                  'Issue a finding packet'
                )}
              </Button>
            )}
            <Button
              kind="quiet"
              disabled={busy}
              onClick={() => {
                if (busy || (operation.current && sameScope(operation.current.scope, identity))) return;
                setRefresh((value) => value + 1);
              }}
            >
              Refresh packet records
            </Button>
          </div>
          {issuing && !request && (
            <p className="export-caption">Ledger checks the finding’s retained records when issuing a packet.</p>
          )}
          {read.loading && <Spinner label="Reading packet records" />}
          {request?.state === 'unknown' && (
            <Notice tone="attention" title="Packet request outcome unknown">
              Retry the original request with the same key to confirm its result. Listed packets do not resolve this
              attempt.
            </Notice>
          )}
          {!read.accessLost && session?.error && (
            <Notice
              tone={request?.state === 'unknown' ? 'attention' : 'alert'}
              title={request?.state === 'rejected' ? 'Finding packet was not issued' : 'Packet request interrupted'}
            >
              {session.error.message}
              {session.error.details != null && (
                <details>
                  <summary>Packet request details</summary>
                  <pre>{json(session.error.details)}</pre>
                </details>
              )}
            </Notice>
          )}
          {read.error && (
            <Notice tone="alert" title={read.accessLost ? 'Packet access unavailable' : 'Packet read interrupted'}>
              {read.error.message}
              {read.error.details != null && (
                <details>
                  <summary>Packet read details</summary>
                  <pre>{json(read.error.details)}</pre>
                </details>
              )}
            </Notice>
          )}
          {(read.status || (!read.accessLost && session?.status)) && (
            <p className="export-status" role="status">
              {read.status ?? session?.status}
            </p>
          )}
          {options.length > 0 && !read.accessLost && (
            <div className="export-selector">
              <label htmlFor={selectorId}>Packet record</label>
              <select
                id={selectorId}
                value={record?.id ?? ''}
                disabled={busy}
                onChange={(event) => {
                  if (busy || (operation.current && sameScope(operation.current.scope, identity))) return;
                  const selected = options.find((item) => item.id === event.target.value);
                  if (!selected || !principal || !packetRecordMatches(selected, target, principal.tenantId)) return;
                  controller.current.select(target, selected);
                  setState((previous) => ({ ...previous, error: null, status: null }));
                }}
              >
                {!record && <option value="">Select an issued packet</option>}
                {options.map((item) => (
                  <option key={item.id} value={item.id}>
                    {time(item.issuedAt, true)} · {shortId(item.id)}
                  </option>
                ))}
              </select>
            </div>
          )}
          {!read.loading && !read.error && options.length === 0 && (
            <p className="muted">
              {issuing
                ? 'No packets are listed for this finding yet.'
                : 'No packets are listed for this exact decision.'}
            </p>
          )}
          {read.hasMore && (
            <p className="export-caption">
              The latest 20 packets are listed. A selected older packet remains available.
            </p>
          )}
          {record && (
            <>
              <dl className="inspection-facts export-facts">
                <div>
                  <dt>Packet issued</dt>
                  <dd>
                    <time dateTime={record.issuedAt}>{time(record.issuedAt, true)}</time>
                  </dd>
                </div>
                <div>
                  <dt>Issued by</dt>
                  <dd>{actorLabel(record.issuedBy, principal)}</dd>
                </div>
                <div>
                  <dt>Format / size</dt>
                  <dd>
                    {versionOf(record)} · {byteSize(record.byteLength)}
                  </dd>
                </div>
                <div>
                  <dt>Events / receipts / sources</dt>
                  <dd>
                    {record.counts.events} / {record.counts.receipts} / {record.counts.artifacts}
                  </dd>
                </div>
                <div>
                  <dt>Original bytes carried</dt>
                  <dd data-testid="packet-originals">{originalsOf(record)}</dd>
                </div>
              </dl>
              <div className="export-anchor">
                <div className="anchor-heading">
                  <h5>Manifest digest · retain externally</h5>
                  <Badge tone="attention">Not externally anchored</Badge>
                </div>
                <code data-testid="packet-manifest-digest">{record.manifestDigest}</code>
                <p>
                  Keep this full digest outside the downloaded packet for independent verification. It is not a person’s
                  signature.
                </p>
                <Button kind="quiet" disabled={busy || !allowed} onClick={() => void copyManifest()}>
                  Copy packet manifest digest
                </Button>
              </div>
              <div className="export-actions">
                <Button kind="primary" disabled={busy || !allowed} onClick={() => void download()}>
                  {read.working === 'downloading' ? (
                    <Spinner label="Checking packet download" />
                  ) : (
                    'Download selected packet'
                  )}
                </Button>
              </div>
              <details className="export-details">
                <summary>Packet details and verification limits</summary>
                <p className="export-caption">
                  Packet <span className="mono">{record.id}</span> · <code>{record.format}</code>.{' '}
                  {'findingId' in record ? (
                    <>
                      Finding <span className="mono">{record.findingId}</span>.
                    </>
                  ) : (
                    <>
                      Selected decision <span className="mono">{record.decisionId}</span>.
                    </>
                  )}
                </p>
                <label className="digest-label">
                  Exact packet bytes · SHA-256<code data-testid="packet-byte-digest">{record.packetSha256}</code>
                </label>
                <dl className="inspection-facts">
                  <div>
                    <dt>Exact packet bytes</dt>
                    <dd>{record.byteLength.toLocaleString()}</dd>
                  </div>
                  <div>
                    <dt>Maximum events / receipts / sources</dt>
                    <dd>
                      {record.limits.maxEvents} / {record.limits.maxReceipts} / {record.limits.maxArtifacts}
                    </dd>
                  </div>
                  <div>
                    <dt>Maximum packet / original bytes</dt>
                    <dd>
                      {byteSize(record.limits.maxPacketBytes)} /{' '}
                      {'maxOriginalBytes' in record.limits ? byteSize(record.limits.maxOriginalBytes) : 'none carried'}
                    </dd>
                  </div>
                </dl>
                <div className="export-limitations">
                  <h5>Verification limits</h5>
                  <ul>
                    {limitationsOf(record).map((limitation) => (
                      <li key={limitation}>{limitation}</li>
                    ))}
                  </ul>
                  <p>
                    Matching the downloaded bytes to the Ledger record checks download integrity. Independent
                    verification requires the separately retained manifest digest and the standalone packet verifier:
                  </p>
                  <pre>{verifierCommand}</pre>
                </div>
              </details>
            </>
          )}
        </>
      )}
    </section>
  );
}
