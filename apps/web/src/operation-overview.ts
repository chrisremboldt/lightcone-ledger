import type { FlightSummary } from '@ledger/contracts';
import { activityPresentation } from './labels.js';
import type { OperationView } from './operation-display.js';

const labels = {
  airborne: 'Recent airborne reports',
  planned: 'Planned work',
  planning: 'Needs planning or source review',
  disposition: 'Plans needing disposition',
  outcome: 'Flight outcomes unconfirmed',
  mission: 'Mission plans unconfirmed',
  findings: 'Flights with open findings',
  signals: 'Other unresolved record signals',
  landed: 'Landing recorded',
  cancelled: 'Cancellation recorded',
  other: 'Other records shown',
};

type Category = keyof typeof labels;
const categories: Record<OperationView, Category[]> = {
  monitor: ['airborne', 'planned', 'planning', 'other'],
  overdue: ['disposition', 'outcome', 'mission', 'other'],
  'historical-issues': ['findings', 'signals', 'other'],
  history: ['landed', 'cancelled', 'other'],
};

export interface OperationOverviewRow {
  key: string;
  label: string;
  count: number;
}

function category(flight: FlightSummary, view: OperationView): Category {
  const operation = flight.operation;
  if (!operation || operation.scope !== (view === 'monitor' ? 'current' : view)) return 'other';
  const terminal = flight.activity === 'landed' || flight.activity === 'cancelled';
  if (view === 'historical-issues') {
    if (!terminal || operation.reason !== 'terminal-issues') return 'other';
    return flight.findingSummary?.openCount ? 'findings' : 'signals';
  }
  if (view === 'history') {
    if (!terminal || operation.reason !== 'terminal') return 'other';
    return flight.activity === 'landed' ? 'landed' : 'cancelled';
  }
  if (terminal) return 'other';
  if (view === 'overdue') {
    if (operation.reason === 'window-elapsed' && flight.activity !== 'active') return 'disposition';
    if (operation.reason === 'status-unconfirmed' && flight.activity === 'active') return 'outcome';
    return operation.reason === 'plan-unconfirmed' ? 'mission' : 'other';
  }
  if (
    operation.reason === 'reported-active' &&
    flight.activity === 'active' &&
    activityPresentation(flight, Date.parse(operation.asOf)).current
  )
    return 'airborne';
  if (operation.reason === 'plan-window') return 'planned';
  if (operation.reason === 'needs-planning' || operation.reason === 'plan-unconfirmed') return 'planning';
  return 'other';
}

export function operationOverview(flights: readonly FlightSummary[], view: OperationView): OperationOverviewRow[] {
  const counts = new Map<Category, number>();
  for (const flight of flights) {
    const key = category(flight, view);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return categories[view].flatMap((key) => {
    const count = counts.get(key) ?? 0;
    return count ? [{ key, label: labels[key], count }] : [];
  });
}
