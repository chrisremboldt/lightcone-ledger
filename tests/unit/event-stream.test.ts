import { expect, test } from 'vitest';
import { parseEventStream } from '../../packages/contracts/src/event-stream.js';
import { LedgerClient } from '../../packages/contracts/src/client.js';

function bytes(text: string, chunkSize = 1) {
  const input = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < input.length; offset += chunkSize)
        controller.enqueue(input.slice(offset, offset + chunkSize));
      controller.close();
    },
  });
}
async function frames(text: string, chunkSize = 1) {
  const result = [];
  for await (const frame of parseEventStream(bytes(text, chunkSize))) result.push(frame);
  return result;
}
test('UTF-8 framing spans chunk and CRLF boundaries, ignores comments, and retains the last delivered id', async () => {
  expect(
    await frames(
      '\ufeff: heartbeat\r\nid: cut-1\r\nevent: telemetry.updated\r\ndata: {"note":\r\ndata: "München"}\r\n\r\ndata: next\n\n',
    ),
  ).toEqual([
    { id: 'cut-1', event: 'telemetry.updated', data: '{"note":\n"München"}' },
    { id: 'cut-1', event: 'message', data: 'next' },
  ]);
});
test('oversized lines and accumulated event data are rejected before unbounded buffering', async () => {
  await expect(frames(`data: ${'x'.repeat(65537)}`, 1024)).rejects.toThrow('bounded size');
  await expect(frames(`data: ${'x'.repeat(40000)}\ndata: ${'x'.repeat(40000)}\n\n`, 1024)).rejects.toThrow(
    'bounded size',
  );
});
test('the SDK resumes with a fresh bearer header and never puts the token or cursor in its URL', async () => {
  let call = 0;
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    call++;
    expect(String(url)).toBe('http://ledger.test/v1/flights/flight%2Fone/watch');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer token-${call}`);
    expect(new Headers(init?.headers).get('last-event-id')).toBe('cut-previous');
    return new Response(
      bytes(
        'id: cut-next\nevent: telemetry.updated\ndata: {"type":"telemetry.updated","flightId":"flight/one","revision":4,"cursor":"cut-next","eventId":"event-one"}\n\n',
      ),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  }) as typeof fetch;
  const client = new LedgerClient('http://ledger.test', () => `token-${call + 1}`, fetcher);
  for (let i = 0; i < 2; i++) {
    const got = [];
    for await (const frame of client.watchFlight('flight/one', { cursor: 'cut-previous' })) got.push(frame);
    expect(got[0]?.id).toBe('cut-next');
    expect(got[0]?.data.type).toBe('telemetry.updated');
  }
});
