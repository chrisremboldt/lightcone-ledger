import type {
  DecisionRecord,
  FlightSummary,
  OrderListResponse,
  Principal,
  SourceCapability,
  TimelineItem,
  TimelineResponse,
} from '@ledger/contracts';
import { Badge, Button, Notice } from '@ledger/ui';
import { cutSize, shortTime, time } from './format.js';
import { actorLabel, decisionLabel, fidelity, itemSource, orderStatus, recordTitle, sourceLabel } from './labels.js';

const maximumTicks = 24;

interface Props {
  data: TimelineResponse | null;
  items: TimelineItem[];
  decisions: DecisionRecord[];
  pinned: DecisionRecord | null;
  selectedId: string | null;
  principal: Principal | null;
  onSelect: (id: string) => void;
  decisionHistory: {
    olderLoaded: boolean;
    busy: boolean;
    hasOlder: boolean;
    onOlder: () => void;
    onRecent: () => void;
  };
  orders: { page: OrderListResponse | null; error: string | null; onFirst: () => void; onNext: () => void };
  flight: FlightSummary;
  capabilities: SourceCapability[];
}

export function FlightRail({
  data,
  items,
  decisions,
  pinned,
  selectedId,
  principal,
  onSelect,
  decisionHistory,
  orders,
  flight,
  capabilities,
}: Props) {
  const missionActions = items
    .filter((item) =>
      ['mission.release', 'mission.departure-authorize', 'mission.brief', 'mission.briefing-acknowledge'].includes(
        item.kind,
      ),
    )
    .sort((left, right) => right.receivedAt.localeCompare(left.receivedAt) || right.id.localeCompare(left.id));
  return (
    <>
      {pinned ? (
        <DecisionBasis
          decision={pinned}
          items={items}
          latest={pinned.id === decisions.at(-1)?.id}
          principal={principal}
          onSelect={onSelect}
        />
      ) : (
        <section className="rail-card basis-card">
          <p className="rail-label">
            <i
              className={`lane-mark lane-mark--${missionActions.length ? 'checks' : 'decisions'}`}
              aria-hidden="true"
            />
            {missionActions.length ? 'Recorded flight actions' : 'Decision basis'}
          </p>
          {missionActions.length ? (
            <div className="rail-list">
              {missionActions.slice(0, 4).map((action) => (
                <button
                  key={action.id}
                  className="rail-list-item"
                  aria-pressed={selectedId === action.id}
                  onClick={() => onSelect(action.id)}
                >
                  <strong>{recordTitle(action)}</strong>
                  <small>
                    {itemSource(action, principal)} · {time(action.receivedAt, true)}
                  </small>
                </button>
              ))}
            </div>
          ) : (
            <p className="rail-muted">
              {data ? 'No flight decision in this loaded history.' : 'Reading recorded decisions…'}
            </p>
          )}
        </section>
      )}
      {data && decisions.length > 0 && (
        <details className="decision-history">
          <summary>Decision history · {decisions.length}</summary>
          <div className="rail-list">
            {decisions.map((decision) => (
              <button
                key={decision.id}
                className="rail-list-item"
                data-testid={`decision-history-${decision.id}`}
                aria-pressed={selectedId === decision.id}
                onClick={() => onSelect(decision.id)}
              >
                <strong>{decisionLabel(decision.kind)}</strong>
                <small>
                  {actorLabel(decision.actorId, principal)} · {time(decision.recordedAt, true)}
                </small>
              </button>
            ))}
          </div>
          <div className="rail-buttons">
            {decisionHistory.olderLoaded && (
              <Button kind="quiet" onClick={decisionHistory.onRecent}>
                Recent decisions
              </Button>
            )}
            {decisionHistory.hasOlder && (
              <Button kind="quiet" disabled={decisionHistory.busy} onClick={decisionHistory.onOlder}>
                Older decisions
              </Button>
            )}
          </div>
        </details>
      )}
      <LinkedOrders {...orders} />
      <Sources flight={flight} items={items} capabilities={capabilities} />
    </>
  );
}

function ticks(viewed: number, now: number) {
  const total = Math.max(viewed, now);
  if (total <= maximumTicks) return { viewed, after: Math.max(0, now - viewed) };
  if (now <= viewed) return { viewed: maximumTicks, after: 0 };
  const after = Math.max(1, Math.round(((now - viewed) / total) * maximumTicks));
  return { viewed: maximumTicks - after, after };
}

function DecisionBasis({
  decision,
  items,
  latest,
  principal,
  onSelect,
}: {
  decision: DecisionRecord;
  items: TimelineItem[];
  latest: boolean;
  principal: Principal | null;
  onSelect: (id: string) => void;
}) {
  const known = items.filter((item) => item.id !== decision.id && item.receivedAt <= decision.recordedAt).length;
  const later = items
    .filter((item) => (item.receiptId || item.kind === 'evidence.correct') && item.receivedAt > decision.recordedAt)
    .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  const now = known + later.length;
  const bar = ticks(known, now);
  const widened = cutSize(decision.acceptedInputCut) !== cutSize(decision.renderedInputCut);
  return (
    <section className="rail-card basis-card" data-testid="decision-basis">
      <div className="rail-label">
        <span>
          <i className="lane-mark lane-mark--decisions" aria-hidden="true" />
          {latest ? 'Last decision' : 'Selected decision'}
        </span>
        <time className="mono" dateTime={decision.recordedAt}>
          {shortTime(decision.recordedAt)}
        </time>
      </div>
      <button className="basis-title" onClick={() => onSelect(decision.id)}>
        {decisionLabel(decision.kind)}
      </button>
      <blockquote>{decision.note}</blockquote>
      <p className="basis-by">
        {actorLabel(decision.actorId, principal)} · {time(decision.recordedAt, true)}
      </p>
      <div className="basis-meter">
        <div className="basis-ticks" aria-hidden="true">
          {Array.from({ length: bar.viewed }, (_, index) => (
            <i key={`viewed-${index}`} />
          ))}
          {Array.from({ length: bar.after }, (_, index) => (
            <i key={`after-${index}`} className="is-after" />
          ))}
        </div>
        <div className="basis-legend">
          <span>
            Known when decided <b>{known}</b>
          </span>
          <span>
            Now <b>{now}</b>
          </span>
        </div>
      </div>
      {widened && <p className="rail-muted">More arrived while it was being recorded. Both bases are kept.</p>}
      {later.length > 0 ? (
        <div className="basis-since">
          <span>
            <strong>{later.length} arrived after this decision.</strong> Later evidence is present; the decision keeps
            its basis.
          </span>
          <button onClick={() => onSelect(later.at(-1)!.id)}>Show</button>
        </div>
      ) : (
        <p className="rail-muted">Nothing has arrived since this decision.</p>
      )}
    </section>
  );
}

function LinkedOrders({ page, error, onFirst, onNext }: Props['orders']) {
  const orders = page?.orders ?? [];
  return (
    <section className="rail-section">
      <h3>Linked orders</h3>
      {error && (
        <Notice tone="attention" title="Orders unavailable">
          {error}
        </Notice>
      )}
      {orders.length ? (
        <div className="rail-list">
          {orders.map((order) => {
            const status = orderStatus(order.status);
            const label = typeof order.payload.label === 'string' ? order.payload.label : order.externalId;
            const legs = order.flightIds.length;
            return (
              <div key={order.id} className="rail-list-item">
                <strong>{label}</strong>
                <small>
                  {order.externalId} · revision {order.revision}
                  {legs > 1 ? ` · split across ${legs} flights` : ''}
                </small>
                <Badge tone={status.tone}>{status.label}</Badge>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="rail-muted">{page ? 'No linked orders.' : 'Reading linked orders…'}</p>
      )}
      {page && (page.page.selection === 'continuation' || page.page.nextCursor) && (
        <div className="rail-buttons">
          {page.page.selection === 'continuation' && (
            <Button kind="quiet" onClick={onFirst}>
              First linked orders
            </Button>
          )}
          {page.page.nextCursor && (
            <Button kind="quiet" onClick={onNext}>
              Next linked orders
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

function Sources({
  flight,
  items,
  capabilities,
}: {
  flight: FlightSummary;
  items: TimelineItem[];
  capabilities: SourceCapability[];
}) {
  return (
    <section className="rail-section">
      <h3>Sources on this flight</h3>
      <div className="rail-list">
        {flight.sourceIds.map((sourceId) => {
          const declared = capabilities.filter((capability) => capability.sourceId === sourceId);
          const levels = [...new Set(declared.map((capability) => capability.fidelity))];
          const limitations = [...new Set(declared.flatMap((capability) => capability.limitations))];
          const count = items.filter((item) => item.sourceId === sourceId).length;
          return (
            <div key={sourceId} className="rail-list-item source-item">
              <strong>{sourceLabel(sourceId)}</strong>
              <small>
                {count} input{count === 1 ? '' : 's'}
              </small>
              <span className="source-badges">
                {levels.map((level) => (
                  <Badge key={level} tone={fidelity[level].tone} title={fidelity[level].description}>
                    {fidelity[level].label}
                  </Badge>
                ))}
              </span>
              {limitations.length > 0 && (
                <details className="source-limits">
                  <summary>Limits</summary>
                  <ul>
                    {limitations.map((limitation) => (
                      <li key={limitation}>{limitation}</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
