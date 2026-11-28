import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hostUsage, parseHostOptions, runAdapterHost } from '../src/host.js';
import {
  FLIGHTHUB2_EMULATOR_PROJECT,
  FLIGHTHUB2_EMULATOR_TOKEN,
  FlightHub2Project,
  flightHub2Fetcher,
  inventedFlightTask,
} from '../../emulators/src/flighthub2.js';

// The adapter process run against the emulator, which answers in the documented shapes with invented flights.
// Nothing here has been run against a real FlightHub 2 project.

const secret = 'ledger-service-fictional-secret-value';
const env = {
  LEDGER_API_CREDENTIAL: secret,
  LEDGER_CREDENTIAL_LABEL: 'Completed flights on the fictional hangar host',
  LEDGER_API_URL: 'http://127.0.0.1:4000',
  ADAPTER_SERVICE_TOKEN: FLIGHTHUB2_EMULATOR_TOKEN,
};
const flights = (pointTimes: string, project = FLIGHTHUB2_EMULATOR_PROJECT) => [
  'dji-flighthub2-flights',
  '--service-url',
  'http://127.0.0.1:4002',
  '--project',
  project,
  '--point-times',
  pointTimes,
  '--poll-seconds',
  '5',
];

/** Ledger's public API, just enough of it, in front of the flight task emulator. */
function fakes(project: FlightHub2Project, capabilities = ['input:write', 'evidence:read']) {
  const inputs: Record<string, unknown>[] = [];
  const service = flightHub2Fetcher(project);
  let counter = 0;
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const replies = new Map<string, string>();
  const uploads = new Map<string, { sha256?: string; byteLength: number; contentType: string }>();
  const fetcher = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const target = new URL(String(url));
    if (target.port === '4002') return service(url, init);
    const headers = new Headers(init.headers);
    if (headers.get('authorization') !== `Bearer ${secret}`)
      return json(401, { error: { code: 'unauthenticated', message: 'Credential is invalid' } });
    const key = headers.get('idempotency-key');
    if (key && replies.has(key)) return json(201, JSON.parse(replies.get(key)!));
    let body: unknown;
    if (target.pathname === '/v1/me')
      return json(200, {
        principal: {
          id: 'principal-fictional-flights',
          name: 'Fictional flight source',
          capabilities,
          observationGrants: ['flight.report', 'position.fix'].map((observationType) => ({
            sourceId: 'fictional-flights',
            observationType,
          })),
        },
        organization: { name: 'Example Ridge Survey' },
      });
    // Nothing on file: what the process reads before it reports a flight is covered against the real API.
    if (target.pathname === '/v1/observations') return json(200, { observations: [] });
    if ((init.method ?? 'GET') === 'POST' && target.pathname === '/v1/uploads') {
      const created = JSON.parse(String(init.body)) as { byteLength: number; contentType: string };
      const id = `upload-${++counter}`;
      uploads.set(id, created);
      body = { upload: { id, ...created, status: 'pending' } };
    } else if (init.method === 'PUT') {
      const id = target.pathname.split('/')[3]!;
      uploads.get(id)!.sha256 = createHash('sha256')
        .update(init.body as Uint8Array)
        .digest('hex');
      return json(200, { upload: { id, ...uploads.get(id), status: 'stored' } });
    } else if (target.pathname.endsWith('/finalize')) {
      const id = target.pathname.split('/')[3]!;
      body = { artifact: { id: `artifact-${id}`, uploadId: id, ...uploads.get(id) } };
    } else if (target.pathname === '/v1/inputs') {
      inputs.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      body = { receipt: { id: `receipt-${++counter}`, kind: 'observation' } };
    } else return json(404, { error: { code: 'not_found', message: target.pathname } });
    if (key) replies.set(key, JSON.stringify(body));
    return json(201, body);
  }) as typeof fetch;
  return { fetcher, inputs };
}

const recent = () =>
  new FlightHub2Project([
    inventedFlightTask({
      uuid: 'a1b2c3d4-0000-4000-8000-000000000001',
      runAt: new Date(Date.now() - 3_600_000).toISOString(),
      minutes: 1,
      pointEverySeconds: 20,
    }),
  ]);

async function run(
  argv: string[],
  project: FlightHub2Project,
  until: (inputs: unknown[]) => boolean,
  capabilities?: string[],
) {
  const { fetcher, inputs } = fakes(project, capabilities);
  const lines: string[] = [];
  const stop = new AbortController();
  const running = runAdapterHost(argv, env, { out: (line) => lines.push(line), stop: stop.signal, fetcher });
  let code: number | undefined;
  void running.then((value) => (code = value));
  const deadline = Date.now() + 15_000;
  while (code === undefined && !until(inputs) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  stop.abort();
  const exit = await running;
  const events = lines.map((line) => JSON.parse(line) as { event: string; message: string });
  return { code: exit, events, inputs, text: lines.join('\n') };
}

describe('the adapter process reading completed flights', () => {
  it('takes the organization key from the environment and sends it in its own header, never as a flag', () => {
    const options = parseHostOptions(flights('seconds'), env);
    expect(options).toMatchObject({
      adapterId: 'dji-flighthub2-flights',
      binding: { project: FLIGHTHUB2_EMULATOR_PROJECT, pointTimes: 'seconds' },
      service: { url: 'http://127.0.0.1:4002/openapi/v2.0/flight-task/list', pollMs: 5_000 },
    });
    expect(options.service!.headers).toEqual({ 'x-user-token': FLIGHTHUB2_EMULATOR_TOKEN });
    expect(() => parseHostOptions(flights('seconds'), { ...env, ADAPTER_SERVICE_TOKEN: '' })).toThrow(
      'ADAPTER_SERVICE_TOKEN is required',
    );
    expect(() => parseHostOptions(flights('minutes'), env)).toThrow('seconds or milliseconds');
    expect(() => parseHostOptions(flights('seconds').slice(0, 5), env)).toThrow('--point-times');
    expect(() => parseHostOptions(flights('seconds', 'a project'), env)).toThrow('--project');
    expect(hostUsage).toContain('dji-flighthub2-flights');
  });

  it('says in its first line that it was never run against a real project, then submits the flight and its positions', async () => {
    const { code, events, inputs, text } = await run(flights('seconds'), recent(), (seen) => seen.length >= 5);
    expect(code).toBe(0);
    expect(events[0]).toMatchObject({ event: 'starting', fidelity: 'synthetic_contract' });
    expect(events[0]!.message).toContain('has not been run against a real FlightHub 2 project');
    expect(events[0]!.message).toContain('test it against your own before operational use');
    expect(events.map((event) => event.event)).toEqual(
      expect.arrayContaining(['signed_in', 'polling', 'flight_tasks_listed', 'first_submitted', 'stopped']),
    );
    expect(inputs.map((input) => (input.payload as { type: string }).type)).toEqual([
      'flight.report',
      'position.fix',
      'position.fix',
      'position.fix',
      'position.fix',
    ]);
    expect(inputs[0]).toMatchObject({
      sourceId: 'fictional-flights',
      kind: 'observation',
      payload: { subject: { kind: 'flight', scope: 'source' }, values: { activity: 'landed' } },
    });
    expect(text).not.toContain(secret);
    expect(text).not.toContain(FLIGHTHUB2_EMULATOR_TOKEN);
  });

  it('submits the flight without positions, and says why, while nobody has compared a track', async () => {
    const { code, events, inputs } = await run(flights('not-compared'), recent(), (seen) => seen.length >= 1);
    expect(code).toBe(0);
    expect(events.find((event) => event.event === 'positions_left_out')?.message).toContain(
      'does not state the unit of a track point',
    );
    expect(inputs.map((input) => (input.payload as { type: string }).type)).toEqual(['flight.report']);
  });

  it('does not start with a credential that may not read what is on file, and says what to give it', async () => {
    const { code, events, inputs } = await run(flights('seconds'), recent(), () => false, ['input:write']);
    expect(code).toBe(1);
    expect(events.at(-1)).toMatchObject({ event: 'cannot_start' });
    expect(events.at(-1)!.message).toContain('give it evidence:read');
    expect(inputs).toEqual([]);
  });

  it('stops, naming no secret, when the service refuses the organization key', async () => {
    const project = recent();
    Object.assign(project, { token: 'another-organization-key' });
    const { code, events, inputs, text } = await run(flights('seconds'), project, () => false);
    expect(code).toBe(1);
    expect(events.find((event) => event.event === 'stopping_on_refusal')?.message).toContain(
      'The service refused the access token with 401',
    );
    expect(inputs).toEqual([]);
    expect(text).not.toContain(FLIGHTHUB2_EMULATOR_TOKEN);
  });
});
