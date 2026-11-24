import { mode, realFetch, useFetch } from '../transport.js';
import { play, snapshot, type Scene } from './player.js';
import { scenes } from './scenes.js';
import { recorder, replayer, type Tape } from './tape.js';

/** Recorded scenes, loaded only when a replay needs one. */
const tapes = import.meta.glob<{ default: Tape }>('./tapes/*.json');

declare global {
  interface Window {
    /** Set when a recording finishes, for the tool that saves it. */
    __ledgerTape?: Tape;
  }
}

type Replay = ReturnType<typeof replayer>;
let latestRecording: ReturnType<typeof recorder> | null = null;

const sceneRunning = () => ['running', 'paused'].includes(snapshot().status);

const replays = new Map<string, Promise<Replay>>();
let current: { scene: Scene; replay: Replay } | null = null;

function replay(scene: Scene): Promise<Replay> {
  let loading = replays.get(scene.id);
  if (!loading) {
    loading = (async () => {
      const load = tapes[`./tapes/${scene.id}.json`];
      if (!load) throw new Error(`No recording exists for the scene “${scene.title}”`);
      return replayer((await load()).default, sceneRunning);
    })();
    replays.set(scene.id, loading);
  }
  return loading;
}

/** The recording whose time the page is living in: the one that answered most recently. */
let timekeeper: Replay | null = null;
let clockInstalled = false;

/**
 * In a replay the page's clock is the recording's. Nothing recorded is changed, so every check
 * the screens make against signed content still holds, and nothing looks overdue as the
 * recording ages.
 */
function installRecordedClock(): void {
  if (clockInstalled) return;
  clockInstalled = true;
  const RealDate = Date;
  const now = () => timekeeper?.clock() ?? RealDate.now();
  class RecordedDate extends RealDate {
    constructor(...parts: unknown[]) {
      if (parts.length === 0) super(now());
      else super(...(parts as [number]));
    }
    static override now(): number {
      return now();
    }
  }
  globalThis.Date = RecordedDate as DateConstructor;
}

/** Fixture credentials name their organization: ledger-dev-<organization>-<person>. */
function organization(init?: RequestInit): string | undefined {
  return /^Bearer ledger-dev-([a-z]+)-/.exec(new Headers(init?.headers).get('authorization') ?? '')?.[1];
}

/**
 * A request is answered from the scene being watched. Someone looking around another
 * organization is answered from that organization's first scene instead.
 */
export const replayFetch: typeof fetch = async (input, init) => {
  const asking = organization(init);
  installRecordedClock();
  if (current && (!asking || current.scene.operator === asking)) {
    timekeeper = current.replay;
    return current.replay.fetcher(input, init);
  }
  const fallback = scenes.find((scene) => scene.operator === asking) ?? scenes[0]!;
  timekeeper = await replay(fallback);
  return timekeeper.fetcher(input, init);
};

/** Run a scene live, while recording it, or from its recording, as the page was asked to. */
export async function begin(scene: Scene, pace = 1): Promise<void> {
  const how = mode();
  if (how === 'replay') {
    current = { scene, replay: await replay(scene) };
    current.replay.rewind();
    timekeeper = current.replay;
    installRecordedClock();
    await play(scene, pace);
    return;
  }
  if (how === 'record') {
    const recording = recorder(scene.id, realFetch);
    latestRecording = recording;
    useFetch(recording.fetcher);
    await play(scene, pace);
    // A scene restarted before it finished leaves a newer recording in charge.
    if (latestRecording !== recording) return;
    if (snapshot().status === 'done') window.__ledgerTape = await recording.finish();
    useFetch(null);
    return;
  }
  await play(scene, pace);
}
