import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../../apps/api/src/index.js';
import { createPool, MemoryObjectStore } from '../../persistence/src/index.js';
import { LedgerClient } from '../../contracts/src/client.js';
import { type TranslationContext, type VendorMessage, translateAndSubmit } from '../src/adapter-contract.js';
import { djiOsdBatteryAdapter } from '../src/dji-osd-battery.js';
import type { DjiOsdBinding } from '../src/dji-osd-position.js';
import { HttpObservationSink, ObservationSinkRefusal } from '../src/http-observation-sink.js';
import { djiFaultScripts, planScriptedFlight } from '../../../apps/emulators/src/dji-fault-script.js';
import { settleOwnedWork } from '../../../tests/integration/worker-queue.js';

// A scripted low-battery flight from the emulator, through the battery adapter and the public API, read back as
// accepted observations. The emulator only builds vendor messages; the adapter and the sink do the rest.
describe.runIf(process.env.LEDGER_ENV !== 'staging')('Scripted battery fault end to end', () => {
  const pool = createPool();
  const store = new MemoryObjectStore();
  const prefix = `battery-fault-${randomUUID()}`;
  const sourceId = `${prefix}-telemetry`;
  const binding = { deviceId: `${prefix}-aircraft`, gatewayId: `${prefix}-dock` };
  const context: TranslationContext<DjiOsdBinding> = { subjects: { scope: 'source' }, binding };
  const plan = planScriptedFlight(djiFaultScripts['battery-sag-on-approach']!, {
    start: '2026-10-05T09:00:00.000Z',
    ...binding,
    runId: prefix,
  });
  const messages: VendorMessage[] = plan.messages.map((message) => ({
    bytes: message.bytes,
    contentType: 'application/json',
    transport: { topic: message.topic },
    capturedAt: new Date(Date.parse(message.occurredAt) + 250).toISOString(),
  }));
  let app: Awaited<ReturnType<typeof createApp>>;
  let source: LedgerClient;
  let operator: LedgerClient;

  const sink = () => new HttpObservationSink({ ledger: source, sourceId });
  const submitAll = async () => {
    const target = sink();
    const outcomes = [];
    for (const message of messages)
      outcomes.push(await translateAndSubmit(djiOsdBatteryAdapter, message, context, target));
    return outcomes;
  };
  const readBack = async () => {
    const query = new URLSearchParams({
      type: 'battery.state',
      subjectKind: 'aircraft',
      subjectId: binding.deviceId,
      subjectScope: 'source',
      sourceId,
      from: '2026-10-05T08:00:00Z',
      to: '2026-10-05T10:00:00Z',
      limit: '500',
    });
    return source.request<{ observations: any[]; page: { hasMore: boolean } }>(`/v1/observations?${query}`);
  };

  beforeAll(async () => {
    app = await createApp({ pool, env: 'test', objectStore: store });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    source = new LedgerClient(address, 'ledger-dev-alpha-source');
    operator = new LedgerClient(address, 'ledger-dev-alpha-operator');
  });
  afterAll(async () => {
    await settleOwnedWork(['tenant-alpha'], { objectStore: store });
    if (app) await app.close();
    await pool.end();
  });

  it('is refused plainly before the source holds a grant for battery.state', async () => {
    const failure = await translateAndSubmit(djiOsdBatteryAdapter, messages[0]!, context, sink()).catch(
      (error) => error,
    );
    expect(failure).toBeInstanceOf(ObservationSinkRefusal);
    expect(failure).toMatchObject({ step: 'submit_observation', status: 403, code: 'observation_grant_required' });
  });

  it('accepts the sag in order, each observation citing its retained original, and a replay adds nothing', async () => {
    const { principal } = await operator.request<{ principal: any }>('/v1/authority/principals/principal-alpha-source');
    await operator.command(
      {
        kind: 'authority.update',
        principalId: 'principal-alpha-source',
        expectedRevision: principal.revision,
        capabilities: principal.capabilities,
        observationGrants: [...(principal.observationGrants ?? []), { sourceId, observationType: 'battery.state' }],
      } as never,
      `${prefix}:grant`,
    );

    const outcomes = await submitAll();
    expect(outcomes.every((outcome) => outcome.rejections.length === 0 && outcome.submitted.length === 1)).toBe(true);

    const page = await readBack();
    expect(page.page.hasMore).toBe(false);
    expect(page.observations).toHaveLength(plan.messages.length);
    expect(page.observations.map((item) => item.occurredAt)).toEqual(plan.messages.map((item) => item.occurredAt));

    const percents = page.observations.map((item) => item.observation.values.totalRemainingPercent as number);
    expect(percents).toEqual([...percents].sort((a, b) => b - a));
    const approach = plan.messages.findIndex((message) => message.offsetMs === 150_000);
    expect(percents.slice(0, approach).every((value) => value > 30)).toBe(true);
    const values = page.observations.at(-1).observation.values;
    expect(values.totalRemainingPercent).toBeLessThan(values.lowWarningThresholdPercent);
    expect(values.totalRemainingPercent).toBeLessThan(values.returnHomeRemainingPercent);
    expect(values).toMatchObject({ forcedLandingRemainingPercent: 10, criticalWarningThresholdPercent: 15 });
    expect(page.observations[approach].observation.values.packs.map((pack: any) => pack.remainingPercent)).toEqual([
      33, 29,
    ]);

    for (const [index, item] of page.observations.entries()) {
      expect(item.artifactId).toBe(item.observation.originalArtifactId);
      expect(item.observation.originalLocator).toEqual({ kind: 'json_pointer', value: '/data' });
      expect(item.artifactId).toBe(outcomes[index]!.artifactId);
      expect(await source.evidence(item.artifactId)).toEqual(plan.messages[index]!.bytes);
    }

    const replay = await submitAll();
    expect(replay.map((outcome) => outcome.artifactId)).toEqual(outcomes.map((outcome) => outcome.artifactId));
    expect(replay.map((outcome) => outcome.submitted[0]!.receiptId)).toEqual(
      outcomes.map((outcome) => outcome.submitted[0]!.receiptId),
    );
    const after = await readBack();
    expect(after.observations.map((item) => item.id)).toEqual(page.observations.map((item) => item.id));
  });
});
