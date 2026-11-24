import type {
  EvidenceEnvelope,
  FlightEvidenceBundle,
  SubjectEvidenceBundle,
} from '../../packages/contracts/src/index.js';
import type {
  CommandLinkBaselineAuthority,
  CommandLinkBaselineInput,
  CommandLinkBaselineSource,
} from '../../packages/contracts/src/command-link-baseline.js';
import type { CommandLinkInput, CommandLinkSource } from '../../packages/contracts/src/command-link-proposal.js';
import { baselineSource } from '../../packages/contracts/fixtures/demo/v1/monitoring-window.js';
import { canonicalDigest, sha256 } from '../../packages/integrity/src/index.js';
import { appendJournalHistory } from './journal-history-fixture.js';

type Bundle = FlightEvidenceBundle | SubjectEvidenceBundle;
type Source = CommandLinkBaselineSource | CommandLinkSource;

export function appendCommandLinkBaselineHistory<T extends Bundle>(bundle: T, options: { flightId?: string } = {}): T {
  const tenantId = bundle.manifest.tenantId;
  const flightId =
    options.flightId ??
    (bundle.manifest.subject.kind === 'flight' ? bundle.manifest.subject.id : 'unrelated-native-flight');
  const native: CommandLinkBaselineSource = { ...baselineSource, flightId };
  const unrelated: CommandLinkBaselineSource = {
    ...native,
    sourceSessionId: `${native.sourceSessionId}:unrelated`,
    sourceEventId: 'unrelated-native-baseline',
    flightId: 'unrelated-native-flight-2',
    aircraftId: 'unrelated-native-aircraft',
    state: 'unknown',
  };

  function envelope(
    source: Source,
    streamId: string,
    sequence: number,
    principalId: string,
    index: number,
  ): EvidenceEnvelope {
    const artifactId = `native-c2-artifact-${index}`;
    const baseline = 'version' in source;
    let input: CommandLinkBaselineInput | CommandLinkInput;
    if (baseline) {
      const { sourceId, sourceSessionId, flightId, occurredAt, ...payload } = source;
      input = {
        sourceId,
        sourceSessionId,
        kind: 'command-link.baseline',
        occurredAt,
        subject: { flightId },
        artifactId,
        fidelity: 'synthetic_contract',
        payload,
      };
    } else {
      const { sourceSessionId, occurredAt, ...payload } = source;
      input = {
        sourceId: native.sourceId,
        sourceSessionId,
        kind: 'command-link.status',
        occurredAt,
        subject: { flightId },
        artifactId,
        fidelity: 'synthetic_contract',
        payload,
      };
    }
    const acceptedAuthority = {
      version: baseline ? 'ledger.command-link-baseline-authority.1' : 'ledger.command-link-authority.1',
      principalId,
      tenantId,
      principalRevision: 2,
      inputKind: input.kind,
      sourceId: input.sourceId,
      requiredCapabilities: ['input:write', 'command-link:write'],
      grantedSources: [input.sourceId, 'another-granted-source'],
    } satisfies Omit<CommandLinkBaselineAuthority, 'version' | 'inputKind'> & { version: string; inputKind: string };
    const bytes = Buffer.from(JSON.stringify(source, null, 2) + '\n');
    const receivedAt = new Date(Date.parse(input.occurredAt) + 1000).toISOString();
    const event: EvidenceEnvelope = {
      eventId: `native-c2-event-${index}`,
      tenantId,
      streamId,
      sequence: String(sequence),
      type: input.kind,
      schemaVersion: 1,
      principalId,
      sourceId: input.sourceId,
      sourceSessionId: input.sourceSessionId,
      occurredAt: input.occurredAt,
      effectiveAt: null,
      receivedAt,
      causationId: null,
      artifactId,
      payload: { ...input, flightId: input.subject.flightId, acceptedAuthority },
    };
    bundle.receipts.push({
      tenantId,
      id: `native-c2-receipt-${index}`,
      eventId: event.eventId,
      sourceId: input.sourceId,
      kind: input.kind,
      occurredAt: input.occurredAt,
      receivedAt,
      sourceRevision: null,
      artifactId,
      payload: input.payload,
      inputSubject: input.subject,
    });
    bundle.artifacts.push({
      tenantId,
      id: artifactId,
      sha256: sha256(bytes),
      byteLength: bytes.byteLength,
      contentType: 'application/json',
      bytesBase64: bytes.toString('base64'),
    });
    return event;
  }
  const loss: CommandLinkSource = {
    sourceSessionId: native.sourceSessionId,
    sourceEventId: 'native-loss',
    incidentId: 'native-incident',
    aircraftId: native.aircraftId,
    occurredAt: '2026-10-15T14:14:00Z',
    status: 'lost',
  };
  const restored: CommandLinkSource = {
    ...loss,
    sourceEventId: 'native-restored',
    occurredAt: '2026-10-15T14:16:00Z',
    status: 'restored',
  };
  for (const [events, name] of [
    [
      [envelope(native, 'native-baseline-stream', 1, 'native-baseline-adapter', 0)],
      `source:native-baseline-adapter:${native.sourceId}:${native.sourceSessionId}`,
    ],
    [
      [
        envelope(loss, 'native-status-stream', 1, 'native-status-adapter', 1),
        envelope(restored, 'native-status-stream', 2, 'native-status-adapter', 2),
      ],
      `source:native-status-adapter:${native.sourceId}:${native.sourceSessionId}`,
    ],
    [
      [envelope(unrelated, 'unrelated-native-baseline-stream', 1, 'native-baseline-adapter', 3)],
      `source:native-baseline-adapter:${unrelated.sourceId}:${unrelated.sourceSessionId}`,
    ],
  ] as const)
    appendJournalHistory(bundle, [...events], name);
  bundle.manifest.counts = {
    ...bundle.manifest.counts,
    receipts: bundle.receipts.length,
    artifacts: bundle.artifacts.length,
    artifactBytes: bundle.artifacts.reduce((sum, artifact) => sum + artifact.byteLength, 0),
  };
  bundle.manifestDigest = canonicalDigest(bundle.manifest);
  return bundle;
}
