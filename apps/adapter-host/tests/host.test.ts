import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseHostOptions, runAdapterHost, UsageError } from '../src/host.js';

const secret = 'ledger-service-fictional-secret-value';
const env = {
  LEDGER_API_CREDENTIAL: secret,
  LEDGER_CREDENTIAL_LABEL: 'Adapter on the fictional hangar host',
  LEDGER_API_URL: 'http://127.0.0.1:4000',
  ADAPTER_SERVICE_TOKEN: 'fictional-service-token',
  ADAPTER_BROKER_PASSWORD: 'fictional-broker-password',
};
const airspace = ['airspace-link-laanc-authorization', '--service-url', 'http://127.0.0.1:4002'];
const operation = ['--operation', 'op-1', '--flight', 'flight-fictional-1'];

describe('the adapter process settings', () => {
  it('reads settings from flags and the environment, and secrets from the environment only', () => {
    const options = parseHostOptions([...airspace, ...operation, '--poll-seconds', '30'], env);
    expect(options).toMatchObject({
      adapterId: 'airspace-link-laanc-authorization',
      apiUrl: 'http://127.0.0.1:4000',
      credentialLabel: 'Adapter on the fictional hangar host',
      binding: { operation: 'op-1', flight: 'flight-fictional-1' },
      service: { url: 'http://127.0.0.1:4002/v1/operations/op-1/laanc', pollMs: 30_000 },
    });
    expect(() => parseHostOptions([...airspace, ...operation, '--api-credential', secret], env)).toThrow(
      'give it in the environment',
    );
    expect(() => parseHostOptions([...airspace, ...operation], { ...env, LEDGER_API_CREDENTIAL: '' })).toThrow(
      'LEDGER_API_CREDENTIAL is required',
    );
  });

  it('names what is missing or wrong', () => {
    expect(() => parseHostOptions(['no-such-adapter'], env)).toThrow(UsageError);
    expect(() => parseHostOptions([...airspace, '--operation', 'op-1'], env)).toThrow('--flight');
    expect(() =>
      parseHostOptions(
        ['dji-cloud-api-osd-position', '--broker-url', 'mqtt://127.0.0.1:1883', '--broker-username', 'source-1'],
        { ...env, ADAPTER_DEVICE: 'AIRCRAFT/#', ADAPTER_GATEWAY: 'DOCK-1' },
      ),
    ).toThrow('wildcards');
    expect(() =>
      parseHostOptions(['dji-cloud-api-dock-wind', '--dock', 'DOCK-1', '--site', 'yard', '--dock-model', 'dock1'], env),
    ).toThrow('dock2, dock3 or dock4');
    expect(() =>
      parseHostOptions([...airspace, ...operation], { ...env, LEDGER_API_URL: 'http://ledger.example.invalid' }),
    ).toThrow('--private-network');
    expect(
      parseHostOptions([...airspace, ...operation, '--private-network'], {
        ...env,
        LEDGER_API_URL: 'http://ledger:4000',
      }).apiUrl,
    ).toBe('http://ledger:4000');
  });
});

/** The public API and the airspace service, just enough of each. */
function fakes(options: { refuseCredential?: boolean } = {}) {
  const inputs: { key: string | null; body: Record<string, unknown> }[] = [];
  let counter = 0;
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const uploads = new Map<string, { sha256?: string; byteLength: number; contentType: string }>();
  const replies = new Map<string, string>();
  const fetcher = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const target = new URL(String(url));
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    if (target.port === '4002')
      return json(200, {
        operation: {
          authorizations: [
            {
              id: 'SIMFICTION1',
              status: 'STATUS_APPROVED',
              lastUpdatedAt: '2026-10-01T16:30:00.000Z',
              startTime: '2026-10-01T16:50:00.000Z',
              endTime: '2026-10-01T18:10:00.000Z',
              altitude: 400,
            },
          ],
        },
      });
    if (options.refuseCredential || headers.get('authorization') !== `Bearer ${secret}`)
      return json(401, { error: { code: 'unauthenticated', message: 'Credential is invalid' } });
    const key = headers.get('idempotency-key');
    if (key && replies.has(key)) return json(201, JSON.parse(replies.get(key)!));
    let body: unknown;
    if (target.pathname === '/v1/me')
      return json(200, {
        principal: {
          id: 'principal-fictional-airspace',
          name: 'Fictional airspace source',
          capabilities: ['input:write'],
          observationGrants: [{ sourceId: 'fictional-airspace', observationType: 'airspace.authorization' }],
        },
        organization: { name: 'Fictional Aerial Survey' },
      });
    if (method === 'POST' && target.pathname === '/v1/uploads') {
      const created = JSON.parse(String(init.body));
      const id = `upload-${++counter}`;
      uploads.set(id, created);
      body = { upload: { id, ...created, status: 'pending' } };
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
      inputs.push({ key, body: JSON.parse(String(init.body)) });
      body = { receipt: { id: `receipt-${++counter}`, kind: 'observation' } };
    } else return json(404, { error: { code: 'not_found', message: target.pathname } });
    if (key) replies.set(key, JSON.stringify(body));
    return json(201, body);
  }) as typeof fetch;
  return { fetcher, inputs };
}

describe('the adapter process', () => {
  it('prints its fidelity, polls the service and submits through the API until stopped', async () => {
    const { fetcher, inputs } = fakes();
    const lines: string[] = [];
    const stop = new AbortController();
    const running = runAdapterHost([...airspace, ...operation, '--poll-seconds', '5'], env, {
      out: (line) => lines.push(line),
      stop: stop.signal,
      fetcher,
    });
    const deadline = Date.now() + 10_000;
    while (!inputs.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    stop.abort();
    expect(await running).toBe(0);
    const events = lines.map((line) => JSON.parse(line) as { event: string; message: string });
    expect(events[0]).toMatchObject({ event: 'starting', fidelity: 'synthetic_contract' });
    expect(events[0]!.message).toContain('run against an emulator only');
    expect(events.map((event) => event.event)).toEqual(
      expect.arrayContaining(['signed_in', 'polling', 'first_submitted', 'stopped']),
    );
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.body).toMatchObject({
      sourceId: 'fictional-airspace',
      kind: 'observation',
      payload: {
        type: 'airspace.authorization',
        subject: { kind: 'flight', id: 'flight-fictional-1', scope: 'ledger' },
      },
    });
    expect(lines.join('\n')).not.toMatch(/fictional-secret-value|fictional-service-token/);
  });

  it('exits non-zero naming the credential’s label, never its secret, when Ledger refuses it', async () => {
    const { fetcher } = fakes({ refuseCredential: true });
    const lines: string[] = [];
    const code = await runAdapterHost([...airspace, ...operation], env, {
      out: (line) => lines.push(line),
      stop: new AbortController().signal,
      fetcher,
    });
    expect(code).toBe(1);
    const last = JSON.parse(lines.at(-1)!) as { event: string; message: string };
    expect(last.event).toBe('cannot_start');
    expect(last.message).toContain('"Adapter on the fictional hangar host"');
    expect(lines.join('\n')).not.toContain(secret);
  });

  it('prints the usage and exits 2 on a usage error', async () => {
    const errors: string[] = [];
    expect(await runAdapterHost([], env, { err: (line) => errors.push(line), out: () => {} })).toBe(2);
    expect(errors.join('\n')).toContain('Usage: pnpm adapter:run <adapter>');
  });
});
