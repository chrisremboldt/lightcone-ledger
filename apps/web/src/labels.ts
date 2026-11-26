import type {
  Artifact,
  Fidelity,
  FlightSummary,
  OrderSummary,
  Principal,
  Receipt,
  TimelineItem,
  TimelineLane,
} from '@ledger/contracts';
import type { Tone } from '@ledger/ui';
import { age, byteSize, counted, ctDay, ctDayName, sentence, shortTime } from './format.js';
import { seededOrganization } from './demo/fictional-organizations.js';

export type DisplayLane = TimelineLane;

export const lanes: { key: DisplayLane; label: string; description: string }[] = [
  { key: 'plan', label: 'Plan', description: 'Orders and authorization' },
  { key: 'observed', label: 'Flight', description: 'What was reported' },
  { key: 'evidence', label: 'Evidence', description: 'Retained inputs and corrections' },
  { key: 'checks', label: 'Checks', description: 'Recorded evaluations' },
  { key: 'decisions', label: 'Decisions', description: 'Who decided what' },
];

export function displayLane(item: TimelineItem): DisplayLane {
  return item.lane;
}

export { operators, seededDataLabel, seededOrganization } from './demo/fictional-organizations.js';

/** A seeded fictional organization keeps its display name; any other shows the name it was created with. */
export function organizationLabel(tenantId: string, name?: string | null) {
  return seededOrganization(tenantId)?.name ?? (name?.trim() || 'Your organization');
}

const kinds: Record<string, string> = {
  'order.revision': 'Order',
  'intent.revision': 'Flight intent',
  'flight.created': 'Flight created',
  'flight.observation': 'Flight report',
  'airspace.status': 'Authorization',
  'source.observation': 'Source exchange',
  'telemetry.segment': 'Telemetry',
  'evidence.correct': 'Correction',
  'identity.link': 'Linked',
  'decision.record': 'Decision',
  'evaluation.recorded': 'Evaluation',
  'mission.release': 'Mission route release',
  'mission.departure-authorize': 'Departure authorization',
  'mission.brief': 'Mission briefing',
  'mission.briefing-acknowledge': 'Briefing acknowledgement',
  observation: 'Observation',
  'observation.withdraw': 'Observation withdrawn',
  'observation.resolve-subject': 'Observation subject resolved',
  'subject.alias': 'Subject alias',
  'mission.revision': 'Mission revision',
  'monitoring.window': 'Monitoring window',
  'command-link.status': 'Command link status',
  'command-link.baseline': 'Command link baseline',
  'rule-pack.adopt': 'Rule pack adoption',
  'authority.update': 'Authority change',
  'person.add': 'Person added',
  'credential.issue': 'Credential issued',
  'credential.revoke': 'Credential revoked',
  'development-token.issue': 'Development token issued',
};

export function kindLabel(kind: string) {
  return kinds[kind] ?? sentence(kind);
}

const kindPlurals: Record<string, string> = {
  'source.observation': 'exchanges',
  'flight.observation': 'reports',
  'airspace.status': 'authorization updates',
  'telemetry.segment': 'telemetry segments',
  'order.revision': 'order revisions',
  'evaluation.recorded': 'evaluations',
};

const sources: Record<string, string> = {
  'partner-orders': 'Partner orders',
  'airspace-link': 'Airspace Link',
  'dji-osd': 'DJI telemetry',
  'aircraft-live': 'Aircraft live feed',
  'postflight-log': 'Post-flight log',
  'aircraft-pre-dispatch': 'Pre-dispatch check',
};

const roles: Record<string, string> = {
  source: 'Integration',
  actor: 'Field crew',
  operator: 'Dispatcher',
  worker: 'Ledger worker',
  safety: 'Safety manager',
  executive: 'Accountable executive',
  pilot: 'Pilot',
};

export function sourceLabel(sourceId?: string) {
  if (!sourceId) return 'Ledger';
  if (sources[sourceId]) return sources[sourceId];
  if (sourceId.startsWith('simulation-person-')) return 'Crew report';
  if (sourceId.startsWith('browser-')) return 'Test source';
  return sentence(sourceId.replaceAll('-', ' '));
}

export function groupLabel(item: TimelineItem, count: number) {
  return `${count} ${sourceLabel(item.sourceId)} ${kindPlurals[item.kind] ?? 'records'}`;
}

export function roleLabel(actorId: string) {
  const role = /^principal-[a-z0-9]+-([a-z]+)$/.exec(actorId)?.[1];
  return (role && roles[role]) || 'Team member';
}

export function actorLabel(actorId: string, principal?: Principal | null) {
  if (principal && actorId === principal.id) return principal.name;
  return roleLabel(actorId);
}

export function itemSource(item: TimelineItem, principal?: Principal | null) {
  if (item.kind === 'evaluation.recorded') return 'Ledger evaluator';
  const retainedName = retainedActionActorName(item);
  if (retainedName) return retainedName;
  return item.sourceId ? sourceLabel(item.sourceId) : actorLabel(item.actorId, principal);
}

function retainedActionActorName(item: TimelineItem): string | null {
  const decision = item.payload.decision;
  const isEffectivenessReview =
    item.kind === 'decision.record' &&
    decision &&
    typeof decision === 'object' &&
    !Array.isArray(decision) &&
    'kind' in decision &&
    decision.kind === 'control.effectiveness-review';
  if (
    !['mission.release', 'mission.departure-authorize', 'mission.brief', 'mission.briefing-acknowledge'].includes(
      item.kind,
    ) &&
    !isEffectivenessReview
  )
    return null;
  const acceptance = item.payload.acceptance;
  if (!acceptance || typeof acceptance !== 'object' || Array.isArray(acceptance)) return null;
  if (isEffectivenessReview && (!('version' in acceptance) || acceptance.version !== 'hazard.effectiveness-review.2'))
    return null;
  const record = item.kind === 'mission.departure-authorize' && 'permit' in acceptance ? acceptance.permit : acceptance;
  if (!record || typeof record !== 'object' || Array.isArray(record) || !('actor' in record)) return null;
  const actor = record.actor;
  return actor &&
    typeof actor === 'object' &&
    !Array.isArray(actor) &&
    'id' in actor &&
    actor.id === item.actorId &&
    'name' in actor &&
    typeof actor.name === 'string' &&
    actor.name.trim()
    ? actor.name
    : null;
}

/**
 * An aircraft as people know it. The simulator's own ids for the seeded fictional fleets (aircraft-<fleet>-<n>,
 * DJI-<FLEET>-<n>) get a short name; any other id, such as an operator's registration, is shown exactly as recorded.
 */
export function aircraftLabel(aircraft?: string) {
  if (!aircraft) return 'Aircraft unassigned';
  const match = /^aircraft-(alpha|beta)-(\d+)$/.exec(aircraft);
  if (match) return `Aircraft ${match[1]![0]!.toUpperCase()}-${match[2]}`;
  const dock = /^DJI-(ALPHA|BETA)-(\d+)$/.exec(aircraft);
  return dock ? `DJI dock aircraft ${dock[1]![0]}-${dock[2]}` : aircraft;
}

export const activity: Record<FlightSummary['activity'], { label: string; tone: Tone }> = {
  unknown: { label: 'No reports', tone: 'neutral' },
  planned: { label: 'Planned', tone: 'planned' },
  active: { label: 'In the air', tone: 'observed' },
  landed: { label: 'Landed', tone: 'neutral' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

export const coverage: Record<FlightSummary['coverage'], { label: string; tone: Tone }> = {
  unknown: { label: 'No evidence yet', tone: 'neutral' },
  partial: { label: 'Partial record', tone: 'neutral' },
  conflicting: { label: 'Reports disagree', tone: 'attention' },
  recorded: { label: 'Complete record', tone: 'observed' },
};

export const fidelity: Record<Fidelity, { label: string; description: string; tone: Tone }> = {
  synthetic_contract: {
    label: 'Simulated',
    description: 'A fictional source following Ledger’s own contract.',
    tone: 'neutral',
  },
  documented_schema_conformant: {
    label: 'Published schema',
    description: 'Emulated against the vendor’s published schema; not yet checked against their sandbox.',
    tone: 'planned',
  },
  captured_source_replay: {
    label: 'Replayed capture',
    description: 'Real captured bytes replayed through the adapter.',
    tone: 'planned',
  },
  validated_sandbox: {
    label: 'Vendor sandbox',
    description: 'Validated against the vendor sandbox.',
    tone: 'observed',
  },
  validated_live: { label: 'Live source', description: 'Validated against the live source.', tone: 'observed' },
};

export const linkStatus: Record<TimelineItem['linkStatus'], { label: string; tone: Tone }> = {
  unresolved: { label: 'Unlinked', tone: 'attention' },
  candidate: { label: 'Possible match', tone: 'attention' },
  linked: { label: 'Linked', tone: 'neutral' },
};

export const processing: Record<Receipt['processing']['status'], string> = {
  pending: 'Waiting',
  processing: 'Processing',
  completed: 'Completed',
  failed: 'Failed',
};

const orderStatuses: Record<string, { label: string; tone: Tone }> = {
  accepted: { label: 'Accepted', tone: 'neutral' },
  received: { label: 'Received', tone: 'neutral' },
  cancelled: { label: 'Cancelled', tone: 'attention' },
};

export function orderStatus(status: string) {
  return orderStatuses[status] ?? { label: sentence(status), tone: 'neutral' as Tone };
}

const contentTypes: Record<string, string> = {
  'application/json': 'JSON',
  'text/csv': 'CSV',
  'text/plain': 'text',
  'application/octet-stream': 'binary',
};

function contentTypeLabel(contentType: string) {
  return contentTypes[contentType.split(';')[0]!.trim()] ?? contentType;
}

export function retainedLabel(artifact: Artifact | null, hasArtifact: boolean, item: TimelineItem | null) {
  if (artifact)
    return `Original bytes kept · ${byteSize(artifact.byteLength)} ${contentTypeLabel(artifact.contentType)}`;
  if (hasArtifact) return 'Original bytes kept';
  return item?.lane === 'decisions' ? 'The decision and the inputs it saw' : 'Recorded values';
}

const decisions: Record<string, string> = {
  acknowledge: 'Took responsibility',
  respond: 'Recorded the response',
  resolve: 'Marked resolved',
  hold: 'Held the flight',
  proceed: 'Continued the flight',
  cancel: 'Cancelled the flight',
  reviewed: 'Reviewed the map',
  'control.effectiveness-review': 'Control effectiveness reviewed',
  'simulation.dispatch-note': 'Dispatch note',
};

export function decisionLabel(kind: string): string {
  if (kind.startsWith('finding.')) return decisionLabel(kind.slice('finding.'.length));
  return decisions[kind] ?? sentence(kind);
}

export function recordTitle(item: TimelineItem) {
  const status = typeof item.payload.status === 'string' ? item.payload.status : null;
  if (item.kind === 'airspace.status' && status)
    return `Authorization ${sentence(status.replace(/^STATUS_/, '').toLowerCase())}`;
  if (item.kind === 'flight.observation') {
    const reported = item.payload.activity;
    if (reported === 'active') return 'Departure reported';
    if (reported === 'landed') return 'Landing reported';
    if (reported === 'planned') return 'Flight planned';
    if (reported === 'cancelled') return 'Cancellation reported';
  }
  if (item.kind === 'order.revision') {
    const revision = typeof item.payload.revision === 'number' ? ` revision ${item.payload.revision}` : '';
    return `Order${revision} ${typeof item.payload.status === 'string' ? item.payload.status : 'received'}`;
  }
  if (item.kind === 'flight.created')
    return Array.isArray(item.payload.orderRefs) && item.payload.orderRefs.length
      ? 'Flight created from order'
      : 'Flight created';
  if (item.kind === 'identity.link') return 'Evidence linked to this flight';
  if (item.kind === 'source.observation') return 'API exchange';
  if (item.kind === 'telemetry.segment') return 'Telemetry segment';
  if (item.kind === 'evidence.correct') return 'Correction appended';
  if (item.kind === 'decision.record') {
    const decision = item.payload.decision as { kind?: string } | undefined;
    return decision?.kind ? decisionLabel(decision.kind) : 'Decision recorded';
  }
  return item.title;
}

export function decisionNote(item: TimelineItem) {
  const decision = item.payload.decision as { note?: unknown } | undefined;
  return typeof decision?.note === 'string' ? decision.note : null;
}

const exchangeResources: Record<string, string> = {
  operations: 'Operation',
  laanc: 'LAANC filing',
  authorizations: 'Authorization',
};

function exchangeLabel(payload: Record<string, unknown>) {
  const path = typeof payload.path === 'string' ? payload.path : '';
  const resource = path
    .split('/')
    .filter((part) => part && !/^v\d+$/.test(part) && !/^[0-9a-f-]{16,}$/i.test(part))
    .at(-1);
  const direction = payload.direction === 'inbound' ? 'response' : 'request';
  return resource ? `${exchangeResources[resource] ?? sentence(resource)} ${direction}` : null;
}

const details: Record<string, (payload: Record<string, unknown>) => string | null> = {
  'evaluation.recorded': (payload) => (typeof payload.summary === 'string' ? payload.summary : null),
  'airspace.status': (payload) => {
    const altitude = (payload.callback as { altitude?: unknown } | undefined)?.altitude;
    return typeof altitude === 'number' ? `LAANC · ${altitude} ft ceiling` : null;
  },
  'order.revision': (payload) => (typeof payload.label === 'string' ? payload.label : null),
  'source.observation': exchangeLabel,
  'telemetry.segment': (payload) =>
    typeof payload.sampleCount === 'number'
      ? `${payload.sampleCount} position sample${payload.sampleCount === 1 ? '' : 's'}`
      : null,
  'flight.observation': (payload) => {
    if (typeof payload.landingTime === 'string') return `Touchdown at ${shortTime(payload.landingTime)}`;
    return typeof payload.aircraft === 'string' ? aircraftLabel(payload.aircraft) : null;
  },
  'identity.link': () => 'Matched an unlinked input to this flight',
};

export function itemDetail(item: TimelineItem) {
  if (item.correctionOf) return 'Correction · original kept';
  return details[item.kind]?.(item.payload) ?? null;
}

function receiptDelay(item: TimelineItem) {
  const seconds = (Date.parse(item.receivedAt) - Date.parse(item.occurredAt)) / 1000;
  if (!Number.isFinite(seconds) || seconds < 120) return null;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 86400)} days`;
}

export function lateness(item: TimelineItem) {
  const delay = receiptDelay(item);
  return delay ? `${delay} late` : null;
}

export function receivedAfter(item: TimelineItem) {
  const delay = receiptDelay(item);
  return delay ? `Received ${delay} after it happened` : null;
}

export function relativeDay(value: string, now = Date.now()) {
  const day = ctDay(value);
  const today = ctDay(now);
  const yesterday = new Date(Date.parse(`${today}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  if (day === today) return 'Today';
  if (day === yesterday) return 'Yesterday';
  return null;
}

export function dayLabel(value: string, now = Date.now()) {
  const relative = relativeDay(value, now);
  return relative ? `${relative} · ${ctDayName(value)}` : ctDayName(value);
}

export function flightWindow(flight: FlightSummary, now = Date.now()) {
  if (!flight.scheduledStart) {
    if (!flight.scheduledEnd) return null;
    return `By ${ctDayName(flight.scheduledEnd)} ${shortTime(flight.scheduledEnd)}`;
  }
  const day = relativeDay(flight.scheduledStart, now);
  const prefix = day === 'Today' ? '' : `${day ?? ctDayName(flight.scheduledStart)} `;
  const end = flight.scheduledEnd;
  const endDay = end && ctDay(flight.scheduledStart) !== ctDay(end) ? `${ctDayName(end)} ` : '';
  return `${prefix}${shortTime(flight.scheduledStart)}${end ? `–${endDay}${shortTime(end)}` : ' onward'}`;
}

export function reportedFlightTimes(items: TimelineItem[], flight: FlightSummary) {
  const current = effectiveItems(items, flight.id);
  const landings = current.flatMap((item) => {
    if (item.kind !== 'flight.observation' && item.kind !== 'evidence.correct') return [];
    const values = [item.payload.landingTime, item.payload.landedAt].filter(
      (value): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)),
    );
    if (!values.length && isLanding(item)) values.push(item.occurredAt);
    return values.filter((value) => Number.isFinite(Date.parse(value))).map((value) => new Date(value).toISOString());
  });
  return {
    departedAt: flight.picture?.departedAt ?? departure(current)?.occurredAt,
    landings: [...new Set(landings)].sort(),
  };
}

export function orderSummary(flight: FlightSummary, orders: OrderSummary[]) {
  const [order] = orders;
  if (orders.length === 1 && order)
    return order.flightIds.length > 1
      ? `Order ${order.externalId} · ${order.flightIds.length} flights`
      : `Order ${order.externalId}`;
  return counted(flight.orderIds.length, 'order');
}

export type RosterGroup = 'attention' | 'airborne' | 'scheduled' | 'done';

export const rosterGroups: { key: RosterGroup; label: string; implies?: FlightSummary['activity'] }[] = [
  { key: 'attention', label: 'Needs attention' },
  { key: 'airborne', label: 'Airborne reports', implies: 'active' },
  { key: 'scheduled', label: 'Plans', implies: 'planned' },
  { key: 'done', label: 'Completed' },
];

const overdueGraceMs = 15 * 60_000;
export const currentPictureMs = 90_000;

export function activityPresentation(flight: FlightSummary, now = Date.now()) {
  let observedAt =
    flight.picture?.lastPosition?.occurredAt ??
    (flight.activity === 'active' ? flight.picture?.departedAt : flight.lastOccurredAt);
  if (flight.operation) {
    const { activityReport, positionOccurredAt, asOf } = flight.operation;
    const cutoff = Math.min(now, Date.parse(asOf));
    observedAt = [
      activityReport?.activity === flight.activity ? activityReport.occurredAt : undefined,
      flight.activity === 'active' ? positionOccurredAt : undefined,
    ]
      .filter((value): value is string => typeof value === 'string' && Date.parse(value) <= cutoff)
      .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
  }
  const observedAge = observedAt ? now - Date.parse(observedAt) : Infinity;
  const current = observedAge >= 0 && observedAge <= currentPictureMs;
  if (flight.activity !== 'active') return { ...activity[flight.activity], current, observedAt, detail: null };
  return {
    label: current ? 'Reported airborne' : 'Last reported airborne',
    tone: current ? ('observed' as const) : ('neutral' as const),
    current,
    observedAt,
    detail: current ? null : 'Current status is unconfirmed; this is the last reported activity.',
  };
}

const authorizationWords: Record<NonNullable<FlightSummary['picture']>['authorization'] & string, string> = {
  denied: 'denied',
  rescinded: 'rescinded',
  revoked: 'revoked',
};

function factTimes(flight: FlightSummary, now: number) {
  const picture = flight.picture;
  const times: string[] = [];
  if (picture?.authorization) times.push(picture.authorizationReceivedAt ?? picture.authorizationAt ?? '');
  if (flight.activity === 'active' && picture?.cancelledOrderAt)
    times.push(picture.cancelledOrderReceivedAt ?? picture.cancelledOrderAt);
  if (flight.conflictCount > 0 && picture?.conflictReceivedAt) times.push(picture.conflictReceivedAt);
  if (flight.unresolvedCount > 0 && picture?.unresolvedReceivedAt) times.push(picture.unresolvedReceivedAt);
  if (
    !flight.operation &&
    flight.activity === 'active' &&
    flight.scheduledEnd &&
    now - Date.parse(flight.scheduledEnd) > overdueGraceMs
  )
    times.push(flight.scheduledEnd);
  return times.filter((value) => Number.isFinite(Date.parse(value)));
}

export function attentionReasons(flight: FlightSummary, now = Date.now()) {
  const reasons: string[] = [];
  if (flight.findingSummary?.openCount)
    reasons.push(flight.findingSummary.latestTitle ?? `${flight.findingSummary.openCount} open findings`);
  const picture = flight.picture;
  if (picture?.authorization) {
    const word = authorizationWords[picture.authorization];
    const afterDeparture = Boolean(
      picture.departedAt && picture.authorizationAt && picture.authorizationAt > picture.departedAt,
    );
    reasons.push(
      !picture.departedAt
        ? `Authorization ${word}`
        : afterDeparture
          ? `Authorization ${word} after departure`
          : `Departed after authorization was ${word}`,
    );
  }
  if (flight.activity === 'active' && picture?.cancelledOrderAt) reasons.push('Order cancelled after departure');
  if (!flight.findingSummary && flight.conflictCount > 0)
    reasons.push(`${flight.conflictCount} conflicting report${flight.conflictCount === 1 ? '' : 's'}`);
  if (flight.unresolvedCount > 0)
    reasons.push(`${flight.unresolvedCount} unlinked input${flight.unresolvedCount === 1 ? '' : 's'}`);
  if (
    !flight.findingSummary &&
    !flight.operation &&
    flight.activity === 'active' &&
    flight.scheduledEnd &&
    now - Date.parse(flight.scheduledEnd) > overdueGraceMs
  )
    reasons.push('No landing reported');
  return reasons;
}

export function attentionOwner(flight: FlightSummary, now = Date.now()) {
  if (flight.findingSummary?.openCount) return null;
  const decision = flight.picture?.latestDecision;
  if (!decision) return null;
  if (decision.kind.startsWith('finding.')) return null;
  const known = factTimes(flight, now).sort().at(-1);
  if (known && decision.recordedAt < known) return null;
  return decision;
}

export function ownershipLine(flight: FlightSummary, now = Date.now()) {
  if (flight.findingSummary?.openCount) {
    const count = flight.findingSummary.unownedCount;
    return count ? `${count} finding${count === 1 ? ' needs' : 's need'} an owner` : 'Finding responsibility recorded';
  }
  const owner = attentionOwner(flight, now);
  if (owner) return `${owner.actorName} · ${decisionLabel(owner.kind)}`;
  const prior = flight.picture?.latestDecision;
  if (prior?.kind.startsWith('finding.')) return 'No response to these record signals';
  if (prior) return `${prior.actorName} acted before this was known`;
  return 'Nobody has taken this';
}

export function attentionRank(flight: FlightSummary, now = Date.now()) {
  const picture = flight.picture;
  let rank = attentionOwner(flight, now) ? 0 : 50;
  if (flight.findingSummary?.openCount) rank += 60 + flight.findingSummary.unownedCount * 10;
  if (flight.activity === 'active' && picture?.authorization) rank += 40;
  if (flight.activity === 'active' && picture?.cancelledOrderAt) rank += 30;
  if (picture?.authorization) rank += 20;
  if (flight.conflictCount > 0) rank += 10;
  if (
    !flight.operation &&
    flight.activity === 'active' &&
    flight.scheduledEnd &&
    now - Date.parse(flight.scheduledEnd) > overdueGraceMs
  )
    rank += 8;
  return rank;
}

export function nextStep(flight: FlightSummary, now = Date.now()) {
  if (flight.findingSummary?.openCount) return undefined;
  const reasons = attentionReasons(flight, now);
  const owner = attentionOwner(flight, now);
  if (!reasons.length || owner?.kind === 'resolve') return undefined;
  if (!owner) return 'acknowledge' as const;
  if (owner.kind === 'acknowledge') return 'respond' as const;
  return 'resolve' as const;
}

export function preferredFlight(flights: FlightSummary[], now = Date.now()) {
  const ranked = [...flights].sort((a, b) => attentionRank(b, now) - attentionRank(a, now) || a.id.localeCompare(b.id));
  return (
    ranked.find((flight) => rosterGroup(flight, attentionReasons(flight, now), now) === 'attention') ??
    ranked.find((flight) => flight.activity === 'active') ??
    ranked[0]
  );
}

export function rosterGroup(flight: FlightSummary, reasons: string[], now = Date.now()): RosterGroup {
  if (flight.findingSummary?.openCount) return 'attention';
  if (reasons.length && attentionOwner(flight, now)?.kind !== 'resolve') return 'attention';
  if (flight.activity === 'active') return 'airborne';
  if (flight.activity === 'planned' || flight.activity === 'unknown') return 'scheduled';
  return 'done';
}

export function coveragePresentation(flight: FlightSummary): { label: string; tone: Tone; detail: string | null } {
  if (flight.coverage === 'unknown' && flight.picture?.lastPosition)
    return {
      label: 'Position samples only',
      tone: 'attention',
      detail: 'No departure or landing report. A position has been recorded.',
    };
  if (flight.coverage === 'unknown') return { label: 'No flight report yet', tone: 'neutral', detail: null };
  if (flight.coverage === 'conflicting')
    return {
      label: 'Reports disagree',
      tone: 'attention',
      detail: 'Landing times disagree. Both reports stay on the record.',
    };
  if (flight.activity === 'landed' || flight.coverage === 'recorded')
    return { label: 'Landing recorded', tone: 'observed', detail: 'A landing has been reported.' };
  if (flight.activity === 'active')
    return {
      label: 'Open record',
      tone: 'neutral',
      detail: 'Departure is recorded. A landing has not been reported.',
    };
  return { label: 'Open record', tone: 'neutral', detail: 'Some reports are in. A landing has not been reported.' };
}

export function picturePhrase(latest: string | undefined, now = Date.now()) {
  if (!latest) return { current: false, text: 'Connected · no reports yet' };
  const ageMs = now - Date.parse(latest);
  if (!Number.isFinite(ageMs)) return { current: false, text: 'Connected · no reports yet' };
  if (ageMs < 0) return { current: false, text: 'Report receipt time is ahead of this clock' };
  return { current: ageMs <= currentPictureMs, text: `Last report received ${age(latest)}` };
}

export interface Highlight {
  tone: Tone;
  text: string;
}

export function highlightHeading(highlights: Highlight[], flight?: FlightSummary): { label: string; tone: Tone } {
  if (flight?.findingSummary?.openCount) return { label: 'Other record signals', tone: 'attention' };
  if (flight && attentionOwner(flight)?.kind === 'resolve') return { label: 'Resolved', tone: 'neutral' };
  return highlights.some((highlight) => highlight.tone !== 'planned')
    ? { label: 'Needs attention', tone: 'attention' }
    : { label: 'Worth knowing', tone: 'planned' };
}

const deniedStatuses = new Set(['STATUS_RESCINDED', 'STATUS_DENIED', 'STATUS_REVOKED']);

function departure(items: TimelineItem[]) {
  return items
    .filter((item) => item.kind === 'flight.observation' && item.payload.activity === 'active')
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))[0];
}

function isLanding(item: TimelineItem) {
  return item.kind === 'flight.observation' && item.payload.activity === 'landed';
}

function landedAt(item: TimelineItem) {
  return typeof item.payload.landingTime === 'string' ? item.payload.landingTime : item.occurredAt;
}

function effectiveItems(items: TimelineItem[], flightId: string) {
  const byId = new Map<string, TimelineItem>();
  for (const item of items) {
    byId.set(item.id, item);
    byId.set(`${item.id}:${flightId}`, item);
  }
  const replaced = new Set(
    items.flatMap((item) => (item.correctionOf ? [byId.get(item.correctionOf)?.id ?? item.correctionOf] : [])),
  );
  return items
    .filter((item) => !replaced.has(item.id))
    .map((item) => {
      let original = item;
      const visited = new Set<string>();
      while (original.correctionOf && !visited.has(original.id)) {
        visited.add(original.id);
        const prior = byId.get(original.correctionOf);
        if (!prior) break;
        original = prior;
      }
      return original === item ? item : { ...item, kind: original.kind };
    });
}

export function threadHighlights(items: TimelineItem[], flight: FlightSummary): Highlight[] {
  const highlights: Highlight[] = [];
  const current = effectiveItems(items, flight.id);
  const departed = departure(current);
  const withdrawn = current.find(
    (item) => item.kind === 'airspace.status' && deniedStatuses.has(String(item.payload.status)),
  );
  if (withdrawn) {
    const status = String(withdrawn.payload.status)
      .replace(/^STATUS_/, '')
      .toLowerCase();
    const after =
      departed && withdrawn.occurredAt > departed.occurredAt
        ? `, ${Math.round((Date.parse(withdrawn.occurredAt) - Date.parse(departed.occurredAt)) / 60_000)} min after departure`
        : '';
    highlights.push({
      tone: 'alert',
      text: `Authorization ${status} at ${shortTime(withdrawn.occurredAt)}${after}`,
    });
  }
  const landings = new Map<string, TimelineItem>();
  for (const item of current) {
    if (!isLanding(item)) continue;
    if (!landings.has(landedAt(item))) landings.set(landedAt(item), item);
  }
  if (!flight.findingSummary && flight.conflictCount > 0 && landings.size > 1) {
    const claims = [...landings.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([landed, item]) => `${shortTime(landed)} (${sourceLabel(item.sourceId)})`);
    highlights.push({ tone: 'attention', text: `Landing reports disagree: ${claims.join(' vs ')}` });
  } else if (!flight.findingSummary && flight.conflictCount > 0) {
    highlights.push({ tone: 'attention', text: 'Landing reports disagree' });
  }
  const cancelled = current.find((item) => item.kind === 'order.revision' && item.payload.status === 'cancelled');
  if (cancelled && departed)
    highlights.push({
      tone: 'attention',
      text: `Order cancelled at ${shortTime(cancelled.occurredAt)} after departure`,
    });
  const late = items.filter(
    (item) => item.receiptId && Date.parse(item.receivedAt) - Date.parse(item.occurredAt) > 3600_000,
  );
  if (late.length)
    highlights.push({
      tone: 'planned',
      text: `${late.length} report${late.length === 1 ? '' : 's'} arrived more than an hour after ${late.length === 1 ? 'it' : 'they'} happened`,
    });
  return highlights;
}
