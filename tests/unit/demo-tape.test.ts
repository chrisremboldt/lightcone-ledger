import { beforeAll, describe, expect, it } from 'vitest';

type TapeModule = typeof import('../../apps/web/src/autopilot/tape.js');
let tape: TapeModule;

beforeAll(async () => {
  // The recorder resolves request paths against the page's origin.
  (globalThis as { window?: unknown }).window = { location: { origin: 'http://demo.test' } };
  tape = await import('../../apps/web/src/autopilot/tape.js');
});

/** A fake API: each path answers with the current state and a fresh request id, as the real one does. */
function api(state: Record<string, string>) {
  let request = 0;
  const real: typeof fetch = async (input, init) => {
    const url = new URL(String(input), 'http://demo.test');
    if ((init?.method ?? 'GET') !== 'GET') return Response.json({ ok: true });
    const body = { value: state[url.pathname + url.search] ?? 'none', meta: { requestId: `request-${++request}` } };
    return Response.json(body);
  };
  return real;
}

const read = async (fetcher: typeof fetch, path: string) =>
  ((await (await fetcher(path)).json()) as { value: string }).value;

describe('demo recordings', () => {
  it('keep a read once while only its request id changes, and replay it unchanged after writes', async () => {
    const state: Record<string, string> = { '/v1/a': 'first', '/v1/b?x=1': 'one' };
    const recording = tape.recorder('test', api(state));
    expect(await read(recording.fetcher, '/v1/a')).toBe('first');
    expect(await read(recording.fetcher, '/v1/a')).toBe('first');
    await recording.fetcher('/v1/commands', { method: 'POST', body: '{}' });
    expect(await read(recording.fetcher, '/v1/b?x=1')).toBe('one');
    state['/v1/b?x=2'] = 'two';
    await recording.fetcher('/v1/commands', { method: 'POST', body: '{}' });
    state['/v1/a'] = 'second';
    const recorded = await recording.finish();

    expect(recorded.epochs[0]!['anonymous GET /v1/a']).toHaveLength(1);
    // Unchanged in the epoch after the first write, so that epoch does not hold it again.
    expect(recorded.epochs[1]!['anonymous GET /v1/a']).toBeUndefined();
    expect(recorded.epochs[2]!['anonymous GET /v1/a']).toHaveLength(1);

    const replay = tape.replayer(recorded, () => true);
    expect(await read(replay.fetcher, '/v1/a')).toBe('first');
    await replay.fetcher('/v1/commands', { method: 'POST', body: '{}' });
    expect(await read(replay.fetcher, '/v1/a')).toBe('first');
    expect(await read(replay.fetcher, '/v1/b?x=1')).toBe('one');
    await replay.fetcher('/v1/commands', { method: 'POST', body: '{}' });
    expect(await read(replay.fetcher, '/v1/a')).toBe('second');
    expect(await read(replay.fetcher, '/v1/b?x=1')).toBe('one');
  });
});
