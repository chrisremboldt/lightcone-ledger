import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../api/src/index.js';
import {
  FLIGHTHUB2_EMULATOR_PROJECT,
  FLIGHTHUB2_EMULATOR_TOKEN,
  FlightHub2Project,
  inventedFlightTask,
} from '../../emulators/src/flighthub2.js';
import { createEmulator, emulatorConfig } from '../../emulators/src/server.js';
import type { AcceptedObservation, ObservationListResponse } from '../../../packages/contracts/src/index.js';
import { sha256 } from '../../../packages/integrity/src/index.js';
import { createPool, MemoryObjectStore, type AuthContext } from '../../../packages/persistence/src/index.js';
import { settleOwnedWork } from '../../../tests/integration/worker-queue.js';
import { runAdapterHost } from '../src/host.js';

// The completed flights adapter, as an operator starts it, between the emulated flight task interface and the real
// API on the test database. What Ledger holds afterwards is read back through the API. The emulator is written from
// the same documentation as the adapter: this shows the adapter against Ledger, not against the real product, which
// nothing here has been run against.

/** Keeps every object the API stores, so a test can search the retained originals. */
class SearchableObjectStore extends MemoryObjectStore {
  readonly stored: Uint8Array[] = [];
  override async putIfAbsent(key: string, bytes: Uint8Array, contentType: string) {
    this.stored.push(bytes.slice());
    return super.putIfAbsent(key, bytes, contentType);
  }
}

interface Sent {
  readonly to: 'service' | 'ledger';
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}
interface Line {
  readonly event: string;
  readonly message: string;
  readonly received?: number;
  readonly submittedMessages?: number;
  readonly queued?: number;
  readonly refused?: number;
  readonly rejected?: number;
}

describe.runIf(process.env.LEDGER_ENV !== 'staging')('The completed flights adapter against the real API', () => {
  const prefix = `flighthub2-${randomUUID()}`;
  const tenantId = `${prefix}:org`;
  const sourceId = `${prefix}-flights`;
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const store = new SearchableObjectStore();
  const emulator = createEmulator({ ...emulatorConfig({}), port: 0 });
  const who = {} as Record<'reader' | 'source' | 'writer', AuthContext>;
  const sent: Sent[] = [];
  const base = Math.floor(Date.now() / 1000) * 1000;
  const ago = (minutes: number) => new Date(base - minutes * 60_000).toISOString();
  const task = (number: number) => `a1b2c3d4-0000-4000-8000-00000000000${number}`;
  // Two completed flights of two aircraft and one in progress, all invented.
  const flown = inventedFlightTask({ uuid: task(1), runAt: ago(120), minutes: 2, pointEverySeconds: 20 });
  const second = inventedFlightTask({
    uuid: task(2),
    name: 'Substation roof',
    runAt: ago(60),
    minutes: 1,
    pointEverySeconds: 20,
    droneSn: 'RIDGE-AC-2',
  });
  const inProgress = inventedFlightTask({ uuid: task(3), runAt: ago(5), pointEverySeconds: 20 });
  const project = new FlightHub2Project([flown, second, inProgress]);
  const taskIds = [task(1), task(2), task(3)];
  const aircraftIds = ['RIDGE-AC-1', 'RIDGE-AC-2'];
  let emulatorBase = '';
  let app: Awaited<ReturnType<typeof createApp>>;
  let address = '';

  /** Everything the process sends, to the service and to Ledger, as the test's request log. */
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const body =
      init.body instanceof Uint8Array
        ? new TextDecoder().decode(init.body)
        : typeof init.body === 'string'
          ? init.body
          : '';
    sent.push({
      to: url.startsWith(emulatorBase) ? 'service' : 'ledger',
      method: init.method ?? 'GET',
      url,
      headers: Object.fromEntries(new Headers(init.headers)),
      body,
    });
    return fetch(input, init);
  }) as typeof fetch;
  const listReads = () => sent.filter((request) => request.to === 'service' && request.url.includes('/list?'));
  const trackReads = () => sent.filter((request) => request.to === 'service' && request.url.endsWith('/track'));

  function call(principal: AuthContext, method: 'GET' | 'POST', url: string, payload?: unknown) {
    return app.inject({
      method,
      url,
      headers: { authorization: `Bearer ledger-dev-${principal.id}`, 'idempotency-key': randomUUID() },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  }

  /** What Ledger holds about one of the service's ids, read through the API as a person with evidence:read. */
  async function onFile(
    kind: 'flight' | 'aircraft',
    id: string,
    type: 'flight.report' | 'position.fix',
    include: 'current' | 'all' = 'current',
  ): Promise<AcceptedObservation[]> {
    const query = new URLSearchParams({
      subjectKind: kind,
      subjectId: id,
      subjectScope: 'source',
      sourceId,
      type,
      from: '1970-01-01T00:00:00.000Z',
      to: '9999-12-31T23:59:59.000Z',
      limit: '500',
      include,
    });
    const response = await call(who.reader, 'GET', `/v1/observations?${query}`);
    expect(response.statusCode, response.body).toBe(200);
    const list = response.json<ObservationListResponse>();
    expect(list.page.hasMore).toBe(false);
    return list.observations;
  }

  /** Every observation the source has on file, replaced ones included, by id. */
  async function everything(): Promise<Map<string, AcceptedObservation>> {
    const all = new Map<string, AcceptedObservation>();
    for (const id of taskIds)
      for (const item of await onFile('flight', id, 'flight.report', 'all')) all.set(item.id, item);
    for (const id of aircraftIds)
      for (const item of await onFile('aircraft', id, 'position.fix', 'all')) all.set(item.id, item);
    return all;
  }
  const links = (all: Map<string, AcceptedObservation>) =>
    [...all].map(([id, item]) => [id, item.replaces ?? null, item.replacedBy ?? null]).sort();

  /** One adapter process, started as an operator starts it; `until` waits for a state of its log, `stop` ends it. */
  function start(principal: AuthContext, pointTimes: 'seconds' | 'not-compared') {
    const stop = new AbortController();
    const lines: Line[] = [];
    const exit = runAdapterHost(
      [
        'dji-flighthub2-flights',
        '--service-url',
        emulatorBase,
        '--project',
        FLIGHTHUB2_EMULATOR_PROJECT,
        '--point-times',
        pointTimes,
        '--poll-seconds',
        '5',
      ],
      {
        LEDGER_API_URL: address,
        LEDGER_API_CREDENTIAL: `ledger-dev-${principal.id}`,
        LEDGER_CREDENTIAL_LABEL: 'Fictional completed flights adapter on the hangar host',
        ADAPTER_SERVICE_TOKEN: FLIGHTHUB2_EMULATOR_TOKEN,
      },
      { out: (line) => lines.push(JSON.parse(line) as Line), stop: stop.signal, fetcher, summaryMs: 100 },
    );
    return {
      lines,
      exit,
      /** Resolves once a count the process printed after this call satisfies `done`. */
      async until(done: (summary: Line) => boolean, what: string) {
        const from = lines.length;
        const deadline = Date.now() + 40_000;
        while (!lines.slice(from).some((line) => line.event === 'summary' && done(line))) {
          if (Date.now() > deadline) throw new Error(`The process did not reach: ${what}. ${JSON.stringify(lines)}`);
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      },
      /** Resolves once the process has listed the flight tasks this many more times and submitted what it held. */
      async polledAgain(times: number, messages: number) {
        const polls = listReads().length;
        const deadline = Date.now() + 40_000;
        while (listReads().length < polls + times) {
          if (Date.now() > deadline) throw new Error('The process did not poll again');
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        await this.until(settledAt(messages), `${messages} messages after another poll`);
      },
      async stop() {
        stop.abort();
        return exit;
      },
    };
  }
  /** Handed over and submitted this many messages in all, with nothing waiting. */
  const settledAt = (messages: number) => (line: Line) =>
    line.received === messages && line.submittedMessages === messages && line.queued === 0;
  const clean = { event: 'stopped', unsubmitted: 0, refused: 0, rejected: 0 };

  beforeAll(async () => {
    await new Promise<void>((resolve) => emulator.server.listen(0, '127.0.0.1', resolve));
    emulatorBase = `http://127.0.0.1:${(emulator.server.address() as AddressInfo).port}`;
    emulator.state.flightHub2 = project;
    app = await createApp({ pool, env: 'test', objectStore: store });
    address = await app.listen({ host: '127.0.0.1', port: 0 });
    await admin.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenantId, 'Fictional dock operator']);
    const people = {
      reader: { kind: 'human', capabilities: ['evidence:read', 'flight:read', 'authority:write'] },
      source: { kind: 'source', capabilities: ['input:write', 'evidence:read'] },
      // A source as the other adapters' credentials are issued: it may write and not read.
      writer: { kind: 'source', capabilities: ['input:write'] },
    } as const;
    for (const [role, person] of Object.entries(people) as [keyof typeof people, (typeof people)['reader']][]) {
      who[role] = {
        id: `${tenantId}:${role}`,
        tenantId,
        name: `Fictional ${role}`,
        kind: person.kind,
        revision: 1,
        capabilities: [...person.capabilities],
      };
      await admin.query('INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,$3,$4,$5)', [
        who[role].id,
        tenantId,
        who[role].name,
        person.kind,
        person.capabilities,
      ]);
      await admin.query('INSERT INTO api_credentials(token_hash,principal_id) VALUES($1,$2)', [
        sha256(`ledger-dev-${who[role].id}`),
        who[role].id,
      ]);
    }
    for (const principal of [who.source, who.writer]) {
      const current = await call(who.reader, 'GET', `/v1/authority/principals/${encodeURIComponent(principal.id)}`);
      const granted = await call(who.reader, 'POST', '/v1/commands', {
        kind: 'authority.update',
        principalId: principal.id,
        expectedRevision: current.json().principal.revision,
        capabilities: current.json().principal.capabilities,
        observationGrants: ['flight.report', 'position.fix'].map((observationType) => ({ sourceId, observationType })),
      });
      expect(granted.statusCode, granted.body).toBe(201);
    }
  });

  afterAll(async () => {
    await settleOwnedWork([prefix]);
    if (app) await app.close();
    emulator.server.closeAllConnections();
    await new Promise<void>((resolve) => emulator.server.close(() => resolve()));
    await pool.end();
    await admin.end();
  });

  it('records each completed flight once, replaces the report of a task the service changes, and records nothing twice', async () => {
    // (a) Started before anyone has compared a track: one report for each completed task, no position, no track read.
    const unstated = start(who.source, 'not-compared');
    await unstated.until(settledAt(2), 'the two completed tasks submitted');
    const reports = new Map<string, AcceptedObservation[]>();
    for (const id of taskIds) reports.set(id, await onFile('flight', id, 'flight.report'));
    expect(reports.get(task(1))).toHaveLength(1);
    expect(reports.get(task(2))).toHaveLength(1);
    expect(reports.get(task(3))).toEqual([]);
    expect(reports.get(task(1))![0]!.observation).toMatchObject({
      subject: { kind: 'flight', id: task(1), scope: 'source' },
      occurredAt: ago(118),
      values: { activity: 'landed', takeoffAt: ago(120), landingAt: ago(118) },
      fidelity: 'synthetic_contract',
    });
    for (const id of aircraftIds) expect(await onFile('aircraft', id, 'position.fix')).toEqual([]);
    expect(trackReads()).toEqual([]);
    expect(await unstated.stop()).toBe(0);
    expect(unstated.lines.at(-1)).toMatchObject(clean);
    expect((await everything()).size).toBe(2);

    // (a) Started with the unit stated: the reports on file stand as they are, and each track's points are recorded.
    const first = start(who.source, 'seconds');
    await first.until(settledAt(4), 'two entries and two tracks submitted');
    const positions = await onFile('aircraft', 'RIDGE-AC-1', 'position.fix');
    expect(positions).toHaveLength(flown.points.length);
    expect(positions.map((item) => item.observation.occurredAt).sort()).toEqual(
      flown.points.map((point) => point.occurredAt),
    );
    expect(positions[0]!.observation).toMatchObject({
      secondarySubject: { kind: 'flight', id: task(1), scope: 'source' },
      values: { fix: 'unknown' },
    });
    expect(positions.every((item) => !('altitude' in (item.observation.position ?? {})))).toBe(true);
    expect(await onFile('aircraft', 'RIDGE-AC-2', 'position.fix')).toHaveLength(second.points.length);
    for (const id of [task(1), task(2)])
      expect((await onFile('flight', id, 'flight.report', 'all')).map((item) => item.id)).toEqual([
        reports.get(id)![0]!.id,
      ]);
    const afterFirst = await everything();
    expect(afterFirst.size).toBe(2 + flown.points.length + second.points.length);

    // (b) The same process polls again with nothing changed: nothing is handed over, nothing is recorded.
    await first.polledAgain(2, 4);
    expect(links(await everything())).toEqual(links(afterFirst));

    // (c) The service changes a field of a reported task that no report is made from: nothing is recorded.
    second.mediaUploadStatus = 'uploading';
    await first.polledAgain(2, 4);
    expect(links(await everything())).toEqual(links(afterFirst));

    // (c) The service corrects the completion time of a reported task: its report is replaced, and both are kept.
    const earlier = reports.get(task(1))![0]!;
    flown.completedAt = ago(117);
    flown.status = 'terminated';
    await first.until(settledAt(5), 'the changed entry submitted');
    const current = await onFile('flight', task(1), 'flight.report');
    expect(current).toHaveLength(1);
    expect(current[0]!.observation.values).toEqual({ activity: 'landed', takeoffAt: ago(120), landingAt: ago(117) });
    expect(current[0]!.replaces).toBe(earlier.id);
    const history = await onFile('flight', task(1), 'flight.report', 'all');
    expect(history.map((item) => item.id).sort()).toEqual([earlier.id, current[0]!.id].sort());
    expect(history.find((item) => item.id === earlier.id)).toMatchObject({ replacedBy: current[0]!.id });
    expect((await onFile('flight', task(2), 'flight.report', 'all')).map((item) => item.id)).toEqual([
      reports.get(task(2))![0]!.id,
    ]);

    // The flight in progress completes: it is reported then, with its track.
    project.complete(task(3), ago(1));
    await first.until(settledAt(7), 'the newly completed task and its track submitted');
    expect(await onFile('flight', task(3), 'flight.report')).toHaveLength(1);
    expect(await first.stop()).toBe(0);
    expect(first.lines.at(-1)).toMatchObject(clean);
    const afterChange = await everything();
    expect(afterChange.size).toBe(afterFirst.size + 2 + inProgress.points.length);

    // (d) A new process reads every task and track again, one entry changed since in a field no report is made
    // from: Ledger gains no observation and nothing is replaced.
    flown.mediaUploadStatus = 'to_upload';
    const again = start(who.source, 'seconds');
    await again.until(settledAt(6), 'the restarted process read everything again');
    await again.polledAgain(1, 6);
    expect(await again.stop()).toBe(0);
    expect(again.lines.at(-1)).toMatchObject(clean);
    expect(links(await everything())).toEqual(links(afterChange));
    for (const id of taskIds) expect(await onFile('flight', id, 'flight.report'), id).toHaveLength(1);
  }, 200_000);

  it('does not start with a credential that may not read what is on file, and says what to give it', async () => {
    const asked = sent.filter((request) => request.to === 'service').length;
    const refused = start(who.writer, 'seconds');
    expect(await refused.exit).toBe(1);
    expect(refused.lines[0]!.event).toBe('starting');
    expect(refused.lines[0]!.message).toContain('has not been run against a real FlightHub 2 project');
    expect(refused.lines.at(-1)).toMatchObject({
      event: 'cannot_start',
      message:
        'Fictional writer may not read observations: give it evidence:read on the People screen. Before this adapter reports a flight.report it reads the one on file about the same subject, so a changed record replaces the earlier one instead of standing beside it.',
    });
    // It asked the service nothing.
    expect(sent.filter((request) => request.to === 'service')).toHaveLength(asked);
  });

  it('sends the organization key to the service only: nothing Ledger was sent or keeps holds it', async () => {
    const key = FLIGHTHUB2_EMULATOR_TOKEN;
    // To the service: the key is the X-User-Token header of every request, and nowhere else in one.
    const toService = sent.filter((request) => request.to === 'service');
    expect(toService.length).toBeGreaterThan(6);
    for (const request of toService) {
      expect(request.headers['x-user-token']).toBe(key);
      expect(request.headers['x-project-uuid']).toBe(FLIGHTHUB2_EMULATOR_PROJECT);
      expect(`${request.url} ${request.body}`).not.toContain(key);
    }
    // To Ledger: no request's address, headers or body holds it.
    const toLedger = sent.filter((request) => request.to === 'ledger');
    expect(toLedger.some((request) => request.url.endsWith('/v1/inputs'))).toBe(true);
    expect(toLedger.some((request) => request.url.includes('/content'))).toBe(true);
    for (const request of toLedger) expect(JSON.stringify(request)).not.toContain(key);
    // In Ledger: no retained original, and no row of the journal, the receipts or the observations, holds it.
    expect(store.stored.length).toBeGreaterThan(4);
    for (const bytes of store.stored) expect(Buffer.from(bytes).includes(key)).toBe(false);
    const held = await admin.query<{ count: string }>(
      `SELECT (SELECT COUNT(*) FROM journal_events WHERE tenant_id=$1 AND payload::text LIKE $2)
        +(SELECT COUNT(*) FROM receipts WHERE tenant_id=$1 AND payload::text LIKE $2)
        +(SELECT COUNT(*) FROM observations WHERE tenant_id=$1 AND observation::text LIKE $2) AS count`,
      [tenantId, `%${key}%`],
    );
    expect(Number(held.rows[0]!.count)).toBe(0);
    const rows = await admin.query<{ count: string }>('SELECT COUNT(*) AS count FROM observations WHERE tenant_id=$1', [
      tenantId,
    ]);
    expect(Number(rows.rows[0]!.count)).toBeGreaterThan(20);
  });
});
