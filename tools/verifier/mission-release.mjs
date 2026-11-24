import { canonicalDigest, canonicalize, requireValue } from './integrity.mjs';

export const MISSION_RELEASE_KIND = 'mission.release';
export const MISSION_RELEASE_LIMITATION =
  'Recorded mission releases are checked against their retained commitments: the registered policy, the command they answer, the mission, avoidance-context and preview digests, the departure window, the findings list digest and each listed finding’s pinned evaluation in this inventory. Each considered control’s applicability record is checked for its shape and digest, its mission and control, and a rule pinned here by digest, and each control that does not apply for a title and an area of the recorded shape; the format does not replay the rule or the geometry. This format does not establish current release validity, departure authorization or geometry replay; it cannot show that every considered control was read, that a findings list was complete, that a listed finding was still open when the release was recorded, or that the mission snapshot matches its mission revision event.';

// The registered release policy, pinned by digest. The digest commits every field but the digest.
const avoidanceInstruction =
  'At acceptance, record route-avoidance release for the exact assigned aircraft and accepted and projected mission revision using the complete outside and current avoidance context. Every accepted area control overlapping the mission interval is considered and evaluated by the applicability rule its type declares; only the controls that apply must be outside, and each that does not is recorded with what was measured, the rule that decided it and its inputs by digest. The departure window lies within the mission interval. Current validity is as-of information; final authorization after allocation issues a separate finite lease. This release alone does not permit entering flight.';
const POLICY = {
  definition: {
    id: 'ledger.demo.route-avoidance-release',
    version: 2,
    title: 'Recorded route avoidance release with open findings and control applicability',
    status: 'draft',
    scope: 'recorded_route_avoidance',
    clock: 'wall',
    mission: 'exact_accepted_and_projected_revision',
    aircraft: 'exact_current_assignment',
    avoidance: 'applicable_outside_complete_current',
    applicability: 'considered_controls_recorded',
    window: 'finite_half_open_subset_of_mission',
    comparison: 'mission_aircraft_policy_and_safety_context',
    validity: 'as_of_read_only',
    departure: 'separate_authorization_after_allocation',
    findings: 'open_active_findings_listed_and_attested',
    instruction: `${avoidanceInstruction} The release also lists the open findings from rules adopted in active mode about the flight, its organization and the subjects its records name, each with its rule, current answer and pinned evaluation, and pins that list by digest. The person releasing attests having seen them; a listed finding is not a verdict and blocks nothing. Findings from rules adopted in shadow mode are shown beside the list, recorded and not counted.`,
  },
  digest: '158378d5b0e92e042d9b122ad1c6e7d815104eaa35707c98c4377a9e5fb2e7b1',
  recordVersion: 'flight.mission-release.2',
};
if (canonicalDigest(POLICY.definition) !== POLICY.digest)
  throw new Error('Pinned mission release policy does not match its digest');

// The applicability rules a control that does not apply may be decided by, pinned by digest.
const APPLICABILITY_RULES = [
  {
    id: 'ledger.control-applicability.area-reach',
    version: 1,
    digest: '4667a798dbaac5e9e22960c29b909906616a56b1ac1f12fdd7214633147d9f62',
  },
];
const CANDIDATE_LIMIT = 64;
const CONSIDERED_LIMIT = 512;
const APPLICABILITY_BASES = ['rule', 'no_rule', 'inputs_incomplete', 'undetermined', 'error', 'under_review'];

const EVALUATION_KIND = 'rule-evaluation.recorded';
const FINDING_STATUSES = ['open', 'acknowledged', 'responding'];
const SUBJECT_KINDS = ['flight', 'aircraft', 'person', 'site', 'organization', 'component'];
const object = (value) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
const text = (value) => typeof value === 'string' && value.length > 0;
const utc = (value) => {
  if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d{1,3})?Z$/.test(value))
    return NaN;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 19) === value.slice(0, 19) ? time : NaN;
};
const order = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

function subjectKey(subject) {
  const id = encodeURIComponent(subject.id);
  return subject.scope === 'ledger'
    ? `ledger/${subject.kind}/${id}`
    : `source/${encodeURIComponent(subject.sourceId)}/${subject.kind}/${id}`;
}

function findingId(tenantId, key, packId, leafId, relatedKey) {
  return relatedKey
    ? `finding:${canonicalDigest({ tenant: tenantId, subjectKey: key, packId, leafId, relatedKey, scope: 'related' })}`
    : `finding:${canonicalDigest({ tenant: tenantId, subjectKey: key, packId, leafId, scope: 'subject' })}`;
}

/**
 * Checks one recorded mission release against its own commitments and, under policy version 2, each listed
 * finding's evaluation in the inventory. Throws a BundleVerificationError on the first inconsistency.
 */
export function verifyMissionReleaseEvent(record, events, streams, tenantId) {
  const { envelope, path } = record;
  const check = (condition, message, code = 'mission_release_commitment') =>
    requireValue(condition, code, path, message);
  const same = (left, right) => canonicalize(left) === canonicalize(right);
  const keys = (value, required, optional = []) =>
    check(
      object(value) &&
        required.every((key) => Object.hasOwn(value, key)) &&
        Object.keys(value).every((key) => required.includes(key) || optional.includes(key)),
      'Mission release fields do not match a registered release version',
      'mission_release_shape',
    );

  const payload = envelope.payload;
  keys(
    payload,
    [
      'kind',
      'flightId',
      'aircraftId',
      'mission',
      'calculation',
      'policy',
      'expectedContextDigest',
      'expectedPrincipalRevision',
      'departureWindow',
      'note',
      'acceptance',
      'declaredSubjects',
    ],
    ['expectedFindingsDigest'],
  );
  const { acceptance, declaredSubjects, ...command } = payload;
  keys(acceptance, [
    'version',
    'flightId',
    'organizationId',
    'aircraftId',
    'actor',
    'policy',
    'departureWindow',
    'note',
    'basis',
  ]);
  check(
    acceptance.policy?.version === POLICY.definition.version,
    'Mission release names an unregistered policy version',
    'mission_release_policy',
  );
  const { digest: policyDigest, ...policy } = acceptance.policy;
  check(
    acceptance.version === POLICY.recordVersion && policyDigest === POLICY.digest && same(policy, POLICY.definition),
    'Mission release policy differs from the registered policy',
    'mission_release_policy',
  );
  const basis = acceptance.basis;
  keys(basis, [
    'mission',
    'avoidance',
    'candidateContexts',
    'notApplicableContexts',
    'renderedInputCut',
    'acceptedInputCut',
    'basisManifest',
    'findings',
  ]);
  const { mission, avoidance: compared, candidateContexts, notApplicableContexts } = basis;
  check(
    object(mission) &&
      object(compared) &&
      Array.isArray(candidateContexts) &&
      Array.isArray(notApplicableContexts) &&
      Array.isArray(compared.notApplicable) &&
      Array.isArray(compared.consideredTypes),
    'Mission release basis is malformed',
  );

  // The command the release answers, and the envelope that recorded it.
  const stream = streams.get(envelope.streamId)?.stream;
  check(
    command.kind === MISSION_RELEASE_KIND &&
      acceptance.organizationId === `organization:${tenantId}` &&
      text(acceptance.flightId) &&
      stream?.name === `flight:${acceptance.flightId}` &&
      object(acceptance.actor) &&
      envelope.principalId === acceptance.actor.id &&
      same(declaredSubjects, [acceptance.flightId]),
    'Mission release differs from its recording envelope',
  );
  const expected = {
    kind: MISSION_RELEASE_KIND,
    flightId: acceptance.flightId,
    aircraftId: acceptance.aircraftId,
    mission: compared.mission,
    calculation: {
      id: compared.calculation?.id,
      version: compared.calculation?.version,
      digest: compared.calculation?.digest,
    },
    policy: { id: acceptance.policy.id, version: acceptance.policy.version, digest: policyDigest },
    expectedContextDigest: compared.contextDigest,
    expectedFindingsDigest: basis.findings?.digest,
    expectedPrincipalRevision: acceptance.actor.principalRevision,
    departureWindow: acceptance.departureWindow,
    note: acceptance.note,
  };
  check(same(command, expected), 'Mission release command differs from the release it recorded');

  // The mission snapshot and the compared avoidance context reproduce their digests.
  check(
    object(compared.mission) &&
      compared.mission.recordDigest === canonicalDigest(mission) &&
      compared.mission.eventId === mission.id &&
      compared.mission.missionId === mission.missionId &&
      compared.mission.sourceRevision === mission.sourceRevision &&
      compared.mission.contentDigest === mission.contentDigest &&
      mission.flightId === acceptance.flightId &&
      mission.aircraftId === acceptance.aircraftId,
    'Mission release mission snapshot differs from its compared mission',
  );
  const completeness = compared.candidateCompleteness;
  check(
    compared.status === 'outside' &&
      Array.isArray(compared.candidates) &&
      candidateContexts.length === compared.candidates.length &&
      notApplicableContexts.length === compared.notApplicable.length &&
      object(completeness) &&
      completeness.status === 'complete' &&
      completeness.limit === CANDIDATE_LIMIT &&
      completeness.consideredLimit === CONSIDERED_LIMIT &&
      completeness.count === compared.candidates.length &&
      completeness.count <= CANDIDATE_LIMIT &&
      completeness.considered === compared.candidates.length + compared.notApplicable.length &&
      completeness.considered <= CONSIDERED_LIMIT,
    'Mission release avoidance is not a complete outside comparison',
  );
  check(
    compared.contextDigest ===
      canonicalDigest({
        version: 'mission.avoidance-context.1',
        mission: compared.mission,
        calculation: expected.calculation,
        candidates: compared.candidates,
        notApplicable: compared.notApplicable,
        consideredTypes: compared.consideredTypes,
        candidateCompleteness: compared.candidateCompleteness,
      }),
    'Mission release context digest does not reproduce',
  );
  const { previewDigest, ...preview } = compared;
  check(previewDigest === canonicalDigest(preview), 'Mission release preview digest does not reproduce');
  const preimages = (entries, contexts) => {
    for (const entry of entries) {
      const matching = contexts.filter(
        (context) =>
          object(context) &&
          context.controlEventId === entry?.controlEventId &&
          context.acceptanceId === entry?.acceptance?.id,
      );
      check(
        matching.length === 1 && canonicalDigest(matching[0].context) === entry.safetyContextDigest,
        'Mission release candidate safety context does not reproduce its digest',
      );
    }
  };
  preimages(compared.candidates, candidateContexts);
  preimages(compared.notApplicable, notApplicableContexts);
  for (const candidate of compared.candidates) verifyApplicability(candidate, compared.mission, 'applies', path);
  for (const entry of compared.notApplicable) {
    check(placedEntry(entry), 'Mission release not-applicable entry has no title or a malformed area');
    verifyApplicability(entry, compared.mission, 'does_not_apply', path);
  }
  const window = acceptance.departureWindow;
  const recordedAt = utc(envelope.receivedAt);
  check(
    object(window) &&
      object(mission.operatingInterval) &&
      utc(window.start) < utc(window.end) &&
      utc(window.start) >= utc(mission.operatingInterval.start) &&
      utc(window.end) <= utc(mission.operatingInterval.end) &&
      recordedAt < utc(window.end),
    'Mission release departure window is outside its mission or ended before acceptance',
  );
  return { findings: verifyFindings(basis.findings, acceptance, envelope, events, tenantId, check) };
}

const measures = (value) =>
  Array.isArray(value) &&
  value.length <= 16 &&
  value.every(
    (measure) =>
      object(measure) &&
      Object.keys(measure).every((key) => ['name', 'value', 'unit'].includes(key)) &&
      typeof measure.name === 'string' &&
      /^[a-z][A-Za-z0-9]{0,63}$/.test(measure.name) &&
      ((typeof measure.value === 'number' && Number.isFinite(measure.value)) || typeof measure.value === 'string'),
  );
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
/** A not-applicable entry's title, and the area its type describes or null: a screen lists and places it from these. */
const placedEntry = (entry) =>
  object(entry) &&
  text(entry.title) &&
  entry.title.length <= 200 &&
  (entry.area === null ||
    (object(entry.area) &&
      Object.keys(entry.area).sort().join() === 'center,radiusMeters' &&
      object(entry.area.center) &&
      Object.keys(entry.area.center).sort().join() === 'latitude,longitude' &&
      finite(entry.area.center.latitude) &&
      Math.abs(entry.area.center.latitude) <= 90 &&
      finite(entry.area.center.longitude) &&
      Math.abs(entry.area.center.longitude) <= 180 &&
      finite(entry.area.radiusMeters) &&
      entry.area.radiusMeters > 0));
const pinnedReference = (value) =>
  object(value) &&
  Object.keys(value).length === 3 &&
  text(value.id) &&
  Number.isSafeInteger(value.version) &&
  /^[a-f0-9]{64}$/.test(value.digest ?? '');

/**
 * One considered control's applicability record: its shape and digest, the release's mission and the entry's own
 * control version and type. A control that does not apply was decided on complete inputs by a rule pinned here.
 */
function verifyApplicability(entry, mission, outcome, path) {
  const check = (condition, message) => requireValue(condition, 'mission_release_applicability', path, message);
  const record = entry?.applicability;
  check(
    object(record) &&
      Object.keys(record).sort().join() === 'basis,declared,inputs,measured,outcome,reasons,rule,summary,version' &&
      record.version === 'control.applicability.1' &&
      record.outcome === outcome &&
      APPLICABILITY_BASES.includes(record.basis) &&
      (record.rule === null || pinnedReference(record.rule)) &&
      measures(record.measured) &&
      measures(record.declared) &&
      typeof record.summary === 'string' &&
      record.summary.length > 0 &&
      record.summary.length <= 500 &&
      Array.isArray(record.reasons) &&
      record.reasons.every((reason) => typeof reason === 'string' && /^[a-z][a-z0-9_]{0,99}$/.test(reason)),
    'Mission release applicability record is malformed',
  );
  check(
    entry.applicabilityDigest === canonicalDigest(record),
    'Mission release applicability digest does not reproduce',
  );
  const inputs = record.inputs;
  check(
    object(inputs) &&
      Object.keys(inputs).sort().join() === 'control,controlType,mission' &&
      canonicalDigest(inputs.mission) === canonicalDigest(mission) &&
      canonicalDigest(inputs.control) ===
        canonicalDigest({
          controlId: entry.controlId,
          versionNumber: entry.controlVersion,
          controlEventId: entry.controlEventId,
          bodyDigest: entry.controlDigest,
        }) &&
      canonicalDigest(inputs.controlType) === canonicalDigest(entry.template),
    'Mission release applicability record names another mission or control',
  );
  // A control that applies is compared with the route whatever its rule said; one that does not rests on its rule.
  check(
    outcome === 'applies' ||
      (record.basis === 'rule' &&
        APPLICABILITY_RULES.some((rule) => canonicalDigest(rule) === canonicalDigest(record.rule))),
    'Mission release applicability record names a rule this verifier does not pin',
  );
}

function verifyFindings(findings, acceptance, envelope, events, tenantId, check) {
  const fail = (condition, message) => check(condition, message, 'mission_release_findings');
  fail(
    object(findings) &&
      Object.keys(findings).length === 4 &&
      findings.version === 'mission.release-findings.1' &&
      Array.isArray(findings.subjects) &&
      Array.isArray(findings.findings),
    'Mission release findings section is malformed',
  );
  fail(
    findings.digest ===
      canonicalDigest({ version: findings.version, subjects: findings.subjects, findings: findings.findings }),
    'Mission release findings digest does not reproduce',
  );
  const reference = (subject) =>
    object(subject) &&
    SUBJECT_KINDS.includes(subject.kind) &&
    text(subject.id) &&
    (subject.scope === 'ledger'
      ? subject.sourceId === undefined
      : subject.scope === 'source' && text(subject.sourceId));
  const keys = [];
  const reasons = [];
  for (const entry of findings.subjects) {
    fail(
      object(entry) &&
        reference(entry.subject) &&
        entry.subjectKey === subjectKey(entry.subject) &&
        ['flight', 'organization', 'named'].includes(entry.reason) &&
        (keys.length === 0 || order(keys.at(-1), entry.subjectKey) < 0),
      'Mission release findings subjects are malformed or out of order',
    );
    keys.push(entry.subjectKey);
    reasons.push(entry.reason);
  }
  const flightKey = subjectKey({ scope: 'ledger', kind: 'flight', id: acceptance.flightId });
  fail(
    reasons.filter((reason) => reason === 'flight').length === 1 &&
      keys[reasons.indexOf('flight')] === flightKey &&
      reasons.filter((reason) => reason === 'organization').length === 1 &&
      keys[reasons.indexOf('organization')] ===
        subjectKey({ scope: 'ledger', kind: 'organization', id: acceptance.organizationId }),
    'Mission release findings do not read the released flight and its organization',
  );
  const releasedAt = Date.parse(envelope.receivedAt);
  let previous;
  for (const finding of findings.findings) {
    fail(
      object(finding) &&
        reference(finding.subject) &&
        finding.subjectKey === subjectKey(finding.subject) &&
        FINDING_STATUSES.includes(finding.status) &&
        object(finding.rule) &&
        object(finding.answer) &&
        object(finding.evaluation) &&
        (finding.related === undefined ||
          (object(finding.related) &&
            reference(finding.related.subject) &&
            finding.related.subjectKey === subjectKey(finding.related.subject))),
      'Mission release finding is malformed',
    );
    const relatedKey = finding.related?.subjectKey ?? '';
    fail(
      keys.includes(finding.subjectKey) ||
        (keys.includes(relatedKey) && !(finding.subject.kind === 'flight' && finding.subjectKey !== flightKey)),
      'Mission release lists a finding about a subject it did not read',
    );
    fail(
      finding.id === findingId(tenantId, finding.subjectKey, finding.rule.packId, finding.rule.id, relatedKey),
      'Mission release finding identity does not reproduce',
    );
    fail(
      !previous ||
        order(previous.subjectKey, finding.subjectKey) < 0 ||
        (previous.subjectKey === finding.subjectKey && order(previous.id, finding.id) < 0),
      'Mission release findings are out of order',
    );
    previous = finding;
    // The pinned evaluation is in this inventory and says what the release listed.
    const pinned = events.get(finding.evaluation.id)?.envelope;
    fail(
      pinned && pinned.type === EVALUATION_KIND && object(pinned.payload) && object(pinned.payload.evaluation),
      'Mission release pins an evaluation missing from this inventory',
    );
    const evaluation = { ...pinned.payload.evaluation, recordedAt: pinned.receivedAt };
    fail(
      canonicalDigest(evaluation) === finding.evaluation.digest &&
        evaluation.id === finding.evaluation.id &&
        evaluation.recordedAt === finding.evaluation.recordedAt &&
        Date.parse(pinned.receivedAt) <= releasedAt,
      'Mission release finding evaluation differs from its pinned evaluation',
    );
    fail(
      evaluation.subjectKey === finding.subjectKey &&
        (evaluation.related?.subjectKey ?? '') === relatedKey &&
        (evaluation.adoption?.mode ?? 'active') === 'active' &&
        evaluation.pack?.id === finding.rule.packId &&
        evaluation.rule?.id === finding.rule.id &&
        evaluation.rule?.version === finding.rule.version &&
        evaluation.rule?.title === finding.rule.title &&
        evaluation.outcome === finding.answer.outcome &&
        evaluation.evidenceState === finding.answer.evidenceState &&
        evaluation.summary === finding.answer.summary,
      'Mission release finding differs from what its pinned evaluation recorded',
    );
  }
  return findings.findings.length;
}
