import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type TranslationContext,
  type VendorMessage,
  InMemoryObservationSink,
  translateAndSubmit,
} from '../src/adapter-contract.js';
import {
  type CommandLinkStatusBinding,
  commandLinkStatusAdapter,
  commandLinkStatusDescriptor,
} from '../src/command-link-status.js';
import { assertAdapterConformance } from '../src/conformance.js';

const binding = { sourceSessionId: 'capture:alpha:one', aircraftId: 'fictional-aircraft-one' };
const context: TranslationContext<CommandLinkStatusBinding> = {
  subjects: { scope: 'ledger', ids: { flight: { [binding.sourceSessionId]: 'flight-alpha' } } },
  binding,
};

function message(source: Record<string, unknown>): VendorMessage {
  return {
    bytes: new TextEncoder().encode(`${JSON.stringify(source, null, 2)}\n`),
    contentType: 'application/json',
    transport: { method: 'POST', path: '/command-link' },
    capturedAt: '2026-10-15T14:12:01.000Z',
  };
}

describe('command-link report adapter on the contract', () => {
  it('passes the conformance kit against its golden files', async () => {
    const report = await assertAdapterConformance({
      adapter: commandLinkStatusAdapter,
      context,
      goldenDirectory: join(import.meta.dirname, '../src/golden/command-link-status'),
    });
    expect(report.checked).toMatchObject({ goldens: 7, observations: 2 });
  });

  it('retains the exact report bytes once and submits one cited transition, idempotently', async () => {
    const reported = message({
      sourceSessionId: binding.sourceSessionId,
      sourceEventId: 'loss–one',
      incidentId: 'incident-one',
      aircraftId: binding.aircraftId,
      occurredAt: '2026-10-15T14:12:00Z',
      status: 'lost',
    });
    const sink = new InMemoryObservationSink();
    const first = await translateAndSubmit(commandLinkStatusAdapter, reported, context, sink);
    const replay = await translateAndSubmit(commandLinkStatusAdapter, reported, context, sink);
    expect(replay.submitted.map((entry) => entry.receiptId)).toEqual(first.submitted.map((entry) => entry.receiptId));
    expect(sink.observations).toHaveLength(1);
    expect(sink.originals.get(first.artifactId!)?.bytes).toEqual(reported.bytes);
    expect(first.submitted[0]!.observation).toEqual({
      type: 'link.status',
      version: 1,
      subject: { kind: 'flight', id: 'flight-alpha', scope: 'ledger' },
      secondarySubject: { kind: 'aircraft', id: binding.aircraftId, scope: 'source' },
      occurredAt: '2026-10-15T14:12:00Z',
      sourceEventId: 'loss–one',
      sourceSessionId: binding.sourceSessionId,
      values: { link: 'command_control', state: 'down', report: 'transition', sourceEpisodeId: 'incident-one' },
      fidelity: 'synthetic_contract',
      limitations: commandLinkStatusDescriptor.limitations,
      originalArtifactId: first.artifactId,
    });
  });
});
