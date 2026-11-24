import { describe, expect, it } from 'vitest';
import {
  InMemoryObservationSink,
  translateAndSubmit,
  type TranslationContext,
} from '../../packages/adapters/src/adapter-contract.js';
import {
  commandLinkStatusAdapter,
  type CommandLinkStatusBinding,
} from '../../packages/adapters/src/command-link-status.js';
import {
  commandLinkLossSource,
  commandLinkRestorationSource,
} from '../../packages/contracts/fixtures/demo/v1/command-link.js';
import { sha256 } from '../../packages/integrity/src/index.js';
import type { CommandLinkSource, LinkStatusObservationV1 } from '../../packages/contracts/src/index.js';
import {
  commandLinkReportFromObservation,
  evaluateCommandLinkEvidence,
  type CommandLinkEvidenceReport,
} from '../../packages/domain/src/rules/command-link-evidence-v1.js';

const flightId = 'flight-parity';
const sourceId = 'command-link';

// The reports the existing fixtures send: the demo loss and restoration, one without position, one with a
// non-ASCII event id, and a restoration at the same instant as a loss in another incident.
const fixtures: CommandLinkSource[] = [
  commandLinkLossSource,
  commandLinkRestorationSource,
  { ...commandLinkLossSource, sourceEventId: 'loss–2', incidentId: 'incident-2', position: undefined },
  {
    ...commandLinkRestorationSource,
    sourceEventId: 'restore–2',
    incidentId: 'incident-2',
    occurredAt: '2026-10-15T14:13:00.250Z',
  },
  { ...commandLinkLossSource, sourceEventId: 'loss-3', incidentId: 'incident-3', occurredAt: '2026-10-15T14:14:00Z' },
  {
    ...commandLinkRestorationSource,
    sourceEventId: 'restore-3',
    incidentId: 'incident-3',
    occurredAt: '2026-10-15T14:14:00Z',
  },
].map((source) => JSON.parse(JSON.stringify(source)) as CommandLinkSource);

const bytesOf = (source: CommandLinkSource) => Buffer.from(`${JSON.stringify(source, null, 2)}\n`);

// What the dedicated acceptor retained for each fixture report, and the digest and length of the original bytes it
// verified, captured before that acceptor was removed. The adapter must keep carrying exactly these.
const retainedByAcceptor = [
  {
    sourceSessionId: 'demo-71031:link:capture:1',
    sourceEventId: 'link-event:1',
    incidentId: 'demo-71031:incident:regional-link:1',
    aircraftId: 'demo-71031:aircraft:1',
    occurredAt: '2026-10-15T14:12:00.000Z',
    status: 'lost',
    sha256: 'b26a7ea8da8e96797a793196a7d8f9cd226393f9634cb3c72790ea4f663ab470',
    byteLength: 314,
  },
  {
    sourceSessionId: 'demo-71031:link:capture:1',
    sourceEventId: 'link-event:2',
    incidentId: 'demo-71031:incident:regional-link:1',
    aircraftId: 'demo-71031:aircraft:1',
    occurredAt: '2026-10-15T14:12:30.000Z',
    status: 'restored',
    sha256: '0546ba3f8da204a033fc42deb97aec0a06e68fd4eea6a9fff2cb246e28b7cb65',
    byteLength: 318,
  },
  {
    sourceSessionId: 'demo-71031:link:capture:1',
    sourceEventId: 'loss–2',
    incidentId: 'incident-2',
    aircraftId: 'demo-71031:aircraft:1',
    occurredAt: '2026-10-15T14:12:00.000Z',
    status: 'lost',
    sha256: '83175a37d0f83d4c0315905a7aa3ef80444efa5adb4458e1ce154f087f8fcece',
    byteLength: 215,
  },
  {
    sourceSessionId: 'demo-71031:link:capture:1',
    sourceEventId: 'restore–2',
    incidentId: 'incident-2',
    aircraftId: 'demo-71031:aircraft:1',
    occurredAt: '2026-10-15T14:13:00.250Z',
    status: 'restored',
    sha256: 'a3f8ec743f20f5760a96c3a7ae439770de2b247fc4ed9fb9a498660fa642a4b8',
    byteLength: 296,
  },
  {
    sourceSessionId: 'demo-71031:link:capture:1',
    sourceEventId: 'loss-3',
    incidentId: 'incident-3',
    aircraftId: 'demo-71031:aircraft:1',
    occurredAt: '2026-10-15T14:14:00.000Z',
    status: 'lost',
    sha256: 'f5ea610dadde7f5246486aa6898f44719894a9645ca94a3e51a4fd5b8ce6ed06',
    byteLength: 283,
  },
  {
    sourceSessionId: 'demo-71031:link:capture:1',
    sourceEventId: 'restore-3',
    incidentId: 'incident-3',
    aircraftId: 'demo-71031:aircraft:1',
    occurredAt: '2026-10-15T14:14:00.000Z',
    status: 'restored',
    sha256: '650c997cbe1814f694daa783e243a9b63475720174fb1e9d6d6b7ccb46cee246',
    byteLength: 290,
  },
];

function legacyReport(_source: CommandLinkSource, index: number): CommandLinkEvidenceReport {
  const { sha256: _digest, byteLength: _length, ...report } = retainedByAcceptor[index]!;
  return {
    flightId,
    eventId: `event-${index}`,
    receiptId: `receipt-${index}`,
    sourceId,
    ...report,
    status: report.status as CommandLinkEvidenceReport['status'],
  };
}

async function observedReport(source: CommandLinkSource, index: number) {
  const context: TranslationContext<CommandLinkStatusBinding> = {
    subjects: { scope: 'ledger', ids: { flight: { [source.sourceSessionId]: flightId } } },
    binding: { sourceSessionId: source.sourceSessionId, aircraftId: source.aircraftId },
  };
  const sink = new InMemoryObservationSink();
  const bytes = bytesOf(source);
  const outcome = await translateAndSubmit(
    commandLinkStatusAdapter,
    { bytes, contentType: 'application/json', transport: {}, capturedAt: '2026-10-15T14:20:00.000Z' },
    context,
    sink,
  );
  expect(outcome.rejections).toEqual([]);
  expect(sink.originals.get(outcome.artifactId!)?.bytes).toEqual(bytes);
  expect({ sha256: sha256(bytes), byteLength: bytes.byteLength }).toEqual({
    sha256: retainedByAcceptor[index]!.sha256,
    byteLength: retainedByAcceptor[index]!.byteLength,
  });
  const observation = outcome.submitted[0]!.observation as LinkStatusObservationV1;
  expect(observation.position).toEqual(
    source.position
      ? { latitudeDegrees: source.position.latitude, longitudeDegrees: source.position.longitude }
      : undefined,
  );
  return commandLinkReportFromObservation(observation, {
    flightId,
    eventId: `event-${index}`,
    receiptId: `receipt-${index}`,
    sourceId,
  });
}

describe('lost-link reports through the observation adapter', () => {
  it('carry every field the dedicated acceptor retained, over the same original bytes', async () => {
    for (const [index, source] of fixtures.entries())
      expect(await observedReport(source, index)).toEqual(legacyReport(source, index));
  });

  it('give the lost-link rule the same result as the dedicated acceptor', async () => {
    const clock = { mode: 'wall' as const, evaluatedAt: '2026-10-15T15:00:00.000Z' };
    for (let count = 1; count <= fixtures.length; count++) {
      const selected = fixtures.slice(0, count);
      const legacy = selected.map(legacyReport);
      const observed = await Promise.all(selected.map(observedReport));
      expect(
        evaluateCommandLinkEvidence({ flightId, clock, reports: observed as CommandLinkEvidenceReport[] }),
      ).toEqual(evaluateCommandLinkEvidence({ flightId, clock, reports: legacy }));
    }
  });

  it('leave other link.status observations out of the rule', () => {
    const [loss] = fixtures;
    const observation: LinkStatusObservationV1 = {
      type: 'link.status',
      version: 1,
      subject: { kind: 'flight', id: flightId, scope: 'ledger' },
      secondarySubject: { kind: 'aircraft', id: loss!.aircraftId, scope: 'source' },
      occurredAt: loss!.occurredAt,
      sourceEventId: 'sample-1',
      sourceSessionId: loss!.sourceSessionId,
      fidelity: 'synthetic_contract',
      limitations: [],
      originalArtifactId: 'artifact-sample',
      values: { link: 'command_control', state: 'down', report: 'sample', sourceEpisodeId: 'incident-1' },
    };
    const identity = { flightId, eventId: 'event-sample', receiptId: 'receipt-sample', sourceId };
    expect(commandLinkReportFromObservation(observation, identity)).toBeUndefined();
    expect(
      commandLinkReportFromObservation({ ...observation, values: { ...observation.values, link: 'video' } }, identity),
    ).toBeUndefined();
    const { sourceEpisodeId: _episode, ...withoutEpisode } = observation.values;
    expect(
      commandLinkReportFromObservation(
        { ...observation, values: { ...withoutEpisode, report: 'transition' } },
        identity,
      ),
    ).toBeUndefined();
  });
});
