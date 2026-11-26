import { seededDataLabel } from './labels.js';
import { demonstration } from './transport.js';

/** Where this Ledger runs, as a person is told it. */
function whereItRuns(local: boolean): string {
  return demonstration ? 'Recorded demonstration' : local ? 'Local development' : 'Private staging';
}

/**
 * What the badge beside the organization's name says: the one rule every screen uses. A seeded fictional organization
 * is a simulation, on whatever stack it runs, and says whose data it is. An organization of its own has a badge only
 * where Ledger is not running for real: on a local stack, or in the recorded demonstration. Elsewhere it has none.
 */
export function organizationBadge(tenantId: string, local: boolean): { text: string; simulation: boolean } | null {
  const data = seededDataLabel(tenantId);
  if (data) return { text: `Simulation · ${data}`, simulation: true };
  return demonstration || local ? { text: whereItRuns(local), simulation: false } : null;
}

/**
 * The badge beside the organization's name. A simulation opens to say what is simulated and where it runs; `connected`
 * shows whether the screen's own reads are current, on a screen that keeps them.
 */
export function OrganizationBadge({
  tenantId,
  local,
  connected,
}: {
  tenantId: string;
  local: boolean;
  connected?: boolean;
}) {
  const badge = organizationBadge(tenantId, local);
  if (!badge) return null;
  if (!badge.simulation) return <span className="simulation-pill">{badge.text}</span>;
  return (
    <details className="simulation">
      <summary className="simulation-pill">
        {connected !== undefined && <i className={`pulse ${connected ? '' : 'pulse--stale'}`} aria-hidden="true" />}
        {badge.text}
      </summary>
      <div className="simulation-popover">
        <h2>Simulation & limits</h2>
        <ul>
          <li>Every organization, aircraft and person is fictional.</li>
          <li>Vendor systems are emulated.</li>
          <li>Each source shows a fidelity badge for how closely it matches the real system.</li>
          <li>
            Reported activity and position freshness are shown separately. Connection alone does not confirm flight
            status.
          </li>
          <li>
            {demonstration
              ? 'A recorded demonstration: every answer is a recording.'
              : `Running in ${whereItRuns(local).toLowerCase()}.`}
          </li>
        </ul>
      </div>
    </details>
  );
}
