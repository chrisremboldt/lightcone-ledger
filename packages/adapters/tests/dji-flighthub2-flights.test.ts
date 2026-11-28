import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type TranslationContext,
  type VendorMessage,
  InMemoryObservationSink,
  translateAndSubmit,
} from '../src/adapter-contract.js';
import { assertAdapterConformance } from '../src/conformance.js';
import {
  type FlightHub2FlightsBinding,
  FLIGHTHUB2_TASK_LIST_PATH,
  djiFlightHub2FlightsAdapter,
  djiFlightHub2FlightsDescriptor,
  flightHub2TrackPath,
  flightTaskEntryState,
  flightTaskListEntries,
} from '../src/dji-flighthub2-flights.js';
import { FLIGHTHUB2_LIST_LIMIT, FlightHub2FlightPoll } from '../src/dji-flighthub2-poll.js';
import { ServiceCredentialRefused } from '../src/source-transports.js';
import {
  type EmulatedFlightTask,
  FLIGHTHUB2_EMULATOR_PROJECT,
  FLIGHTHUB2_EMULATOR_TOKEN,
  FlightHub2Project,
  flightHub2Fetcher,
  flightTaskEntry,
  flightTaskListBody,
  flightTaskTrackBody,
  inventedFlightTask,
} from '../../../apps/emulators/src/flighthub2.js';

// Every test here runs against the emulator, which answers in the documented shapes with invented data. None of it
// has been compared with the real product.

const seconds: TranslationContext<FlightHub2FlightsBinding> = {
  subjects: { scope: 'source' },
  binding: { pointTimeUnit: 'seconds' },
};
const NOW = Date.parse('2026-11-20T15:00:00.000Z');
const ORIGIN = 'https://flights.example.test';
const taskId = (number: number) => `a1b2c3d4-0000-4000-8000-${number.toString(16).padStart(12, '0')}`;
const completed = inventedFlightTask({ uuid: taskId(1), runAt: '2026-11-20T14:00:00.000Z', minutes: 2 });
const inProgress = inventedFlightTask({ uuid: taskId(2), runAt: '2026-11-20T14:57:00.000Z' });
const copy = (task: EmulatedFlightTask): EmulatedFlightTask => structuredClone(task);

/** Runs the poll against the emulator until it has polled `polls` times, and returns what it handed over. */
async function polled(
  project: FlightHub2Project,
  options: {
    polls?: number;
    readTracks?: boolean;
    userToken?: string;
    projectUuid?: string;
    between?: () => void;
    log?: { event: string; message: string }[];
  } = {},
) {
  const messages: VendorMessage[] = [];
  const poll = new FlightHub2FlightPoll(
    {
      origin: ORIGIN,
      userToken: options.userToken ?? FLIGHTHUB2_EMULATOR_TOKEN,
      projectUuid: options.projectUuid ?? FLIGHTHUB2_EMULATOR_PROJECT,
      intervalMs: 5,
      readTracks: options.readTracks ?? true,
      now: () => NOW,
      fetcher: flightHub2Fetcher(project),
      log: (event) => options.log?.push(event),
    },
    async (message) => {
      messages.push(message);
    },
  );
  const running = poll.start();
  let ended = false;
  const settled = running.then(
    () => (ended = true),
    () => (ended = true),
  );
  const wanted = options.polls ?? 1;
  let between = options.between;
  const deadline = Date.now() + 20_000;
  while (!ended && poll.polls < wanted && Date.now() < deadline) {
    if (between && poll.polls >= 1) {
      between();
      between = undefined;
    }
    await Promise.race([settled, new Promise((resolve) => setTimeout(resolve, 2))]);
  }
  await poll.stop();
  return { messages, poll, running };
}

async function submitted(messages: readonly VendorMessage[], sink = new InMemoryObservationSink(), context = seconds) {
  const outcomes = [];
  for (const message of messages)
    outcomes.push(await translateAndSubmit(djiFlightHub2FlightsAdapter, message, context, sink));
  return { sink, outcomes };
}

describe('completed flights adapter on the contract', () => {
  it('passes the conformance kit against its golden files, all written from the documentation', async () => {
    const report = await assertAdapterConformance({
      adapter: djiFlightHub2FlightsAdapter,
      context: seconds,
      goldenDirectory: join(import.meta.dirname, '../src/golden/dji-flighthub2-flights'),
      vendorTerms: ['flighthub 2', 'cloud api'],
    });
    expect(report.checked).toMatchObject({ goldens: 13, observations: 7 });
  });

  it('says in every observation that it was built from documentation and not run against the product', () => {
    expect(djiFlightHub2FlightsDescriptor.fidelity).toBe('synthetic_contract');
    expect(djiFlightHub2FlightsDescriptor.limitations[0]).toContain('has not been run against the real product');
    expect(djiFlightHub2FlightsDescriptor.source.vendor).toBe('DJI');
    expect(djiFlightHub2FlightsDescriptor.limitations.join(' ')).not.toMatch(/\b(dji|flighthub|wayline)\b/i);
  });

  it('cuts the list into its entries, each the bytes the source sent, and reads an empty list', () => {
    const text = `{ "code": 0, "message": "", "data": { "total": 2, "list": [ {"uuid":"one","name":"a ] } [ \\" name","flight_status":"2"} ,\n{"uuid":"two","nested":{"list":[1,2]},"flight_status":"1"} ] } }`;
    const entries = flightTaskListEntries(new TextEncoder().encode(text)).map((entry) =>
      new TextDecoder().decode(entry),
    );
    expect(entries).toEqual([
      `{"uuid":"one","name":"a ] } [ \\" name","flight_status":"2"}`,
      `{"uuid":"two","nested":{"list":[1,2]},"flight_status":"1"}`,
    ]);
    expect(entries.every((entry) => text.includes(entry))).toBe(true);
    // The documentation's own example answers with a list of null.
    expect(flightTaskListEntries(new TextEncoder().encode('{"code":0,"message":"","data":{"list":null}}'))).toEqual([]);
    expect(() => flightTaskListEntries(new TextEncoder().encode('{"code":200500,"message":"x","data":{}}'))).toThrow(
      'code 200500',
    );
    expect(() => flightTaskListEntries(new TextEncoder().encode('[]'))).toThrow('not a JSON object');
    expect(flightTaskEntryState(new TextEncoder().encode(entries[0]!))).toMatchObject({
      taskUuid: 'one',
      completion: 'completed',
    });
    expect(flightTaskEntryState(new TextEncoder().encode('{"uuid":"three"}'))).toMatchObject({
      taskUuid: 'three',
      completion: 'unstated',
    });
    // What an entry states changes with a field a report is made from, and with no other.
    const stated = (entry: Record<string, unknown>) =>
      flightTaskEntryState(new TextEncoder().encode(JSON.stringify(entry))).statement;
    const reported = { uuid: 'one', flight_status: '2', run_at: 'a', completed_at: 'b', media_upload_status: 'x' };
    expect(stated({ ...reported, media_upload_status: 'y' })).toBe(stated(reported));
    expect(stated({ ...reported, completed_at: 'c' })).not.toBe(stated(reported));
  });
});

describe('completed flights read from the emulator', () => {
  it('reports a completed flight once, with its positions and the bytes the service sent', async () => {
    const project = new FlightHub2Project([copy(completed)]);
    const { messages } = await polled(project, { polls: 2 });
    expect(messages.map((message) => message.transport.path)).toEqual([
      FLIGHTHUB2_TASK_LIST_PATH,
      flightHub2TrackPath(completed.uuid),
    ]);
    // Each message is cut from, or is, the response as sent.
    const text = (message: VendorMessage) => new TextDecoder().decode(message.bytes);
    expect(flightTaskListBody(project.tasks)).toContain(text(messages[0]!));
    expect(text(messages[1]!)).toBe(flightTaskTrackBody(project.tasks[0]!, 'seconds'));

    const { sink, outcomes } = await submitted(messages);
    const report = outcomes[0]!.submitted.map((entry) => entry.observation);
    expect(report).toHaveLength(1);
    expect(report[0]).toMatchObject({
      type: 'flight.report',
      subject: { kind: 'flight', id: completed.uuid, scope: 'source' },
      occurredAt: '2026-11-20T14:02:00.000Z',
      values: { activity: 'landed', takeoffAt: '2026-11-20T14:00:00.000Z', landingAt: '2026-11-20T14:02:00.000Z' },
      fidelity: 'synthetic_contract',
      originalArtifactId: outcomes[0]!.artifactId,
    });
    expect(report[0]!.limitations.at(-1)).toBe('The source states the status of this flight task as success.');
    const positions = outcomes[1]!.submitted.map((entry) => entry.observation);
    expect(positions).toHaveLength(completed.points.length);
    expect(positions[0]).toMatchObject({
      type: 'position.fix',
      subject: { kind: 'aircraft', id: 'RIDGE-AC-1', scope: 'source' },
      secondarySubject: { kind: 'flight', id: completed.uuid, scope: 'source' },
      occurredAt: completed.points[0]!.occurredAt,
      position: { latitudeDegrees: completed.points[0]!.latitude, longitudeDegrees: completed.points[0]!.longitude },
      originalLocator: { kind: 'json_pointer', value: '/data/track/points/0' },
      values: { fix: 'unknown' },
    });
    // No height is carried: the documentation states neither its unit nor its datum.
    expect(positions.every((position) => !('altitude' in (position.position ?? {})))).toBe(true);
    expect(positions.at(-1)!.occurredAt).toBe(completed.points.at(-1)!.occurredAt);
    expect(sink.originals.get(outcomes[1]!.artifactId!)?.bytes).toEqual(messages[1]!.bytes);

    // A process started again reads the same flight: the same bytes give the same keys and nothing new is recorded.
    const again = await polled(project);
    const before = sink.observations.length;
    const replay = await submitted(again.messages, sink);
    expect(sink.observations).toHaveLength(before);
    expect(replay.outcomes.flatMap((outcome) => outcome.submitted.map((entry) => entry.receiptId))).toEqual(
      outcomes.flatMap((outcome) => outcome.submitted.map((entry) => entry.receiptId)),
    );
  });

  it('keeps one current report of a task: a copy changed elsewhere records nothing, a changed time replaces it', async () => {
    const sink = new InMemoryObservationSink({ oneCurrentPerSubject: ['flight.report'] });
    const entryOf = (task: EmulatedFlightTask): VendorMessage => ({
      bytes: new TextEncoder().encode(JSON.stringify(flightTaskEntry(task))),
      contentType: 'application/json',
      transport: { method: 'GET', path: FLIGHTHUB2_TASK_LIST_PATH },
      capturedAt: new Date(NOW).toISOString(),
    });
    const first = await submitted([entryOf(completed)], sink);
    // As a restarted process would read it: the media upload status moved on, the statement did not.
    const elsewhere = await submitted([entryOf({ ...copy(completed), mediaUploadStatus: 'uploading' })], sink);
    expect(sink.observations).toHaveLength(1);
    expect(elsewhere.outcomes[0]!.submitted[0]!.receiptId).toBe(first.outcomes[0]!.submitted[0]!.receiptId);
    // The service corrects the completion time.
    await submitted([entryOf({ ...copy(completed), completedAt: '2026-11-20T14:03:00.000Z' })], sink);
    expect(sink.observations).toHaveLength(2);
    expect(sink.current).toHaveLength(1);
    expect(sink.current[0]).toMatchObject({
      replaces: first.outcomes[0]!.submitted[0]!.receiptId,
      observation: { values: { landingAt: '2026-11-20T14:03:00.000Z' } },
    });
  });

  it('reports nothing for a flight in progress, and reports it once the service marks it completed', async () => {
    const project = new FlightHub2Project([copy(inProgress)]);
    const log: { event: string; message: string }[] = [];
    const first = await polled(project, { polls: 2, log });
    expect(first.messages).toEqual([]);
    expect(project.requests.some((request) => request.includes('/track'))).toBe(false);
    expect(log.find((event) => event.event === 'flight_tasks_listed')?.message).toContain('1 not marked completed');

    const { messages } = await polled(project, {
      polls: 3,
      between: () => project.complete(inProgress.uuid, '2026-11-20T14:59:30.000Z'),
    });
    expect(messages.map((message) => message.transport.path)).toEqual([
      FLIGHTHUB2_TASK_LIST_PATH,
      flightHub2TrackPath(inProgress.uuid),
    ]);
    const { outcomes } = await submitted(messages);
    expect(outcomes[0]!.submitted[0]!.observation).toMatchObject({
      type: 'flight.report',
      values: { activity: 'landed', takeoffAt: '2026-11-20T14:57:00.000Z', landingAt: '2026-11-20T14:59:30.000Z' },
    });
    // An entry of a task in progress, handed to the adapter anyway, is refused rather than reported as a flight.
    const entry = new TextEncoder().encode(JSON.stringify(flightTaskEntry(copy(inProgress))));
    const refused = djiFlightHub2FlightsAdapter.translate(
      { ...messages[0]!, bytes: entry },
      seconds as TranslationContext<FlightHub2FlightsBinding>,
    );
    expect(refused.drafts).toEqual([]);
    expect(refused.rejections[0]!.reason).toContain('not marked completed');
  });

  it('stops when the service refuses the organization key or the project, and hands nothing over', async () => {
    const project = new FlightHub2Project([copy(completed)]);
    const wrongKey = await polled(project, { userToken: 'not-the-key' });
    await expect(wrongKey.running).rejects.toBeInstanceOf(ServiceCredentialRefused);
    await expect(wrongKey.running).rejects.toMatchObject({ status: 401 });
    expect(wrongKey.messages).toEqual([]);
    const wrongProject = await polled(project, { projectUuid: '00000000-0000-4000-8000-000000000000' });
    await expect(wrongProject.running).rejects.toMatchObject({ status: 403 });
    expect(wrongProject.messages).toEqual([]);
    expect(String(await wrongKey.running.catch((error: Error) => error.message))).not.toContain('not-the-key');
  });

  it('asks again for each half of a time range whose answer is full, until every flight is read once', async () => {
    // The list takes no page number and answers with at most 100 entries: 250 flights need narrower time ranges.
    const tasks = Array.from({ length: 250 }, (_, index) =>
      inventedFlightTask({
        uuid: taskId(1000 + index),
        runAt: new Date(NOW - 40 * 3_600_000 + index * 9 * 60_000).toISOString(),
        minutes: 1,
        pointEverySeconds: 30,
      }),
    );
    const project = new FlightHub2Project(tasks);
    const log: { event: string; message: string }[] = [];
    const { messages } = await polled(project, { readTracks: false, log });
    const reported = messages.map((message) => flightTaskEntryState(message.bytes).taskUuid);
    expect(new Set(reported).size).toBe(250);
    expect(reported).toHaveLength(250);
    const lists = project.requests.filter((request) => request.startsWith(FLIGHTHUB2_TASK_LIST_PATH));
    expect(lists.length).toBeGreaterThan(3);
    expect(lists.every((request) => /\?begin_at=\d+&end_at=\d+$/.test(request))).toBe(true);
    expect(log.some((event) => event.event === 'list_full')).toBe(false);
    expect(FLIGHTHUB2_LIST_LIMIT).toBe(100);
  });

  it('says so when a full answer cannot be narrowed further, instead of reporting it as complete', async () => {
    const tasks = Array.from({ length: 120 }, (_, index) =>
      inventedFlightTask({ uuid: taskId(2000 + index), runAt: '2026-11-20T10:00:00.000Z', minutes: 1 }),
    );
    const log: { event: string; message: string }[] = [];
    const { messages } = await polled(new FlightHub2Project(tasks), { readTracks: false, log });
    expect(messages).toHaveLength(100);
    expect(log.find((event) => event.event === 'list_full')?.message).toContain('were not read');
  });

  it('leaves positions out, and asks for no track, until a person has stated the unit of a point’s timestamp', async () => {
    const project = new FlightHub2Project([copy(completed)]);
    const { messages } = await polled(project, { readTracks: false });
    expect(messages.map((message) => message.transport.path)).toEqual([FLIGHTHUB2_TASK_LIST_PATH]);
    expect(project.requests.some((request) => request.includes('/track'))).toBe(false);
    // A track handed to the adapter anyway is not read.
    const track: VendorMessage = {
      bytes: new TextEncoder().encode(flightTaskTrackBody(completed, 'seconds')),
      contentType: 'application/json',
      transport: { method: 'GET', path: flightHub2TrackPath(completed.uuid) },
      capturedAt: new Date(NOW).toISOString(),
    };
    const unset = await submitted([track], new InMemoryObservationSink(), {
      subjects: { scope: 'source' },
      binding: {},
    });
    expect(unset.sink.observations).toEqual([]);
    expect(unset.outcomes[0]!.rejections[0]!.reason).toContain('does not state the unit');
  });

  it('reads timestamps in milliseconds when told so, and refuses a track read in the wrong unit', async () => {
    const project = new FlightHub2Project([copy(completed)]);
    project.pointTimestampUnit = 'milliseconds';
    const { messages } = await polled(project);
    const milliseconds: TranslationContext<FlightHub2FlightsBinding> = {
      subjects: { scope: 'source' },
      binding: { pointTimeUnit: 'milliseconds' },
    };
    const right = await submitted([messages[1]!], new InMemoryObservationSink(), milliseconds);
    expect(right.outcomes[0]!.submitted.map((entry) => entry.observation.occurredAt)).toEqual(
      completed.points.map((point) => point.occurredAt),
    );
    const wrong = await submitted([messages[1]!], new InMemoryObservationSink(), seconds);
    expect(wrong.sink.observations).toEqual([]);
    expect(wrong.outcomes[0]!.rejections).toHaveLength(completed.points.length);
    expect(wrong.outcomes[0]!.rejections[0]!.reason).toContain('the configured unit may be wrong');
  });

  it('hands over an entry that states no completion once, says why it is not read, and reports the task once it is completed', async () => {
    // Not something the documentation describes: an entry without flight_status. It must fail in the open.
    const entry = (flightStatus?: string) => {
      const { flight_status: _status, ...rest } = flightTaskEntry(copy(completed));
      return { ...rest, ...(flightStatus ? { flight_status: flightStatus } : {}) };
    };
    let answers = 0;
    const messages: VendorMessage[] = [];
    const poll = new FlightHub2FlightPoll(
      {
        origin: ORIGIN,
        userToken: FLIGHTHUB2_EMULATOR_TOKEN,
        projectUuid: FLIGHTHUB2_EMULATOR_PROJECT,
        intervalMs: 2,
        readTracks: false,
        now: () => NOW,
        fetcher: (async () =>
          new Response(
            JSON.stringify({ code: 0, message: '', data: { list: [entry(answers++ < 2 ? undefined : '2')] } }),
          )) as typeof fetch,
      },
      async (message) => {
        messages.push(message);
      },
    );
    void poll.start();
    const deadline = Date.now() + 10_000;
    while (poll.polls < 4 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 2));
    await poll.stop();
    expect(messages).toHaveLength(2);
    const { outcomes, sink } = await submitted(messages);
    expect(outcomes[0]!.rejections[0]!.reason).toContain('not marked completed');
    expect(sink.observations.map((entry) => entry.observation.type)).toEqual(['flight.report']);
  });

  it('asks again for a track the service does not have yet', async () => {
    const task = { ...copy(completed), trackAvailable: false };
    const project = new FlightHub2Project([task]);
    const log: { event: string; message: string }[] = [];
    const { messages } = await polled(project, {
      polls: 3,
      log,
      between: () => {
        task.trackAvailable = true;
      },
    });
    expect(messages.map((message) => message.transport.path)).toEqual([
      FLIGHTHUB2_TASK_LIST_PATH,
      flightHub2TrackPath(completed.uuid),
    ]);
    expect(log.filter((event) => event.event === 'track_not_found')).toHaveLength(1);
  });
});
