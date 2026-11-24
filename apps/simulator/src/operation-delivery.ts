import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DjiMqttAdapter, LedgerClient, PartnerOrderAdapter, digest, retainInput } from '@ledger/adapters';
import type { FlightListResponse, Input, TelemetrySegment } from '@ledger/contracts';
import { djiOsdBytes } from '@ledger/emulators';
import type { WorldFact } from '@ledger/simulation-models/operation';
import type { ScenarioConfig } from './scenario.js';
import type { OperationTransport } from './operation-transport.js';
import { deliverCommandLink } from './operation-command-link-delivery.js';
import { deliverMission } from './operation-mission-delivery.js';

export interface PreparedWorldFact {
  fact: WorldFact;
  bytesBase64: string;
}
interface Commitment {
  principalId: string;
  key: string;
  input: Input;
  wireDigests: string[];
  receiptId?: string;
}
interface DeliveryJournal {
  version: 1 | 2;
  binding: string;
  principals: Partial<Record<'source' | 'actor', string>>;
  flightId?: string;
  captureInitialized?: boolean;
  aircraftId?: string;
  primarySessionId?: string;
  facts: Record<string, PreparedWorldFact & { receiptId?: string }>;
  commitments: Commitment[];
}

async function save(path: string, value: DeliveryJournal): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(value) + '\n');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    const directory = await open(dirname(path), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

const wireDigest = (topic: string, bytes: Uint8Array) =>
  digest(Buffer.concat([Buffer.from(topic), Buffer.from([0]), Buffer.from(bytes)]));

export function prepareWorldFact(fact: WorldFact): PreparedWorldFact {
  if (fact.kind === 'mission')
    return {
      fact: structuredClone(fact),
      bytesBase64:
        fact.publicAcceptance?.originalBytesBase64 ??
        Buffer.from(JSON.stringify(fact.source), 'utf8').toString('base64'),
    };
  const raw =
    fact.kind === 'position'
      ? djiOsdBytes(fact.point, `GW-${fact.aircraftId}`, {
          tid: `${fact.sourceSessionId}:${fact.sequence}`,
          bid: `${fact.sourceSessionId}:osd:${fact.sequence}`,
        })
      : new TextEncoder().encode(
          JSON.stringify(
            fact.kind === 'order'
              ? fact.order
              : fact.kind === 'cancellation'
                ? {
                    activity: 'cancelled',
                    title: 'Flight cancelled before departure',
                    aircraft: fact.aircraftId,
                    personId: fact.personId,
                    personName: fact.personName,
                    personRole: 'dispatcher',
                    reason: fact.reason,
                    note: fact.note,
                  }
                : fact.kind === 'landing-report'
                  ? {
                      activity: 'landed',
                      title: 'Ground crew landing report',
                      aircraft: fact.aircraftId,
                      personId: fact.personId,
                      personName: fact.personName,
                      landingTime: fact.reportedLandingAt,
                      reportRecordedAt: fact.reportAt,
                      incidentId: fact.incidentId,
                      note: 'Ground handset clock was 30 seconds fast; report queued until the connection returned.',
                    }
                  : fact.kind === 'command-link'
                    ? {
                        sourceSessionId: fact.sourceSessionId,
                        occurredAt: fact.at,
                        sourceEventId: fact.sourceEventId,
                        incidentId: fact.incidentId,
                        aircraftId: fact.aircraftId,
                        status: fact.status,
                        position: fact.position,
                      }
                    : {
                        activity: fact.kind === 'departure' ? 'active' : 'landed',
                        title: fact.kind === 'departure' ? 'Departure reported' : 'Landing reported',
                        aircraft: fact.aircraftId,
                        personId: fact.personId,
                        personName: fact.personName,
                        ...(fact.kind === 'landing' ? { landingTime: fact.at } : {}),
                      },
          ),
        );
  return { fact: structuredClone(fact), bytesBase64: Buffer.from(raw).toString('base64') };
}

export class OperationDelivery {
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(
    private readonly config: ScenarioConfig & {
      stateDirectory: string;
      transport?: Pick<OperationTransport, 'position' | 'partnerOrder' | 'commandLink'> &
        Partial<Pick<OperationTransport, 'mission'>>;
      departureBinding?: (
        attemptId: string,
      ) => { flightId: string; tenantId: string; aircraftId: string; sourceSessionId: string } | undefined;
    },
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  prepare(fact: WorldFact): PreparedWorldFact {
    return prepareWorldFact(fact);
  }

  deliver(prepared: PreparedWorldFact): Promise<{ receiptId: string }> {
    const identity = `${prepared.fact.tenant}:${prepared.fact.attemptId}${
      prepared.fact.kind === 'command-link' ? ':command-link' : prepared.fact.kind === 'mission' ? ':mission' : ''
    }`;
    const task = (this.queues.get(identity) ?? Promise.resolve()).then(() => this.deliverFact(prepared));
    const tail = task.catch(() => {});
    this.queues.set(identity, tail);
    void tail.then(() => {
      if (this.queues.get(identity) === tail) this.queues.delete(identity);
    });
    return task;
  }

  private client(tenant: WorldFact['tenant'], role: 'source' | 'actor'): LedgerClient {
    return new LedgerClient(this.config.apiUrl, this.config.tokens[tenant][role], (url, init) =>
      this.fetcher(url, { ...init, signal: AbortSignal.timeout(5000) }),
    );
  }

  private async deliverFact(prepared: PreparedWorldFact): Promise<{ receiptId: string }> {
    const { fact } = prepared;
    if (this.prepare(fact).bytesBase64 !== prepared.bytesBase64)
      throw new Error('Prepared world fact does not reproduce its retained source bytes');
    if (fact.kind === 'mission') {
      if (!this.config.transport?.mission) throw new Error('Mission delivery requires its HTTP transport');
      return deliverMission(
        prepared,
        { ...this.config, transport: { mission: this.config.transport.mission.bind(this.config.transport) } },
        this.client(fact.tenant, 'source'),
      );
    }
    if (fact.kind === 'command-link') {
      if (!this.config.transport) throw new Error('Command-link delivery requires its HTTP transport');
      return deliverCommandLink(
        prepared,
        { ...this.config, transport: this.config.transport },
        this.client(fact.tenant, 'source'),
      );
    }
    const departure = this.config.departureBinding?.(fact.attemptId);
    if (
      departure &&
      (!departure.flightId ||
        departure.tenantId !== `tenant-${fact.tenant}` ||
        (fact.aircraftId !== undefined && departure.aircraftId !== fact.aircraftId) ||
        fact.sourceSessionId !==
          (fact.kind === 'landing-report' ? `${departure.sourceSessionId}-buffered-person` : departure.sourceSessionId))
    )
      throw new Error('Committed world departure differs from its retained source binding');
    const legacyBinding = digest(
      JSON.stringify({
        apiUrl: this.config.apiUrl,
        tenant: fact.tenant,
        attemptId: fact.attemptId,
        aircraftId: fact.aircraftId,
        sourceSessionId: fact.sourceSessionId,
      }),
    );
    const binding = digest(
      JSON.stringify({ apiUrl: this.config.apiUrl, tenant: fact.tenant, attemptId: fact.attemptId }),
    );
    const path = join(this.config.stateDirectory, 'delivery', `${digest(fact.attemptId)}.json`);
    let journal: DeliveryJournal;
    try {
      journal = JSON.parse(await readFile(path, 'utf8')) as DeliveryJournal;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      journal = { version: 2, binding, principals: {}, facts: {}, commitments: [] };
    }
    if (
      (journal.version !== 1 && journal.version !== 2) ||
      journal.binding !== (journal.version === 1 ? legacyBinding : binding) ||
      !journal.facts ||
      !journal.commitments
    )
      throw new Error('World delivery journal belongs to another source binding');
    if (departure) {
      if (journal.flightId && journal.flightId !== departure.flightId)
        throw new Error('Committed world departure differs from its retained exact flight');
      journal.flightId = departure.flightId;
    }
    if (journal.version === 2) {
      if (fact.aircraftId && journal.aircraftId && fact.aircraftId !== journal.aircraftId)
        throw new Error('World attempt changed its retained aircraft identity');
      if (fact.kind !== 'landing-report') {
        if (journal.primarySessionId && journal.primarySessionId !== fact.sourceSessionId)
          throw new Error('World attempt changed its retained source session');
        journal.primarySessionId = fact.sourceSessionId;
      }
      journal.aircraftId ??= fact.aircraftId;
    }
    const retained = journal.facts[fact.sequence];
    if (
      retained &&
      JSON.stringify({ fact: retained.fact, bytesBase64: retained.bytesBase64 }) !== JSON.stringify(prepared)
    )
      throw new Error('A retained world fact cannot change on retry');
    if (retained?.receiptId) return { receiptId: retained.receiptId };
    journal.facts[fact.sequence] ??= structuredClone(prepared);
    await save(path, journal);

    const role =
      fact.kind === 'departure' ||
      fact.kind === 'landing' ||
      fact.kind === 'landing-report' ||
      fact.kind === 'cancellation'
        ? 'actor'
        : 'source';
    const ledger = this.client(fact.tenant, role);
    const { principal } = await ledger.request<{ principal: { id: string; tenantId: string } }>('/v1/me');
    if (
      principal.tenantId !== `tenant-${fact.tenant}` ||
      (journal.principals[role] && journal.principals[role] !== principal.id)
    )
      throw new Error('World delivery principal changed its tenant or retained source identity');
    journal.principals[role] = principal.id;
    if (fact.kind !== 'order' && !journal.flightId) {
      const order = Object.values(journal.facts).find((entry) => entry.fact.kind === 'order')?.fact;
      if (order?.kind !== 'order') throw new Error('World observation lacks its retained originating order');
      const deadline = Date.now() + 5000;
      const seen = new Set<string>();
      let cursor: string | undefined;
      do {
        if (Date.now() >= deadline) throw new Error('World originating flight lookup exceeded its deadline');
        const query = new URLSearchParams({ search: order.order.order_id, limit: '200' });
        if (cursor) query.set('cursor', cursor);
        const page = await ledger.request<FlightListResponse>(`/v1/flights?${query}`);
        journal.flightId = page.flights.find((row) => row.originationKey === fact.attemptId)?.id;
        cursor = page.nextCursor ?? undefined;
        if (cursor && seen.has(cursor)) throw new Error('World originating flight lookup repeated its cursor');
        if (cursor) seen.add(cursor);
      } while (!journal.flightId && cursor);
      if (!journal.flightId) throw new Error('World observation is retained until its originated flight is visible');
    }
    await save(path, journal);

    const segmentDigests = new Map<string, string[]>();
    const upload = ledger.upload.bind(ledger);
    ledger.upload = async (bytes, contentType, key, filename) => {
      const result = await upload(bytes, contentType, key, filename);
      if (fact.kind === 'position') {
        const segment = JSON.parse(Buffer.from(bytes).toString('utf8')) as TelemetrySegment;
        segmentDigests.set(
          result.artifact.id,
          segment.samples.map((sample) =>
            wireDigest(sample.original.topic, Buffer.from(sample.original.bytesBase64, 'base64')),
          ),
        );
      }
      return result;
    };
    const input = ledger.input.bind(ledger);
    ledger.input = async (body, key) => {
      let commitment = journal.commitments.find((entry) => entry.principalId === principal.id && entry.key === key);
      if (commitment && JSON.stringify(commitment.input) !== JSON.stringify(body))
        throw new Error('World delivery idempotency commitment changed');
      if (!commitment) {
        commitment = {
          principalId: principal.id,
          key,
          input: structuredClone(body),
          wireDigests: body.artifactId ? (segmentDigests.get(body.artifactId) ?? []) : [],
        };
        journal.commitments.push(commitment);
        await save(path, journal);
      }
      const result = await input(commitment.input, commitment.key);
      commitment.receiptId = result.receipt.id;
      await save(path, journal);
      return result;
    };

    const bytes = Buffer.from(prepared.bytesBase64, 'base64');
    let receiptId: string;
    if (fact.kind === 'position') {
      const capturePath = join(this.config.stateDirectory, 'captures', `${digest(fact.sourceSessionId)}.json`);
      if (journal.captureInitialized) {
        const capture = await lstat(capturePath).catch(() => {
          throw new Error('World capture checkpoint is missing; refusing to reset its source identity');
        });
        if (!capture.isFile() || capture.isSymbolicLink())
          throw new Error('World capture checkpoint is not a retained regular file');
      }
      const adapterConfig = {
        ledger,
        tenantId: principal.tenantId,
        sourceId: 'dji-osd',
        sourceSessionId: fact.sourceSessionId,
        deviceId: fact.aircraftId,
        gatewayId: `GW-${fact.aircraftId}`,
        subject:
          this.config.transport || departure ? { flightId: journal.flightId! } : { originationKey: fact.attemptId },
        statePath: capturePath,
        mqttUrl: 'mqtt://127.0.0.1:1',
        username: 'in-process-wire-capture',
        password: 'mqtt-transport-disabled',
      };
      const topic = `thing/product/${fact.aircraftId}/osd`;
      if (this.config.transport) {
        await this.config.transport.position(prepared, { ...adapterConfig, subject: { flightId: journal.flightId! } });
        journal.captureInitialized = true;
        await save(path, journal);
      } else {
        const adapter = new DjiMqttAdapter(adapterConfig);
        await adapter.initialize();
        journal.captureInitialized = true;
        await save(path, journal);
        await adapter.ingest(topic, bytes);
        await adapter.flush();
      }
      const received = journal.commitments.find((entry) => entry.wireDigests.includes(wireDigest(topic, bytes)));
      if (!received?.receiptId) throw new Error('World position receipt remains unresolved in its capture journal');
      receiptId = received.receiptId;
    } else if (fact.kind === 'order') {
      const adapter = new PartnerOrderAdapter({
        ledger,
        sourceId: 'partner-orders',
        sourceSessionId: fact.sourceSessionId,
        baseUrl: this.config.emulatorUrl,
        apiKey: this.config.partnerKey,
      });
      const result = this.config.transport
        ? await this.config.transport.partnerOrder(prepared, (raw) => adapter.ingest(raw))
        : await adapter.ingest(bytes);
      receiptId = result.receipt.receipt.id;
    } else {
      const result = await retainInput(
        {
          ledger,
          sourceId: fact.kind === 'landing-report' ? fact.sourceId : `simulation-person-${fact.tenant}`,
          sourceSessionId: fact.sourceSessionId,
        },
        bytes,
        'application/json',
        {
          kind: 'flight.observation',
          occurredAt: fact.at,
          subject: departure ? { flightId: departure.flightId } : { originationKey: fact.attemptId },
          payload: JSON.parse(bytes.toString('utf8')) as Record<string, unknown>,
          fidelity: 'synthetic_contract',
        },
        `operation:${fact.sourceSessionId}:${fact.sequence}:${fact.kind}`,
      );
      receiptId = result.receipt.receipt.id;
    }
    journal.facts[fact.sequence]!.receiptId = receiptId;
    await save(path, journal);
    return { receiptId };
  }
}
