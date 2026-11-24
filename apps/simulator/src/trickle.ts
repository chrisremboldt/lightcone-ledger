import { LedgerClient, PartnerOrderAdapter, retainInput } from '@ledger/adapters';
import { scenarioConfig } from './scenario.js';
import { acquireControlLease } from './control-lease.js';
import { publicFlights, recoverTrickleNext } from './public-state.js';
import { bindBoundedRun, loadCheckpoint, saveCheckpoint } from './trickle-state.js';
import { runTrickleLoop } from './trickle-loop.js';
import { ContinuingTelemetry, continuingTelemetryConfig, landingObservationTime } from './continuing-telemetry.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { continuingExpectations } from './continuing-telemetry-model.js';

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const trickleMissions = {
  alpha: [
    'Prescription drop · Oakview',
    'Lab courier · Mercy North',
    'Pharmacy run · Eastside Clinic',
    'Parcel delivery · Canal Market',
    'First-aid kit · Lakeshore Pool',
    'Insulin restock · Ridge Pharmacy',
    'Sample return · Westfield Lab',
  ],
  beta: [
    'Power line patrol · Feeder 12',
    'Cell tower check · Hilltop',
    'Rail culvert scan · Mile 41',
    'Solar farm thermal · Array C',
    'Water tower survey · Elm Park',
    'Substation roof · Grid 3',
    'Bridge bearing check · Route 9',
  ],
} as const;
export async function trickle(): Promise<void> {
  const config = scenarioConfig();
  const interval = Number(process.env.SIMULATOR_INTERVAL_MS ?? 60_000);
  if (!Number.isFinite(interval) || interval < 1000) throw new Error('Trickle interval must be at least one second');
  const statePath = process.env.SIMULATOR_TRICKLE_STATE ?? '.local/simulator/trickle-state.json';
  const clients = {
    alpha: new LedgerClient(config.apiUrl, config.tokens.alpha.source),
    beta: new LedgerClient(config.apiUrl, config.tokens.beta.source),
  };
  const telemetry =
    process.env.SIMULATOR_TELEMETRY === '1'
      ? new ContinuingTelemetry(
          continuingTelemetryConfig(config.apiUrl, interval, {
            alpha: config.tokens.alpha.source,
            beta: config.tokens.beta.source,
          }),
        )
      : undefined;
  const flightLimit =
    process.env.SIMULATOR_TELEMETRY_MAX_FLIGHTS === undefined
      ? undefined
      : Number(process.env.SIMULATOR_TELEMETRY_MAX_FLIGHTS);
  if (
    flightLimit !== undefined &&
    (!telemetry || !Number.isSafeInteger(flightLimit) || flightLimit < 1 || flightLimit > 10)
  )
    throw new Error('The bounded telemetry command requires 1–10 flights and opt-in local telemetry');
  const controlLease = await acquireControlLease(config.emulatorUrl, config.adminKey, 'trickle');
  try {
    await telemetry?.initialize();
    let checkpoint = await loadCheckpoint(statePath, () => recoverTrickleNext(clients));
    const firstSequence = flightLimit === undefined ? checkpoint.next : bindBoundedRun(checkpoint, flightLimit);
    if (flightLimit !== undefined) await saveCheckpoint(statePath, checkpoint);
    const runDeadline = flightLimit === undefined ? Infinity : Date.now() + (flightLimit + 1) * interval + 180_000;
    const belongsToRun = (intentId: string) => {
      const sequence = Number(intentId.split('-').at(-1));
      return sequence >= firstSequence && (flightLimit === undefined || sequence < firstSequence + flightLimit);
    };
    const completedCount = () => telemetry?.recent.filter((flight) => belongsToRun(flight.route.intentId)).length ?? 0;
    const save = () => saveCheckpoint(statePath, checkpoint);
    const adapters = {
      alpha: new PartnerOrderAdapter({
        ledger: clients.alpha,
        sourceId: 'partner-orders',
        baseUrl: config.emulatorUrl,
        apiKey: config.partnerKey,
      }),
      beta: new PartnerOrderAdapter({
        ledger: clients.beta,
        sourceId: 'partner-orders',
        baseUrl: config.emulatorUrl,
        apiKey: config.partnerKey,
      }),
    };
    const paused = (error: unknown) => {
      controlLease.headers();
      console.error(`dev-trickle paused: ${error instanceof Error ? error.message : 'request failed'}`);
    };
    let stopped = false;
    process.once('SIGTERM', () => {
      stopped = true;
    });
    process.once('SIGINT', () => {
      stopped = true;
    });
    console.log(
      `dev-trickle: one fictional flight every ${interval / 1000}s; native observations use the public API. Continuing at sequence ${checkpoint.next}.`,
    );
    await runTrickleLoop({
      interval,
      stopped: () =>
        stopped ||
        Date.now() >= runDeadline ||
        (flightLimit !== undefined && completedCount() >= flightLimit && telemetry!.activeCount === 0),
      assertControl: () => {
        controlLease.headers();
      },
      saturated: () => {
        console.error('dev-trickle generator saturated; skipped arrivals are not counted as accepted');
      },
      async arrival(scheduled) {
        if (
          flightLimit !== undefined &&
          (completedCount() >= flightLimit || checkpoint.next >= firstSequence + flightLimit)
        )
          return;
        const current = checkpoint.next;
        if (!checkpoint.pending) {
          const tenant = current % 10 === 9 ? ('beta' as const) : ('alpha' as const);
          const id = `trickle-${tenant}-${current}`;
          if (telemetry && !telemetry.canStart(tenant, id)) {
            console.error(`dev-trickle skipped scheduled arrival: fictional ${tenant} device remains reserved`);
            return;
          }
          const start = new Date(scheduled).toISOString();
          const end = new Date(scheduled + 120_000).toISOString();
          const order = {
            order_id: `order-${id}`,
            version: 1,
            state: 'accepted',
            updated_at: start,
            requested_work: { name: trickleMissions[tenant][current % trickleMissions[tenant].length] },
            schedule: { start, end },
            flights: [
              {
                flight_intent_id: id,
                attempt: 1,
                order_refs: [`order-${id}`],
                aircraft_id: telemetry ? `DJI-${tenant.toUpperCase()}-01` : `aircraft-${tenant}-${current % 3}`,
              },
            ],
          };
          checkpoint.pending = { tenant, id, start, end, order };
          await save();
        }
        const { tenant, id, start, order } = checkpoint.pending;
        try {
          const health = (await fetch(`${config.emulatorUrl}/healthz`, { signal: AbortSignal.timeout(5000) }).then(
            (response) => response.json(),
          )) as { simulation?: boolean };
          if (!health.simulation) throw new Error('Emulator simulation identity missing');
          const response = await fetch(`${config.emulatorUrl}/_simulation/partner/orders`, {
            method: 'PUT',
            headers: controlLease.headers(),
            body: JSON.stringify({ orders: [order] }),
            signal: AbortSignal.timeout(5000),
          });
          if (!response.ok) throw new Error(`Emulator rejected order ${response.status}`);
          const [accepted] = await adapters[tenant].poll();
          const deadline = Date.now() + 20_000;
          let completed = false;
          while (!stopped && Date.now() < deadline) {
            const status = await clients[tenant].receipt(accepted!.receipt.receipt.id);
            if (status.receipt.processing.status === 'failed') throw new Error('Trickle receipt failed processing');
            if (status.receipt.processing.status === 'completed') {
              completed = true;
              break;
            }
            await pause(100);
          }
          if (!completed) throw new Error('Trickle receipt remained pending beyond its bound');
          const flight = (await publicFlights(clients[tenant])).flights.find(
            (row) => row.originationKey === `${id}:attempt:1`,
          );
          if (!flight) throw new Error('Originated flight missing from scoped projection');
          const fulfillment = Array.isArray(order.flights) ? (order.flights[0] as { aircraft_id?: string }) : undefined;
          const telemetryOrder = telemetry && fulfillment?.aircraft_id === `DJI-${tenant.toUpperCase()}-01`;
          if (telemetryOrder && flight.aircraft !== fulfillment!.aircraft_id)
            throw new Error('Continuing source device differs from the originated flight assignment');
          const route = telemetryOrder ? await telemetry.begin(tenant, id, flight.id, flight.label) : undefined,
            departedAt = route?.startedAt ?? start;
          const raw = new TextEncoder().encode(
            JSON.stringify({ activity: 'active', title: 'Synthetic departure', scheduledArrival: start }),
          );
          await retainInput(
            {
              ledger: new LedgerClient(config.apiUrl, config.tokens[tenant].actor),
              sourceId: `simulation-person-${tenant}`,
            },
            raw,
            'application/json',
            {
              kind: 'flight.observation',
              occurredAt: departedAt,
              subject: { flightId: flight.id },
              payload: JSON.parse(new TextDecoder().decode(raw)),
              fidelity: 'synthetic_contract',
            },
            `trickle:${id}:departure`,
          );
          checkpoint = { next: current + 1, ...(checkpoint.boundedRun ? { boundedRun: checkpoint.boundedRun } : {}) };
          await save();
          console.log(`dev-trickle accepted ${id}; arrival lag ${Math.max(0, Date.now() - scheduled)}ms`);
        } catch (error) {
          paused(error);
        }
      },
      async landings() {
        try {
          for (const dueTenant of ['alpha', 'beta'] as const) {
            for (const due of (await publicFlights(clients[dueTenant])).flights) {
              if (
                (due.activity === 'planned' || due.activity === 'unknown') &&
                due.scheduledStart &&
                Date.parse(due.scheduledStart) <= Date.now() &&
                (!due.scheduledEnd || Date.parse(due.scheduledEnd) > Date.now())
              ) {
                const departure = new TextEncoder().encode(
                  JSON.stringify({
                    activity: 'active',
                    title: 'Departure reported',
                    ...(due.aircraft ? { aircraft: due.aircraft } : {}),
                  }),
                );
                await retainInput(
                  {
                    ledger: new LedgerClient(config.apiUrl, config.tokens[dueTenant].actor),
                    sourceId: `simulation-person-${dueTenant}`,
                  },
                  departure,
                  'application/json',
                  {
                    kind: 'flight.observation',
                    occurredAt: due.scheduledStart,
                    subject: { flightId: due.id },
                    payload: JSON.parse(new TextDecoder().decode(departure)),
                    fidelity: 'synthetic_contract',
                  },
                  `lifecycle:${due.originationKey}:departure`,
                );
              }
              const managed = telemetry?.owns(due.id),
                landingTime = landingObservationTime(due, telemetry);
              if (!landingTime) continue;
              const landingBytes = new TextEncoder().encode(
                JSON.stringify({ activity: 'landed', landingTime, title: 'Landing reported' }),
              );
              const landed = await retainInput(
                {
                  ledger: new LedgerClient(config.apiUrl, config.tokens[dueTenant].actor),
                  sourceId: `simulation-person-${dueTenant}`,
                },
                landingBytes,
                'application/json',
                {
                  kind: 'flight.observation',
                  occurredAt: landingTime,
                  subject: { flightId: due.id },
                  payload: JSON.parse(new TextDecoder().decode(landingBytes)),
                  fidelity: 'synthetic_contract',
                },
                `trickle:${due.originationKey}:landing`,
              );
              if (managed) await telemetry!.markLanding(due.id, landed.receipt.receipt.id);
            }
          }
        } catch (error) {
          paused(error);
        }
      },
      ...(telemetry ? { observations: () => telemetry.tick() } : {}),
    });
    if (telemetry && flightLimit !== undefined) {
      const completed = telemetry.recent.filter((flight) => belongsToRun(flight.route.intentId));
      if (completed.length !== flightLimit || telemetry.activeCount !== 0)
        throw new Error('Bounded continuing telemetry ended before all requested lifecycles completed');
      const directory = resolve(process.env.SIMULATOR_TELEMETRY_DIR ?? '.local/simulator/continuing-telemetry');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(
        join(directory, 'evidence-report.json'),
        JSON.stringify(
          {
            status: 'passed',
            scenario: 'continuing-dji.local.1',
            environment: 'local',
            scope: 'isolated-fictional-tenants',
            checkedAt: new Date().toISOString(),
            flights: completed.map((flight) => ({
              ...flight,
              expected: continuingExpectations(flight.route, flight.emittedIndices),
            })),
            limitations: [
              'Bounded local continuing lifecycle; not hosted enablement, aircraft validation, open-loop throughput or soak qualification.',
              'Missed source observations are counted explicitly; restart does not invent unseen historical samples.',
            ],
          },
          null,
          2,
        ) + '\n',
        { mode: 0o600 },
      );
    }
  } finally {
    try {
      await telemetry?.stop();
    } finally {
      await controlLease.release();
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.env.SIMULATOR_AUTORUN === '1') await trickle();
  else console.log('Simulator ready. Run the complete scenario, or enable SIMULATOR_AUTORUN=1 for dev-trickle.');
}
