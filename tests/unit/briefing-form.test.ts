import { createRequire } from 'node:module';
import { expect, test } from 'vitest';
import { BriefingControlsUnavailable } from '../../apps/web/src/BriefingForm.js';
import type { OrganizationPerson, Principal } from '@ledger/contracts';
import {
  areaControlBriefingContent,
  areaControlHazardId,
  areaControlHazardVersion,
  areaControlVersion,
} from '../../packages/contracts/fixtures/demo/v1/area-control.js';
import { recordAreaControl, type AreaControlReference } from '../../apps/web/src/area-controls.js';
import {
  missionReleaseRecordResponse,
  missionReleaseValidityCurrent,
  missionReleaseValidityScheduled,
} from '../../packages/contracts/fixtures/demo/v1/mission-release.js';
import {
  missionBriefingAcknowledgementCommand,
  missionBriefingCommand,
  missionBriefingHistoricalAcknowledgements,
  missionBriefingInForce,
  missionBriefingLapsed,
  missionBriefingRecordResponse,
} from '../../packages/contracts/fixtures/demo/v1/mission-briefing.js';
import { AcknowledgementForm } from '../../apps/web/src/AcknowledgementForm.js';
// The web app resolves its client through the built package, so its errors are that build's ApiError.
import { ApiError } from '../../packages/contracts/dist/client.js';
import {
  acknowledgementCoverageMatches,
  briefingStandingWords,
  currentBriefingStanding,
  briefingAccessLost,
  briefingBasis,
  briefingCommandLostAccess,
  briefingReadiness,
  buildAcknowledgementCommand,
  buildBriefingCommand,
  type BriefingContext,
} from '../../apps/web/src/briefing.js';

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

const context: BriefingContext = {
  release: missionReleaseRecordResponse,
  validity: missionReleaseValidityCurrent,
  controls: missionReleaseRecordResponse.release.basis.avoidance.candidates.map((candidate) => ({
    candidate,
    control: areaControl(candidate),
  })),
};
const listed = missionBriefingCommand.controls.map((control) => control.controlEventId);
const recipient: OrganizationPerson = {
  id: missionBriefingCommand.recipientPrincipalIds[0]!,
  name: 'Current directory name',
  kind: 'human',
  revision: 99,
};

test('briefing commands pin the exact release/control and select identities by ID while clocks stay outside the draft basis', () => {
  expect(
    buildBriefingCommand(
      context,
      listed,
      [recipient],
      missionBriefingCommand.message,
      missionBriefingCommand.expectedPrincipalRevision,
    ),
  ).toEqual(missionBriefingCommand);
  expect(briefingBasis({ ...context, validity: missionReleaseValidityScheduled })).toBe(briefingBasis(context));
  expect(() => buildBriefingCommand(context, listed, [recipient, recipient], 'Message', 1)).toThrow('distinct');
  const changed = { ...context, validity: { ...context.validity, status: 'changed' as const } };
  expect(briefingReadiness(changed)).not.toEqual([]);
  expect(briefingBasis(changed)).not.toBe(briefingBasis(context));
});

test('a briefing command names the controls list shown beside it, so the briefing pins that list', () => {
  const digest = 'c'.repeat(64);
  expect(
    buildBriefingCommand(
      context,
      listed,
      [recipient],
      missionBriefingCommand.message,
      missionBriefingCommand.expectedPrincipalRevision,
      digest,
    ),
  ).toEqual({ ...missionBriefingCommand, expectedControlsDigest: digest });
});

test('one briefing command lists every selected control once, in the release’s order', () => {
  const [first] = missionReleaseRecordResponse.release.basis.avoidance.candidates;
  const candidates = ['a', 'b', 'c'].map((suffix) => ({
    ...first!,
    controlEventId: `${first!.controlEventId}-${suffix}`,
  }));
  const release = {
    ...missionReleaseRecordResponse,
    release: {
      ...missionReleaseRecordResponse.release,
      basis: {
        ...missionReleaseRecordResponse.release.basis,
        avoidance: { ...missionReleaseRecordResponse.release.basis.avoidance, candidates },
      },
    },
  };
  const several: BriefingContext = {
    ...context,
    release,
    controls: candidates.map((candidate) => ({ candidate, control: areaControl(candidate) })),
  };
  const ids = candidates.map((candidate) => candidate.controlEventId);
  const command = buildBriefingCommand(several, [ids[2]!, ids[0]!, ids[2]!], [recipient], 'Message', 1);
  expect(command.controls.map((control) => control.controlEventId)).toEqual([ids[0], ids[2]]);
  expect(() => buildBriefingCommand(several, [], [recipient], 'Message', 1)).toThrow('one or more');
  expect(() => buildBriefingCommand(several, ['unknown'], [recipient], 'Message', 1)).toThrow('one or more');
});

test('personal review pins the historical briefing population and current caller revision after release context changes', () => {
  const principal: Principal = {
    id: recipient.id,
    tenantId: 'fixture-tenant',
    name: 'Sam Rivera',
    revision: 2,
    capabilities: ['flight:read', 'briefing:ack'],
    commandLinkSources: [],
    missionSources: [],
  };
  expect(acknowledgementCoverageMatches(missionBriefingRecordResponse, missionBriefingHistoricalAcknowledgements)).toBe(
    true,
  );
  expect(buildAcknowledgementCommand(missionBriefingRecordResponse, principal)).toEqual(
    missionBriefingAcknowledgementCommand,
  );
  expect(buildAcknowledgementCommand(missionBriefingRecordResponse, principal).expectedPrincipalRevision).not.toBe(
    missionBriefingRecordResponse.briefing.population.recipients[0]!.principalRevision,
  );
  expect(() =>
    buildAcknowledgementCommand(missionBriefingRecordResponse, { ...principal, id: 'another-person' }),
  ).toThrow('Only a named recipient');
});

test('a briefing whose controls could not be read says why it cannot be recorded yet and offers to read them again', () => {
  const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
  const { createElement } = webRequire('react') as typeof import('react');
  const { renderToStaticMarkup } = webRequire('react-dom/server') as typeof import('react-dom/server');
  const shown = renderToStaticMarkup(
    createElement(BriefingControlsUnavailable, { reason: 'Ledger API returned 503', onRetry: () => {} }),
  );
  expect(shown).toContain('Controls unavailable');
  expect(shown).toContain('could not be read, so the briefing cannot be recorded yet');
  expect(shown).toContain('Ledger API returned 503');
  expect(shown).toContain('Try again');
});

test('a briefing command refused with 401 or 403 is lost access; a 404 or another failure is not', () => {
  expect(briefingCommandLostAccess(new ApiError(401, null))).toBe(true);
  expect(briefingCommandLostAccess(new ApiError(403, null))).toBe(true);
  expect(briefingCommandLostAccess(new ApiError(404, null))).toBe(false);
  expect(briefingCommandLostAccess(new ApiError(409, null))).toBe(false);
  expect(briefingCommandLostAccess(new ApiError(500, null))).toBe(false);
  expect(briefingCommandLostAccess(new TypeError('Failed to fetch'))).toBe(false);
});

test('briefing access lost stays lost until a later read of the release succeeds', () => {
  expect(briefingAccessLost(null, context)).toBe(false);
  expect(briefingAccessLost(null, null)).toBe(false);
  const lost = { context };
  // The context shown when access was lost, or none, does not restore it.
  expect(briefingAccessLost(lost, context)).toBe(true);
  expect(briefingAccessLost(lost, null)).toBe(true);
  // A later read hands the form a new context, even when its content is the same.
  expect(briefingAccessLost(lost, structuredClone(context))).toBe(false);
  expect(briefingAccessLost({ context: null }, context)).toBe(false);
  expect(briefingAccessLost({ context: null }, null)).toBe(true);
});

test('a lapsed briefing says when and why it lapsed and is not offered for acknowledgement', () => {
  const principal: Principal = {
    id: recipient.id,
    tenantId: 'fixture-tenant',
    name: 'Sam Rivera',
    revision: 2,
    capabilities: ['flight:read', 'briefing:ack'],
    commandLinkSources: [],
    missionSources: [],
  };
  const unacknowledged = {
    ...missionBriefingHistoricalAcknowledgements,
    recipients: missionBriefingHistoricalAcknowledgements.recipients.map((row) => ({
      ...row,
      acknowledgement: null,
      processing: null,
    })),
  };
  expect(briefingStandingWords(missionBriefingInForce)).toMatch(
    /^In force until .+ CT, when the release's departure window closes\.$/,
  );
  expect(briefingStandingWords({ ...missionBriefingLapsed, boundary: 'control_boundary' })).toMatch(
    /^Lapsed at .+ CT, when an accepted control that can matter to this flight started or ended\. .*a new briefing is needed\.$/,
  );
  // The polled acknowledgements read decides once it matches the briefing.
  expect(
    currentBriefingStanding(missionBriefingRecordResponse, { ...unacknowledged, standing: missionBriefingLapsed })
      .status,
  ).toBe('lapsed');
  expect(
    currentBriefingStanding({ ...missionBriefingRecordResponse, standing: missionBriefingLapsed }, null).status,
  ).toBe('lapsed');
  const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
  const { createElement } = webRequire('react') as typeof import('react');
  const { renderToStaticMarkup } = webRequire('react-dom/server') as typeof import('react-dom/server');
  const render = (standing: typeof missionBriefingLapsed) =>
    renderToStaticMarkup(
      createElement(AcknowledgementForm, {
        client: {} as never,
        principal,
        exact: missionBriefingRecordResponse,
        coverage: { ...unacknowledged, standing },
        onRefresh: async () => {},
        onAccepted: () => {},
      }),
    );
  const open = render(missionBriefingInForce);
  expect(open).toContain('Acknowledge my review');
  expect(open).not.toContain('This briefing has lapsed');
  const closed = render(missionBriefingLapsed);
  expect(closed).toContain('This briefing has lapsed');
  expect(closed).toContain('departure window closed');
  expect(closed).toContain('It can no longer be acknowledged.');
  expect(closed).not.toContain('Acknowledge my review');
});
