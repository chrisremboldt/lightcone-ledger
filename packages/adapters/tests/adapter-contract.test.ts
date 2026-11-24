import { describe, expect, it } from 'vitest';
import {
  type AdapterDescriptor,
  type ObservationAdapter,
  type ObservationDraft,
  type VendorMessage,
  completeObservations,
  decodeStrictJson,
  InMemoryObservationSink,
  jsonPointer,
  observationIdempotencyKey,
  rejected,
  subjectFor,
  translateAndSubmit,
} from '../src/adapter-contract.js';

const descriptor: AdapterDescriptor = {
  id: 'fictivendor-link-report',
  version: '1.0.0',
  source: { vendor: 'Fictivendor', product: 'Fictivendor Link Monitor', interface: 'HTTP POST /links' },
  produces: [{ type: 'link.status', version: 1 }],
  fidelity: 'synthetic_contract',
  limitations: ['Fictional source for tests.'],
  documentation: [{ reference: 'Fictional specification.' }],
};
const draft = (state: 'up' | 'down', pointer: string): ObservationDraft => ({
  type: 'link.status',
  version: 1,
  subject: { kind: 'flight', id: 'flight-alpha', scope: 'ledger' },
  occurredAt: '2026-10-01T17:00:00.000Z',
  originalLocator: jsonPointer('links', pointer),
  values: { link: 'command_control', state, report: 'sample' },
});
const message: VendorMessage = {
  bytes: new TextEncoder().encode('{"links":{"a":"up","b":"down"}}'),
  contentType: 'application/json',
  transport: { method: 'POST', path: '/links' },
  capturedAt: '2026-10-01T17:00:00.100Z',
};

describe('adapter contract', () => {
  it('retains one original and submits every observation citing it, with descriptor fidelity and limitations', async () => {
    const adapter: ObservationAdapter = {
      descriptor,
      translate: () => ({
        drafts: [draft('up', 'a'), { ...draft('down', 'b'), extraLimitations: ['Sampled once.'] }],
        rejections: [],
        unmapped: [],
      }),
    };
    const sink = new InMemoryObservationSink();
    const outcome = await translateAndSubmit(
      adapter,
      message,
      { subjects: { scope: 'source' }, binding: undefined },
      sink,
    );
    expect(sink.originals.size).toBe(1);
    expect(outcome.submitted.map(({ observation }) => observation.originalArtifactId)).toEqual([
      outcome.artifactId,
      outcome.artifactId,
    ]);
    expect(outcome.submitted[1]!.observation.limitations).toEqual(['Fictional source for tests.', 'Sampled once.']);
    expect(new Set(sink.observations.map((entry) => entry.idempotencyKey)).size).toBe(2);
  });

  it('retains nothing when every part of a message is rejected', async () => {
    const sink = new InMemoryObservationSink();
    const outcome = await translateAndSubmit(
      { descriptor, translate: () => rejected('Unsupported report') },
      message,
      { subjects: { scope: 'source' }, binding: undefined },
      sink,
    );
    expect(outcome).toEqual({ submitted: [], rejections: [{ reason: 'Unsupported report' }], unmapped: [] });
    expect(sink.originals.size).toBe(0);
  });

  it('refuses a draft of a type the descriptor does not declare', () => {
    expect(() =>
      completeObservations(
        { ...descriptor, produces: [{ type: 'position.fix', version: 1 }] },
        [draft('up', 'a')],
        'x',
      ),
    ).toThrow('does not declare');
  });

  it('conflicts when one idempotency key carries different content', async () => {
    const sink = new InMemoryObservationSink();
    const [up] = completeObservations(descriptor, [draft('up', 'a')], 'artifact');
    const [down] = completeObservations(descriptor, [draft('down', 'a')], 'artifact');
    const key = observationIdempotencyKey(descriptor.id, message, 0);
    await sink.submitObservation(up!, key);
    await expect(sink.submitObservation(up!, key)).resolves.toEqual({ receiptId: 'memory-receipt-1' });
    await expect(sink.submitObservation(down!, key)).rejects.toThrow('different content');
  });

  it('names subjects by source id or by a bound Ledger id', () => {
    expect(subjectFor({ scope: 'source' }, 'aircraft', 'SN-1')).toEqual({
      kind: 'aircraft',
      id: 'SN-1',
      scope: 'source',
    });
    const ledger = { scope: 'ledger', ids: { aircraft: { 'SN-1': 'aircraft-alpha' } } } as const;
    expect(subjectFor(ledger, 'aircraft', 'SN-1')).toEqual({ kind: 'aircraft', id: 'aircraft-alpha', scope: 'ledger' });
    expect(subjectFor(ledger, 'aircraft', 'SN-2')).toBeUndefined();
    expect(subjectFor(ledger, 'aircraft', 'constructor')).toBeUndefined();
  });

  it('escapes JSON pointers and rejects ambiguous or malformed JSON with a reason', () => {
    expect(jsonPointer('a/b', 'c~d', 0).value).toBe('/a~1b/c~0d/0');
    const encode = (text: string) => new TextEncoder().encode(text);
    expect(decodeStrictJson(encode('{"a":1,"a":1}'), 100)).toEqual({
      ok: false,
      reason: 'JSON object contains a duplicate key',
    });
    expect(decodeStrictJson(encode('{"a":'), 100)).toMatchObject({ ok: false });
    expect(decodeStrictJson(new Uint8Array([0xff]), 100)).toEqual({
      ok: false,
      reason: 'Message body is not valid UTF-8',
    });
    expect(decodeStrictJson(encode('{"a":1}'), 3)).toMatchObject({ ok: false });
    expect(decodeStrictJson(encode('{"a":1}'), 100)).toEqual({ ok: true, value: { a: 1 } });
  });
});
