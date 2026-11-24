export interface WorldFlight {
  intentId: string;
  tenant: 'alpha' | 'beta';
  aircraftId: string;
  orderIds: string[];
  attempt: number;
  start: string;
  end: string;
}

export interface PartnerOrder {
  order_id: string;
  version: number;
  updated_at: string;
  state: 'accepted' | 'cancelled';
  schedule: { start: string; end: string };
  requested_work: { name: string };
  cancellation?: {
    reason: 'requested_window_unreachable';
    note: string;
    decidedAt: string;
    dispatcher: { id: string; name: string };
  };
  flights: Array<{ flight_intent_id: string; attempt: number; order_refs: string[]; aircraft_id: string }>;
}

export interface HiddenWorld {
  seed: number;
  version: 1;
  start: string;
  flights: WorldFlight[];
  orders: Record<'alpha' | 'beta', PartnerOrder[]>;
  expected: { alphaFlights: number; betaFlights: number; logicalIntents: string[]; cancelledOrder: string };
}

const missionNames: Record<string, string> = {
  'order-alpha-split': 'Pharmacy run · Eastside Clinic',
  'order-alpha-consolidated-a': 'Lab samples · Mercy North',
  'order-alpha-consolidated-b': 'Blood panel pickup · Mercy North',
  'order-alpha-04': 'Insulin restock · Ridge Pharmacy',
  'order-alpha-05': 'Parcel drop · Harbor Street Depot',
  'order-alpha-06': 'Defibrillator relay · Northgate Station',
  'order-alpha-07': 'Prescription delivery · Willow Court',
  'order-alpha-08': 'Vaccine cooler · Southbank Clinic',
  'order-alpha-09': 'Spare parts courier · Riverside Yard',
  'order-beta-01': 'Bridge deck survey · Route 9',
};

export function entityRandom(seed: number, entity: string): () => number {
  let state = seed >>> 0;
  for (const char of entity) state = Math.imul(state ^ char.charCodeAt(0), 16777619) >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function createWorld(seed = 71031, start = '2026-10-01T14:00:00.000Z'): HiddenWorld {
  const base = Date.parse(start);
  if (!Number.isFinite(base)) throw new Error('Scenario start must be an ISO timestamp');
  const flights: WorldFlight[] = Array.from({ length: 10 }, (_, index) => {
    const tenant = index === 9 ? ('beta' as const) : ('alpha' as const);
    const number = index === 9 ? 1 : index + 1;
    const suffix = String(number).padStart(2, '0');
    const phases = [
      { startMin: -52, airMin: 28 },
      { startMin: -7, airMin: 32 },
      { startMin: -15, airMin: 34 },
      { startMin: -80, airMin: 26 },
      { startMin: 22, airMin: 30 },
      { startMin: -3, airMin: 28 },
      { startMin: -100, airMin: 30 },
      { startMin: -48, airMin: 27 },
      { startMin: -9, airMin: 36 },
      { startMin: -5, airMin: 40 },
    ];
    const phase = phases[index]!;
    const jitter = Math.floor(entityRandom(seed, `flight-${index}`)() * 6);
    const startMs = base + phase.startMin * 60_000;
    return {
      intentId: `intent-${tenant}-${suffix}`,
      tenant,
      aircraftId: `aircraft-${tenant}-${suffix}`,
      orderIds:
        index === 0 || index === 1
          ? ['order-alpha-split']
          : index === 2
            ? ['order-alpha-consolidated-a', 'order-alpha-consolidated-b']
            : [`order-${tenant}-${suffix}`],
      attempt: 1,
      start: new Date(startMs).toISOString(),
      end: new Date(startMs + (phase.airMin + jitter) * 60_000).toISOString(),
    };
  });
  const orders: HiddenWorld['orders'] = { alpha: [], beta: [] };
  for (const tenant of ['alpha', 'beta'] as const) {
    const ids = new Set(flights.filter((flight) => flight.tenant === tenant).flatMap((flight) => flight.orderIds));
    for (const orderId of ids) {
      const name = missionNames[orderId];
      if (!name) throw new Error(`Scenario order ${orderId} has no mission name`);
      const related = flights.filter((flight) => flight.orderIds.includes(orderId));
      const earliest = Math.min(...related.map((flight) => Date.parse(flight.start)));
      orders[tenant].push({
        order_id: orderId,
        version: 1,
        updated_at: new Date(earliest - 300_000).toISOString(),
        state: 'accepted',
        schedule: { start: related[0]!.start, end: related[related.length - 1]!.end },
        requested_work: { name },
        flights: related.map((flight) => ({
          flight_intent_id: flight.intentId,
          attempt: flight.attempt,
          order_refs: flight.orderIds,
          aircraft_id: flight.aircraftId,
        })),
      });
    }
  }
  return {
    seed,
    version: 1,
    start,
    flights,
    orders,
    expected: {
      alphaFlights: 9,
      betaFlights: 1,
      logicalIntents: flights.map((flight) => flight.intentId),
      cancelledOrder: 'order-alpha-09',
    },
  };
}

export const scenarioManifest = {
  scenario: 'm0-m1-living-thread',
  scenarioVersion: 1,
  seed: 71031,
  environment: 'isolated-simulation',
  clock: { mode: 'scripted-delivery', start: '2026-10-01T14:00:00.000Z' },
  fidelity: {
    partnerOrders: 'synthetic_contract',
    airspaceSchemas: 'documented_schema_conformant',
    airspaceWebhook: 'synthetic_contract',
    userIdentityProvider: 'synthetic_contract',
  },
  cases: [
    'duplicate-order',
    'out-of-order-revision',
    'split-fulfillment',
    'consolidated-fulfillment',
    'unmatched-evidence',
    'late-conflicting-landing',
    'correction',
    'decision-cut',
    'cancelled-order',
    'vendor-denial',
    'rescission-after-departure',
    'second-tenant-unaffected',
  ],
  limitation: 'Scripted delivery exercises API semantics; it is not a realtime soak or a throughput result.',
} as const;
