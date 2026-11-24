import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import type { LedgerClient } from '@ledger/contracts/client';
import { FlightPredeparturePanel } from '../../apps/web/src/FlightPredeparturePanel.js';
import type { FlightPredepartureResponse, MissionReleaseRecord } from '../../packages/contracts/src/index.js';
import { canonicalDigest } from '../../packages/integrity/src/index.js';
import {
  areaControlBriefingContent,
  areaControlHazardId,
  areaControlHazardVersion,
  areaControlVersion,
} from '../../packages/contracts/fixtures/demo/v1/area-control.js';
import { recordAreaControl, type AreaControlReference } from '../../apps/web/src/area-controls.js';
import {
  missionReleaseRecord,
  missionReleaseValidityCurrent,
} from '../../packages/contracts/fixtures/demo/v1/mission-release.js';
import {
  predepartureBriefings,
  predeparturePresentation,
  predepartureReadyAttention,
  predepartureReleaseCurrent,
} from '../../apps/web/src/predeparture.js';
import {
  missionBriefingInForce,
  missionBriefingLapsed,
} from '../../packages/contracts/fixtures/demo/v1/mission-briefing.js';

const inForce = missionBriefingInForce;
const lapsed = missionBriefingLapsed;

/** The accepted area control record a candidate names, as screens show it. */
const areaControl = (reference: AreaControlReference) =>
  recordAreaControl(
    {
      kind: 'control_record',
      hazard: { id: areaControlHazardId, title: areaControlHazardVersion.title },
      controlEventId: reference.controlEventId,
      bodyDigest: reference.controlDigest,
      owner: areaControlVersion.owner,
      content: areaControlBriefingContent,
    },
    reference,
  );

function responseFor(release: MissionReleaseRecord): FlightPredepartureResponse {
  const reference = { id: release.id, digest: canonicalDigest(release) };
  const mission = structuredClone(release.basis.avoidance.mission);
  const progress = {
    version: 'flight.predeparture-progress.1' as const,
    id: 'progress',
    flightId: release.flightId,
    revision: 3,
    execution: {
      runId: 'ordinary-world',
      reservationId: 'customer-order-attempt',
      aircraftId: release.aircraftId,
      sourceMissionId: 'customer-mission',
    },
    sourceObservedAt: release.recordedAt,
    recordedAt: release.recordedAt,
    phase: 'awaiting_acknowledgement' as const,
    code: 'personal_review_pending',
    retryable: true,
    reason: 'Each released control needs its exact personal reviews.',
    needsHumanReview: true,
    source: {
      principalId: 'source',
      missionSourceId: 'mission-planner',
      automaticReleasePrincipalId: 'dispatch-service',
    },
    references: { mission, release: reference, briefings: [] },
  };
  return {
    enabled: true,
    flightId: release.flightId,
    progress,
    digest: canonicalDigest(progress),
    processing: 'completed',
    readAt: release.recordedAt,
    current: {
      acceptedMission: mission,
      projectedMission: mission,
      missionProcessing: 'completed',
      releaseValidity: { ...structuredClone(missionReleaseValidityCurrent), release: reference },
      briefings: [],
    },
  };
}

describe('ordinary flight departure presentation', () => {
  it('keeps human release distinct from quiet automatic checks and reported physical activity', () => {
    expect(predeparturePresentation({ phase: 'awaiting_release', needsHumanReview: true })).toEqual({
      label: 'Held · human release required',
      attention: true,
    });
    expect(predeparturePresentation({ phase: 'ready', needsHumanReview: true }).label).toContain(
      'Human review recorded',
    );
    expect(predeparturePresentation({ phase: 'ready', needsHumanReview: false }).label).toContain('Checks clear');
    expect(predeparturePresentation({ phase: 'departed', needsHumanReview: true }).label).toBe(
      'Source reported departure',
    );
  });

  it('requires separate exact briefing coverage for every released control without borrowing a different briefing', () => {
    const release = structuredClone(missionReleaseRecord);
    const first = release.basis.avoidance.candidates[0]!;
    release.basis.avoidance.candidates.push({
      ...structuredClone(first),
      controlEventId: 'second-area',
      controlId: 'second-control',
    });
    const response = responseFor(release);
    const briefing = { id: 'briefing-one', digest: 'a'.repeat(64) };
    response.progress!.references.briefings = [{ controlEventId: first.controlEventId, briefing }];
    response.current.briefings = [
      { controlEventId: first.controlEventId, briefing, acknowledged: 1, recipients: 1, standing: inForce },
    ];
    const rows = predepartureBriefings(response, release, [areaControl(first)]);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.complete)).toEqual([true, false]);
    expect(rows[1]!.briefing).toBeUndefined();
    response.current.briefings[0]!.briefing = { id: 'another-briefing', digest: briefing.digest };
    expect(predepartureBriefings(response, release, [areaControl(first)])[0]).toMatchObject({
      complete: false,
      acknowledged: undefined,
      recipients: undefined,
    });
    release.basis.avoidance.candidates = [];
    expect(predepartureBriefings(response, release, [])).toEqual([]);
  });

  it('offers one briefing for every control that has none and keeps each control listed with what covers it', () => {
    const release = structuredClone(missionReleaseRecord);
    const first = release.basis.avoidance.candidates[0]!;
    for (const suffix of ['second', 'third'])
      release.basis.avoidance.candidates.push({
        ...structuredClone(first),
        controlEventId: `${suffix}-area`,
        controlId: `${suffix}-control`,
      });
    const response = responseFor(release);
    const briefing = { id: 'briefing-one', digest: 'a'.repeat(64) };
    response.progress!.references.briefings = [{ controlEventId: first.controlEventId, briefing }];
    response.current.briefings = [
      { controlEventId: first.controlEventId, briefing, acknowledged: 1, recipients: 1, standing: inForce },
    ];
    const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
    const { createElement } = webRequire('react') as typeof import('react');
    const { renderToStaticMarkup } = webRequire('react-dom/server') as typeof import('react-dom/server');
    const shown = renderToStaticMarkup(
      createElement(FlightPredeparturePanel, {
        active: true,
        client: {} as LedgerClient,
        flightId: release.flightId,
        onBriefing: () => {},
        status: {
          read: { response, release, controls: release.basis.avoidance.candidates.map(areaControl) },
          error: null,
        },
      }),
    );
    expect(shown.match(/Prepare the controls briefing →/g)).toHaveLength(1);
    expect(shown).toContain('2 areas have no briefing yet; one controls briefing will cover all of them.');
    expect(shown.match(/covered by the controls briefing to prepare/g)).toHaveLength(2);
    expect(shown).toContain('Review briefing →');
  });

  it('treats a lapsed briefing as needing a new one, though its reviews were recorded in time', () => {
    const release = structuredClone(missionReleaseRecord);
    const first = release.basis.avoidance.candidates[0]!;
    const response = responseFor(release);
    const briefing = { id: 'briefing-one', digest: 'a'.repeat(64) };
    response.progress!.phase = 'ready';
    response.progress!.references.briefings = [{ controlEventId: first.controlEventId, briefing }];
    response.current.briefings = [
      { controlEventId: first.controlEventId, briefing, acknowledged: 1, recipients: 1, standing: lapsed },
    ];
    expect(predepartureBriefings(response, release, [areaControl(first)])[0]).toMatchObject({
      briefing,
      lapsed: true,
      complete: false,
    });
    expect(predepartureReadyAttention(response, release)).toBe(
      'A briefing this departure relies on has lapsed. A new briefing is needed.',
    );
    const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
    const { createElement } = webRequire('react') as typeof import('react');
    const { renderToStaticMarkup } = webRequire('react-dom/server') as typeof import('react-dom/server');
    const shown = renderToStaticMarkup(
      createElement(FlightPredeparturePanel, {
        active: true,
        client: {} as LedgerClient,
        flightId: release.flightId,
        onBriefing: () => {},
        status: { read: { response, release, controls: [areaControl(first)] }, error: null },
      }),
    );
    expect(shown).toContain('The briefing for one area has lapsed and no longer counts; a new briefing is needed.');
    expect(shown).toContain('departure window closed');
    expect(shown).toContain('1 / 1 named recipients reviewed it before then.');
    expect(shown.match(/Prepare the controls briefing →/g)).toHaveLength(1);
    response.current.briefings[0]!.standing = inForce;
    expect(predepartureReadyAttention(response, release)).toBeNull();
  });

  it('does not offer a new briefing against a source-linked release when the current mission or release changed', () => {
    const release = structuredClone(missionReleaseRecord);
    const response = responseFor(release);
    expect(predepartureReleaseCurrent(response, release)).toBe(true);
    expect(
      predepartureReleaseCurrent(response, {
        ...release,
        basis: { ...release.basis, mission: { ...release.basis.mission, contentDigest: 'c'.repeat(64) } },
      }),
    ).toBe(false);
    response.current.projectedMission = { ...response.current.projectedMission!, recordDigest: 'b'.repeat(64) };
    expect(predepartureReleaseCurrent(response, release)).toBe(false);
    const changed = responseFor(release);
    changed.current.releaseValidity!.status = 'changed';
    expect(predepartureReleaseCurrent(changed, release)).toBe(false);
  });

  it('draws attention to stale or unconfirmed current readiness while retaining the exact source phase', () => {
    const release = structuredClone(missionReleaseRecord);
    const response = responseFor(release);
    response.progress!.phase = 'ready';
    expect(predepartureReadyAttention(response, release)).toBeNull();
    for (const status of ['changed', 'expired', 'pending'] as const) {
      response.current.releaseValidity!.status = status;
      expect(predepartureReadyAttention(response, release)).not.toBeNull();
      expect(response.progress!.phase).toBe('ready');
    }
    response.current.releaseValidity!.status = 'current';
    response.current.projectedMission = null;
    expect(predepartureReadyAttention(response, release)).not.toBeNull();
    expect(predepartureReadyAttention(responseFor(release), null)).toBeNull();
    const current = responseFor(release);
    current.progress!.phase = 'ready';
    expect(predepartureReadyAttention(current, null)).not.toBeNull();
    expect(predepartureReadyAttention(current, release, true)).not.toBeNull();
    expect(current.progress!.sourceObservedAt).toBe(release.recordedAt);
  });
});
