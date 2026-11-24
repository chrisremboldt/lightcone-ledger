import type {
  EvidenceEnvelope,
  FlightEvidenceBundle,
  MissionInput,
  MissionRevisionRecord,
  MissionSource,
  SubjectEvidenceBundle,
} from '../../packages/contracts/src/index.js';
import {
  missionInput,
  missionRecord,
  missionRevision2Record,
  missionRevision2Source,
  missionSource,
} from '../../packages/contracts/fixtures/demo/v1/missions.js';
import {
  canonicalDigest,
  canonicalize,
  entryHash,
  INTEGRITY_VERSION,
  sha256,
} from '../../packages/integrity/src/index.js';
import { interpretEvidenceCut } from '../../packages/evidence/src/evidence-cut.mjs';

export function appendMissionHistory<T extends FlightEvidenceBundle | SubjectEvidenceBundle>(bundle: T): T {
  const tenantId = bundle.manifest.tenantId;
  for (const [index, fixture] of [missionSource, missionRevision2Source].entries()) {
    const raw: MissionSource = {
      ...structuredClone(fixture),
      sourceMissionId: index === 0 ? fixture.sourceMissionId : `${fixture.sourceMissionId}:unrelated`,
    };
    const { sourceRevision, occurredAt, ...payload } = raw;
    const flightId =
      index === 0 && bundle.manifest.subject.kind === 'flight'
        ? bundle.manifest.subject.id
        : `unrelated-mission-flight-${index}`;
    const input: MissionInput = {
      ...missionInput,
      sourceRevision,
      occurredAt,
      subject: { flightId },
      artifactId: `mission-artifact-${index}`,
      payload,
    };
    const bytes = Buffer.from(JSON.stringify(raw), 'utf8');
    const original = { sha256: sha256(bytes), byteLength: bytes.byteLength };
    const record: MissionRevisionRecord = {
      ...(index === 0 ? missionRecord : missionRevision2Record),
      ...payload,
      id: `mission-event-${index}`,
      missionId: `mission-${index}`,
      flightId,
      sourceId: input.sourceId,
      sourceRevision,
      occurredAt,
      receiptId: `mission-receipt-${index}`,
      artifactId: input.artifactId,
      original,
      contentDigest: canonicalDigest({
        version: 'ledger.mission-content.1',
        sourceId: input.sourceId,
        flightId,
        sourceRevision,
        occurredAt,
        fidelity: input.fidelity,
        payload,
        original: { ...original, bytesBase64: bytes.toString('base64') },
      }),
      authority: {
        ...missionRecord.authority,
        principalId: 'mission-adapter',
        tenantId,
        grantedSources: [input.sourceId, 'another-mission-source'],
      },
    };
    const { id, recordedAt, ...acceptance } = record;
    const streamId = `mission-stream-${index}`;
    const envelope: EvidenceEnvelope = {
      eventId: id,
      tenantId,
      streamId,
      sequence: '1',
      type: input.kind,
      schemaVersion: 1,
      principalId: record.authority.principalId,
      sourceId: input.sourceId,
      sourceSessionId: null,
      occurredAt,
      effectiveAt: null,
      receivedAt: recordedAt,
      causationId: null,
      artifactId: input.artifactId,
      payload: { ...input, flightId, acceptedAuthority: record.authority, acceptance },
    };
    const envelopeDigest = canonicalDigest(envelope);
    const hash = entryHash(tenantId, streamId, 1n, '', envelopeDigest);
    bundle.entries.push({
      canonicalEnvelope: canonicalize(envelope),
      envelopeDigest,
      previousHash: '',
      entryHash: hash,
      encodingVersion: INTEGRITY_VERSION,
    });
    bundle.streams.push({
      tenantId,
      id: streamId,
      name: `source:mission-adapter:${input.sourceId}:mission:${payload.sourceMissionId}`,
      headSequence: '1',
      headHash: hash,
      cutHeads: {
        rendered: { sequence: '0', hash: '' },
        accepted: { sequence: '0', hash: '' },
        issuance: { sequence: '1', hash },
      },
    });
    bundle.receipts.push({
      tenantId,
      id: record.receiptId,
      eventId: id,
      sourceId: input.sourceId,
      kind: input.kind,
      occurredAt,
      receivedAt: recordedAt,
      sourceRevision: String(sourceRevision),
      artifactId: input.artifactId,
      payload,
      inputSubject: input.subject,
    });
    bundle.artifacts.push({
      tenantId,
      id: input.artifactId,
      ...original,
      contentType: 'application/json',
      bytesBase64: bytes.toString('base64'),
    });
    bundle.cuts.issuance.streams[streamId] = 1;
    if (Date.parse(recordedAt) > Date.parse(bundle.manifest.issuedAt)) {
      bundle.manifest.issuedAt = recordedAt;
      bundle.snapshot.capturedAt = recordedAt;
    }
  }
  bundle.manifest.counts = {
    ...bundle.manifest.counts,
    events: bundle.entries.length,
    streams: bundle.streams.length,
    receipts: bundle.receipts.length,
    artifacts: bundle.artifacts.length,
    artifactBytes: bundle.artifacts.reduce((sum, artifact) => sum + artifact.byteLength, 0),
  };
  for (const name of ['rendered', 'accepted', 'issuance'] as const)
    bundle.interpretations[name] = interpretEvidenceCut(bundle.entries, bundle.cuts[name], tenantId);
  bundle.manifest.sectionDigests = Object.fromEntries(
    Object.entries(bundle)
      .filter(([name]) => !['format', 'manifest', 'manifestDigest'].includes(name))
      .map(([name, value]) => [name, canonicalDigest(value)]),
  ) as typeof bundle.manifest.sectionDigests;
  bundle.manifest.interpretationDigests = {
    rendered: canonicalDigest(bundle.interpretations.rendered),
    accepted: canonicalDigest(bundle.interpretations.accepted),
    issuance: canonicalDigest(bundle.interpretations.issuance),
  };
  bundle.manifestDigest = canonicalDigest(bundle.manifest);
  return bundle;
}
