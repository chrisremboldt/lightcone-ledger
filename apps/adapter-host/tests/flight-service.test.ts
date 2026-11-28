import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseHostOptions, runAdapterHost, hostUsage } from '../src/host.js';
import { answerSkydioRequest, skydioEmulatorState } from '../../emulators/src/skydio.js';

const secret = 'ledger-service-fictional-secret-value';
const serviceToken = 'fictional-flight-service-token';
const env = {
  LEDGER_API_CREDENTIAL: secret,
  LEDGER_CREDENTIAL_LABEL: 'Flight service adapter on the fictional hangar host',
  LEDGER_API_URL: 'http://127.0.0.1:4000',
  ADAPTER_SERVICE_TOKEN: serviceToken,
};
const flights = ['skydio-cloud-flights', '--service-url', 'http://127.0.0.1:4002'];

interface Stored {
  id: string;
  receiptId: string;
  sourceId: string;
  receivedAt: string;
  replaces?: string;
  observation: {
    type: string;
    occurredAt: string;
    sourceEventId?: string;
    subject: { kind: string; id: string };
    values: Record<string, unknown>;
  };
}

/** The emulated flight service and just enough of the public API: sign-in, uploads, inputs and the read on file. */
function fakes(options: { capabilities?: string[]; knownToken?: string } = {}) {
  const service = skydioEmulatorState(new Date().toISOString());
  const stored: Stored[] = [];
  const asked: { path: string; authorization: string | null }[] = [];
  const replies = new Map<string, string>();
  let clock = Date.now();
  const uploads = new Map<string, { sha256?: string; byteLength: number; contentType: string }>();
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetcher = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const target = new URL(String(url));
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    if (target.port === '4002') {
      asked.push({ path: `${target.pathname}${target.search}`, authorization: headers.get('authorization') });
      const answer = answerSkydioRequest(
        service,
        options.knownToken ?? serviceToken,
        {
          method,
          path: target.pathname,
          query: target.searchParams,
          authorization: headers.get('authorization') ?? undefined,
        },
        new Date(clock).toISOString(),
      )!;
      return new Response(answer.body, { status: answer.status, headers: answer.headers });
    }
    if (headers.get('authorization') !== `Bearer ${secret}`)
      return json(401, { error: { code: 'unauthenticated', message: 'Credential is invalid' } });
    if (target.pathname === '/v1/me')
      return json(200, {
        principal: {
          id: 'principal-fictional-flights',
          name: 'Fictional flight service source',
          capabilities: options.capabilities ?? ['input:write', 'evidence:read'],
          observationGrants: ['flight.report', 'position.fix'].map((observationType) => ({
            sourceId: 'fictional-flights',
            observationType,
          })),
        },
        organization: { name: 'Fictional Aerial Survey' },
      });
    if (method === 'GET' && target.pathname === '/v1/observations') {
      const replaced = new Set(stored.map((entry) => entry.replaces));
      return json(200, {
        observations: stored
          .filter(
            (entry) =>
              !replaced.has(entry.id) &&
              entry.observation.type === target.searchParams.get('type') &&
              entry.observation.subject.id === target.searchParams.get('subjectId'),
          )
          .map((entry) => ({ ...entry, sourceEventId: entry.observation.sourceEventId })),
      });
    }
    const key = headers.get('idempotency-key');
    if (key && replies.has(key)) return json(201, JSON.parse(replies.get(key)!));
    let body: unknown;
    if (method === 'POST' && target.pathname === '/v1/uploads') {
      const id = `upload-${uploads.size + 1}`;
      uploads.set(id, JSON.parse(String(init.body)));
      body = { upload: { id, ...uploads.get(id), status: 'pending' } };
    } else if (method === 'PUT') {
      const id = target.pathname.split('/')[3]!;
      uploads.get(id)!.sha256 = createHash('sha256')
        .update(init.body as Uint8Array)
        .digest('hex');
      return json(200, { upload: { id, ...uploads.get(id), status: 'stored' } });
    } else if (target.pathname.endsWith('/finalize')) {
      const id = target.pathname.split('/')[3]!;
      body = { artifact: { id: `artifact-${id}`, uploadId: id, ...uploads.get(id) } };
    } else if (target.pathname === '/v1/inputs') {
      const input = JSON.parse(String(init.body)) as {
        sourceId: string;
        replaces?: string;
        payload: Stored['observation'];
      };
      if (stored.some((entry) => entry.observation.sourceEventId === input.payload.sourceEventId))
        return json(409, { error: { code: 'source_event_conflict', message: 'Already retained' } });
      const id = `observation-${stored.length + 1}`;
      stored.push({
        id,
        receiptId: `receipt-${stored.length + 1}`,
        sourceId: input.sourceId,
        receivedAt: new Date(Date.now() + stored.length).toISOString(),
        ...(input.replaces ? { replaces: input.replaces } : {}),
        observation: input.payload,
      });
      body = { receipt: { id: `receipt-${stored.length}`, eventId: id, kind: 'observation' } };
    } else return json(404, { error: { code: 'not_found', message: target.pathname } });
    if (key) replies.set(key, JSON.stringify(body));
    return json(201, body);
  }) as typeof fetch;
  return { fetcher, service, stored, asked, advance: (minutes: number) => (clock += minutes * 60_000) };
}

/** One run of the process: started, left to read until a condition holds, then stopped. */
async function runUntil(
  setup: ReturnType<typeof fakes>,
  done: () => boolean,
  args: string[] = [],
): Promise<{ code: number; events: { event: string; message: string; [detail: string]: unknown }[]; text: string }> {
  const lines: string[] = [];
  const stop = new AbortController();
  const running = runAdapterHost([...flights, ...args], env, {
    out: (line) => lines.push(line),
    stop: stop.signal,
    fetcher: setup.fetcher,
  });
  const deadline = Date.now() + 20_000;
  while (!done() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  stop.abort();
  const code = await running;
  return { code, events: lines.map((line) => JSON.parse(line)), text: lines.join('\n') };
}

describe('the adapter process settings for the flight service', () => {
  it('sends the token as the whole Authorization header and asks for the flights of a look-back period', () => {
    const options = parseHostOptions(flights, env);
    expect(options).toMatchObject({
      adapterId: 'skydio-cloud-flights',
      binding: {},
      service: { url: 'http://127.0.0.1:4002/api/v0/flights', lookBackHours: 168, pollMs: 120_000 },
    });
    // No scheme word: the reference shows the token itself as the header's value.
    expect(options.service!.headers).toEqual({ authorization: serviceToken });
    expect(options.service!.urlAt!(new Date('2026-11-20T16:00:00.000Z'))).toBe(
      'http://127.0.0.1:4002/api/v0/flights?takeoff_since=2026-11-13T16%3A00%3A00Z&per_page=100&page_number=1',
    );
    const day = parseHostOptions([...flights, '--look-back-hours', '24', '--poll-seconds', '300'], env);
    expect(day.service).toMatchObject({ lookBackHours: 24, pollMs: 300_000 });
    expect(day.service!.urlAt!(new Date('2026-11-20T16:00:00.000Z'))).toContain(
      'takeoff_since=2026-11-19T16%3A00%3A00Z',
    );
    expect(() => parseHostOptions([...flights, '--look-back-hours', '0'], env)).toThrow('--look-back-hours');
    expect(() => parseHostOptions(flights, { ...env, ADAPTER_SERVICE_TOKEN: '' })).toThrow(
      'ADAPTER_SERVICE_TOKEN is required',
    );
    expect(() => parseHostOptions([...flights, '--token', serviceToken], env)).toThrow('give it in the environment');
    // Another adapter's poll is not given a look-back.
    const weather = parseHostOptions(
      ['published-metar-observations', '--service-url', 'http://127.0.0.1:4002', '--stations', 'KORD=RIDGE-SITE-1'],
      { ...env, ADAPTER_LOOK_BACK_HOURS: '24' },
    );
    expect(weather.service!.urlAt).toBeUndefined();
    expect(hostUsage).toContain('has NOT been run against the real');
  });
});

describe('the adapter process reading the flight service', () => {
  it('says first that it has not been run against the real service, then reports flights and replaces a changed one', async () => {
    const setup = fakes();
    const reportsOf = (flightId: string) =>
      setup.stored.filter(
        (entry) => entry.observation.type === 'flight.report' && entry.observation.subject.id === flightId,
      );
    const positions = () => setup.stored.filter((entry) => entry.observation.type === 'position.fix');
    const lastPosition = setup.service.flights[0]!.landing!;
    const first = await runUntil(
      setup,
      () => positions().some((entry) => entry.observation.occurredAt === lastPosition),
      ['--metrics-listen', '0'],
    );
    expect(first.code).toBe(0);
    expect(first.events[0]).toMatchObject({ event: 'starting', fidelity: 'synthetic_contract' });
    expect(first.events[0]!.message).toContain('has NOT been run against the real service');
    expect(first.events[0]!.message).toContain('test it against your own account before operational use');
    expect((first.events[0]!.limitations as string[])[0]).toContain('has not been run against the service');
    expect(first.events.map((event) => event.event)).toEqual(
      expect.arrayContaining(['serving_metrics', 'signed_in', 'polling', 'first_submitted', 'stopped']),
    );
    expect(first.events.find((event) => event.event === 'polling')!.message).toBe(
      'Reading /api/v0/flights every 120 s, each time for what began in the 168 hours before it.',
    );
    expect(setup.asked[0]!.authorization).toBe(serviceToken);
    expect(setup.asked[0]!.path).toMatch(/^\/api\/v0\/flights\?takeoff_since=[^&]+Z&per_page=100&page_number=1$/);
    for (const flightId of ['EXAMPLE-FLIGHT-0001', 'EXAMPLE-FLIGHT-0002', 'EXAMPLE-FLIGHT-0003'])
      expect(reportsOf(flightId), flightId).toHaveLength(1);
    expect(reportsOf('EXAMPLE-FLIGHT-0003')[0]!.observation.values).not.toHaveProperty('landingAt');
    expect(positions().length).toBeGreaterThan(200);
    expect(new Set(setup.stored.map((entry) => entry.sourceId))).toEqual(new Set(['fictional-flights']));

    // Nine minutes later the third flight has landed. The process starts again and reads everything again.
    setup.advance(9);
    const count = setup.stored.length;
    const second = await runUntil(setup, () => reportsOf('EXAMPLE-FLIGHT-0003').length === 2);
    expect(second.code).toBe(0);
    const [inProgress, landed] = reportsOf('EXAMPLE-FLIGHT-0003');
    expect(landed).toMatchObject({ replaces: inProgress!.id, observation: { values: { activity: 'landed' } } });
    // Nothing else is recorded again: the same flights and positions are already on file.
    expect(setup.stored).toHaveLength(count + 1);
    expect(second.events.map((event) => event.event)).not.toContain('payload_refused');
    expect(`${first.text}\n${second.text}`).not.toMatch(/fictional-secret-value|fictional-flight-service-token/);
  });

  it('does not start with a credential that may not read what is on file', async () => {
    const setup = fakes({ capabilities: ['input:write'] });
    const { code, events, text } = await runUntil(setup, () => true);
    expect(code).toBe(1);
    expect(events.at(-1)).toMatchObject({ event: 'cannot_start' });
    expect(events.at(-1)!.message).toContain('give it evidence:read on the People screen');
    expect(setup.asked).toEqual([]);
    expect(text).not.toContain(secret);
  });

  it('stops, naming no secret, when the flight service refuses the token', async () => {
    const setup = fakes({ knownToken: 'a-token-issued-later' });
    const lines: string[] = [];
    const code = await runAdapterHost(flights, env, {
      out: (line) => lines.push(line),
      stop: new AbortController().signal,
      fetcher: setup.fetcher,
    });
    expect(code).toBe(1);
    const refusal = lines.map((line) => JSON.parse(line)).find((event) => event.event === 'stopping_on_refusal');
    expect(refusal.message).toBe(
      'The service refused the access token with 401: issue a new one and start the process again',
    );
    expect(setup.stored).toEqual([]);
    expect(lines.join('\n')).not.toMatch(/fictional-secret-value|fictional-flight-service-token/);
  });
});
