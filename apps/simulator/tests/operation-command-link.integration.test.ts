import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { commandLinkStatusAdapter, HttpObservationSink, translateAndSubmit } from '@ledger/adapters';
import { createApp } from '../../api/src/index.js';
import { createEmulator, emulatorConfig } from '../../emulators/src/server.js';
import { LedgerClient } from '../../../packages/contracts/src/client.js';
import type { ArtifactResponse, Principal, Receipt, TimelineResponse } from '../../../packages/contracts/src/index.js';
import { sha256 } from '../../../packages/integrity/src/index.js';
import { createPool, MemoryObjectStore, type AuthContext } from '../../../packages/persistence/src/index.js';
import {
  advanceOperation,
  createOperation,
  operationCapacityPreset,
  type WorldFact,
} from '../../../packages/simulation-models/src/operation.js';
import { acquireControlLease } from '../src/control-lease.js';
import { prepareWorldFact } from '../src/operation-delivery.js';
import { OperationTransport } from '../src/operation-transport.js';
import { isTestDatabaseUrl } from '../../../tests/integration/test-database.js';
import { projectOwnedWork, settleOwnedWork } from '../../../tests/integration/worker-queue.js';

function testDatabaseUrl(name: 'DATABASE_URL' | 'DATABASE_ADMIN_URL' | 'WORKER_DATABASE_URL'): string {
  const value = process.env[name];
  if (!value || !isTestDatabaseUrl(value)) throw new Error(`${name} must target a database named ledger_test*`);
  return value;
}

describe.runIf(process.env.LEDGER_ENV !== 'staging')('world command-link HTTP intake and projection', () => {
  const prefix = `link-wire-${randomUUID()}`;
  const tenantId = `tenant-${prefix}`;
  const managerId = `${prefix}:manager`;
  const sourcePrincipalId = `${prefix}:source`;
  const managerToken = `ledger-dev-${managerId}`;
  const sourceToken = `ledger-dev-${sourcePrincipalId}`;
  const sourceId = 'command-link';
  const sourceCapabilities = ['input:write', 'flight:read', 'evidence:read'];
  const pool = createPool(testDatabaseUrl('DATABASE_URL'));
  const admin = createPool(testDatabaseUrl('DATABASE_ADMIN_URL'));
  const workerPool = createPool(testDatabaseUrl('WORKER_DATABASE_URL'));
  const objectStore = new MemoryObjectStore();
  const worker: AuthContext = {
    id: `${prefix}:worker`,
    tenantId,
    name: 'Fictional HTTP fixture worker',
    kind: 'worker',
    capabilities: ['flight:read'],
    revision: 1,
  };
  let directory: string;
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  let emulator: ReturnType<typeof createEmulator> | undefined;
  let transport: OperationTransport | undefined;
  let releaseLease: (() => Promise<void>) | undefined;
  let manager: LedgerClient;
  let source: LedgerClient;
  let apiUrl: string;
  let discardNextInputResponse = true;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ledger-command-link-http-'));
    const client = await admin.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenantId, 'Fictional HTTP fixture operator']);
      for (const [id, kind, capabilities, token] of [
        [managerId, 'human', ['flight:create', 'flight:read', 'evidence:read', 'authority:write'], managerToken],
        [sourcePrincipalId, 'source', sourceCapabilities, sourceToken],
      ] as const) {
        await client.query('INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,$3,$4,$5)', [
          id,
          tenantId,
          `Fictional ${kind}`,
          kind,
          capabilities,
        ]);
        await client.query('INSERT INTO api_credentials(token_hash,principal_id) VALUES($1,$2)', [sha256(token), id]);
      }
      await client.query("INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,$3,'worker',$4)", [
        worker.id,
        tenantId,
        worker.name,
        worker.capabilities,
      ]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    app = await createApp({ pool, env: 'test', objectStore });
    apiUrl = await app.listen({ port: 0, host: '127.0.0.1' });
    manager = new LedgerClient(apiUrl, managerToken);
    source = new LedgerClient(apiUrl, sourceToken, async (url, init) => {
      const response = await fetch(url, init);
      if (new URL(String(url)).pathname === '/v1/inputs' && response.ok && discardNextInputResponse) {
        discardNextInputResponse = false;
        await response.arrayBuffer();
        throw new Error('Injected lost accepted command-link response');
      }
      return response;
    });
    const { principal } = await source.request<{ principal: Principal }>('/v1/me');
    await manager.command(
      {
        kind: 'authority.update',
        principalId: principal.id,
        expectedRevision: principal.revision,
        capabilities: sourceCapabilities,
        observationGrants: [{ sourceId, observationType: 'link.status' }],
      },
      `${prefix}:grant`,
    );

    const config = emulatorConfig({
      EMULATOR_PORT: '0',
      EMULATOR_ADMIN_KEY: `${prefix}:admin`,
      PARTNER_API_KEY: `${prefix}:callback`,
      EMULATOR_CALLBACK_ORIGINS: '',
    });
    emulator = createEmulator(config);
    await new Promise<void>((resolve) => emulator!.server.listen(0, '127.0.0.1', resolve));
    const address = emulator.server.address();
    if (!address || typeof address === 'string') throw new Error('HTTP fixture emulator did not bind');
    const emulatorUrl = `http://127.0.0.1:${address.port}`;
    const lease = await acquireControlLease(emulatorUrl, config.adminKey, 'scenario');
    releaseLease = () => lease.release();
    transport = new OperationTransport({
      emulatorUrl,
      adminKey: config.adminKey,
      partnerKey: config.partnerKey,
      callbackHost: '127.0.0.1',
      callbackPort: 0,
      mqttUrl: 'mqtt://127.0.0.1:1',
      bindings: {},
      stateDirectory: directory,
      controlHeaders: () => lease.headers(),
    });
    await transport.start();
    config.callbackOrigins.push(transport.callbackUrl);
  });

  afterAll(async () => {
    await settleOwnedWork([tenantId], { objectStore });
    await transport?.stop();
    await releaseLease?.();
    if (emulator?.server.listening) {
      emulator.server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        emulator!.server.close((error) => (error ? reject(error) : resolve())),
      );
    }
    await app?.close();
    await Promise.all([pool.end(), admin.end(), workerPool.end()]);
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function drainFixture(): Promise<void> {
    await projectOwnedWork(admin, workerPool, [tenantId], { objectStore });
  }

  it('recovers the same retained loss request and projects exact loss/restoration originals once', async () => {
    const world = createOperation({
      ...operationCapacityPreset('illustrative-25.1'),
      runId: prefix.slice(0, 40),
      seed: 71031,
      start: '2026-10-01T14:00:00.000Z',
      commandLinkEpisode: 'canal-market-relay.1',
    });
    advanceOperation(world, world.now + 120_000);
    const firstLoss = world.facts.find((fact) => fact.kind === 'command-link' && fact.status === 'lost');
    if (firstLoss?.kind !== 'command-link') throw new Error('Expected world command-link loss');
    const reports = world.facts.filter(
      (fact): fact is Extract<WorldFact, { kind: 'command-link' }> =>
        fact.kind === 'command-link' && fact.attemptId === firstLoss.attemptId,
    );
    expect(reports.map((fact) => fact.status)).toEqual(['lost', 'restored']);
    const flight = await manager.createFlight(
      {
        originationKey: firstLoss.attemptId,
        label: 'Fictional relay hold',
        aircraft: firstLoss.aircraftId,
      },
      `${prefix}:flight`,
    );
    await drainFixture();
    const before = await manager.timeline(flight.flight.id);
    const sink = new HttpObservationSink({ ledger: source, sourceId });
    const deliver = (raw: Uint8Array) =>
      translateAndSubmit(
        commandLinkStatusAdapter,
        { bytes: raw, contentType: 'application/json', transport: {}, capturedAt: firstLoss.at },
        {
          subjects: { scope: 'ledger', ids: { flight: { [firstLoss.sourceSessionId]: flight.flight.id } } },
          binding: { sourceSessionId: firstLoss.sourceSessionId, aircraftId: firstLoss.aircraftId! },
        },
        sink,
      );
    const lost = prepareWorldFact(reports[0]!);
    await expect(
      transport!.commandLink(lost, async (raw) => {
        expect(Buffer.from(raw).toString('base64')).toBe(lost.bytesBase64);
        return deliver(raw);
      }),
    ).rejects.toThrow('Injected lost accepted command-link response');
    const acceptedBeforeRecovery = (await source.receipts({ flightId: flight.flight.id })).receipts;
    expect(acceptedBeforeRecovery).toHaveLength(1);
    // A fresh sink after a restart sends the same bytes and keys again and is given the same receipt.
    const recovered = await transport!.commandLink(lost, (raw) =>
      translateAndSubmit(
        commandLinkStatusAdapter,
        { bytes: raw, contentType: 'application/json', transport: {}, capturedAt: firstLoss.at },
        {
          subjects: { scope: 'ledger', ids: { flight: { [firstLoss.sourceSessionId]: flight.flight.id } } },
          binding: { sourceSessionId: firstLoss.sourceSessionId, aircraftId: firstLoss.aircraftId! },
        },
        new HttpObservationSink({ ledger: source, sourceId }),
      ),
    );
    expect(recovered.submitted[0]!.receiptId).toBe(acceptedBeforeRecovery[0]!.id);
    const restored = prepareWorldFact(reports[1]!);
    const restoredResult = await transport!.commandLink(restored, (raw) => deliver(raw));
    await drainFixture();
    const shown: TimelineResponse = await manager.timeline(flight.flight.id);
    const receipts: Receipt[] = [];
    for (const [result, prepared] of [
      [recovered, lost],
      [restoredResult, restored],
    ] as const) {
      const receipt = (await source.receipt(result.submitted[0]!.receiptId)).receipt;
      receipts.push(receipt);
      expect(receipt).toMatchObject({
        kind: 'observation',
        sourceId,
        flightId: flight.flight.id,
        status: 'accepted',
        linkStatus: 'linked',
        artifactId: result.artifactId,
        payload: result.submitted[0]!.observation,
        processing: { status: 'completed' },
      });
      const artifact = (await source.request<ArtifactResponse>(`/v1/artifacts/${receipt.artifactId}`)).artifact;
      const bytes = await source.evidence(receipt.artifactId!);
      expect(Buffer.from(bytes).toString('base64')).toBe(prepared.bytesBase64);
      expect(artifact).toMatchObject({ sha256: sha256(bytes), byteLength: bytes.byteLength });
      expect(shown.items.find((item) => item.id === receipt.eventId)).toMatchObject({
        kind: 'observation',
        lane: 'observed',
        actorId: sourcePrincipalId,
        sourceId,
        artifactId: receipt.artifactId,
        receiptId: receipt.id,
      });
    }
    expect(new Set(receipts.map((receipt) => receipt.id)).size).toBe(2);
    expect(shown.flight.basisRevision).toBeGreaterThan(before.flight.basisRevision);
    expect(shown.flight.activity).toBe(before.flight.activity);
    const replay = await transport!.commandLink(lost, (raw) => deliver(raw));
    expect(replay.submitted[0]!.receiptId).toBe(recovered.submitted[0]!.receiptId);
    // Nothing is written to the retained command-link tables.
    const counts = (
      await admin.query<{ receipts: number; identities: number; sessions: number }>(
        `SELECT (SELECT COUNT(*)::int FROM receipts WHERE tenant_id=$1 AND kind='observation') AS receipts,
       (SELECT COUNT(*)::int FROM command_link_source_events WHERE tenant_id=$1) AS identities,
       (SELECT COUNT(*)::int FROM command_link_sessions WHERE tenant_id=$1) AS sessions`,
        [tenantId],
      )
    ).rows[0];
    expect(counts).toEqual({ receipts: 2, identities: 0, sessions: 0 });
  });
});
