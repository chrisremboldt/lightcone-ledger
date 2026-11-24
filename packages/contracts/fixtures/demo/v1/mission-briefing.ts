import { canonicalDigest } from '../../../../integrity/src/index.js';
import type {
  MissionBriefingCommand,
  MissionBriefingRecord,
  MissionBriefingRecordResponse,
  MissionBriefingAcknowledgementCommand,
  MissionBriefingAcknowledgementRecord,
  MissionBriefingAcknowledgementsResponse,
  MissionBriefingStanding,
} from '../../../src/mission-briefing.js';
import { areaControlBriefingContent } from './area-control.js';
import { missionReleaseRecord, missionReleasePolicy, missionReleaseValidityChanged } from './mission-release.js';

const release = missionReleaseRecord;
const candidate = release.basis.avoidance.candidates[0]!;
const control = {
  hazardId: candidate.hazardId,
  controlId: candidate.controlId,
  controlVersion: candidate.controlVersion,
  controlEventId: candidate.controlEventId,
  controlDigest: candidate.controlDigest,
  acceptance: candidate.acceptance,
};
const sam = { principalId: 'fixture-principal-sam', name: 'Sam Rivera', kind: 'human' as const, principalRevision: 1 };
const population = {
  version: 'briefing.recipient-population.1' as const,
  organizationId: release.organizationId,
  recipients: [sam],
};
const author: MissionBriefingRecord['actor'] = {
  id: 'fixture-principal-dana',
  name: 'Dana Ortiz',
  kind: 'human',
  active: true,
  principalRevision: 1,
  capabilities: ['flight:read', 'briefing:write'],
  checkedCapabilities: ['flight:read', 'briefing:write'],
  policyVersion: 'ledger.mission-briefing-authority.1',
  scope: { kind: 'flight', id: release.flightId },
};
export const missionBriefingCommand = {
  kind: 'mission.brief',
  flightId: release.flightId,
  purpose: 'informational',
  release: { id: release.id, digest: canonicalDigest(release) },
  controls: [control],
  recipientPrincipalIds: [sam.principalId],
  message: 'Review this exact avoidance area and mission context; acknowledge only your own review.',
  expectedPrincipalRevision: author.principalRevision,
} satisfies MissionBriefingCommand;
export const missionBriefingRecord = {
  version: 'flight.mission-briefing.3',
  id: 'fixture-mission-briefing-3',
  flightId: release.flightId,
  organizationId: release.organizationId,
  recordedAt: '2026-10-15T14:15:00Z',
  purpose: 'informational',
  context: {
    release: missionBriefingCommand.release,
    mission: release.basis.avoidance.mission,
    aircraftId: release.aircraftId,
    contextDigest: release.basis.avoidance.contextDigest,
    releasePolicy: {
      id: missionReleasePolicy.id,
      version: missionReleasePolicy.version,
      digest: missionReleasePolicy.digest,
    },
    controls: [control],
  },
  content: {
    message: missionBriefingCommand.message,
    controls: [areaControlBriefingContent],
  },
  population: { ...population, digest: canonicalDigest(population) },
  actor: author,
} satisfies MissionBriefingRecord;
const standing = (evaluatedAt: string): MissionBriefingStanding => ({
  status: Date.parse(evaluatedAt) < Date.parse(release.departureWindow.end) ? 'in_force' : 'lapsed',
  validUntil: release.departureWindow.end,
  boundary: 'release_window_end',
  evaluatedAt,
});
export const missionBriefingInForce = standing('2026-10-15T14:15:05Z');
/** Read after the release window closed: acknowledgements recorded before stay, but it no longer counts. */
export const missionBriefingLapsed = standing(release.departureWindow.end);
export const missionBriefingRecordResponse = {
  briefing: missionBriefingRecord,
  digest: canonicalDigest(missionBriefingRecord),
  standing: missionBriefingInForce,
} satisfies MissionBriefingRecordResponse;
export const missionBriefingAcknowledgementCommand = {
  kind: 'mission.briefing-acknowledge',
  flightId: release.flightId,
  briefing: { id: missionBriefingRecord.id, digest: canonicalDigest(missionBriefingRecord) },
  populationDigest: missionBriefingRecord.population.digest,
  attestation: 'reviewed_exact_briefing',
  expectedPrincipalRevision: 2,
} satisfies MissionBriefingAcknowledgementCommand;
export const missionBriefingAcknowledgementRecord = {
  version: 'flight.mission-briefing-acknowledgement.1',
  id: 'fixture-mission-briefing-ack-1',
  flightId: release.flightId,
  briefing: missionBriefingAcknowledgementCommand.briefing,
  populationDigest: missionBriefingRecord.population.digest,
  recipientPrincipalId: sam.principalId,
  attestation: 'reviewed_exact_briefing',
  recordedAt: '2026-10-15T14:15:10Z',
  actor: {
    id: sam.principalId,
    name: sam.name,
    kind: 'human',
    active: true,
    principalRevision: missionBriefingAcknowledgementCommand.expectedPrincipalRevision,
    capabilities: ['flight:read', 'briefing:ack'],
    checkedCapabilities: ['flight:read', 'briefing:ack'],
    policyVersion: 'ledger.mission-briefing-acknowledgement-authority.1',
    scope: author.scope,
  },
} satisfies MissionBriefingAcknowledgementRecord;
const expandedPopulation = {
  ...population,
  recipients: [{ ...sam, principalId: 'fixture-principal-lee', name: 'Lee Park' }, sam],
};
const replacementBriefing = {
  ...missionBriefingRecord,
  id: 'fixture-mission-briefing-2',
  recordedAt: '2026-10-15T14:15:20Z',
  population: { ...expandedPopulation, digest: canonicalDigest(expandedPopulation) },
} satisfies MissionBriefingRecord;
export const missionBriefingHistoricalAcknowledgements = {
  briefing: missionBriefingAcknowledgementCommand.briefing,
  evaluatedAt: missionReleaseValidityChanged.evaluatedAt,
  purpose: 'informational',
  scope: 'declared_recipients_only',
  population: missionBriefingRecord.population,
  recipients: [
    {
      recipientPrincipalId: sam.principalId,
      acknowledgement: {
        record: missionBriefingAcknowledgementRecord,
        digest: canonicalDigest(missionBriefingAcknowledgementRecord),
      },
      processing: 'completed',
    },
  ],
  releaseValidity: missionReleaseValidityChanged,
  standing: standing(missionReleaseValidityChanged.evaluatedAt),
} satisfies MissionBriefingAcknowledgementsResponse;
export const missionBriefingNewPopulationAcknowledgements = {
  ...missionBriefingHistoricalAcknowledgements,
  briefing: { id: replacementBriefing.id, digest: canonicalDigest(replacementBriefing) },
  population: replacementBriefing.population,
  recipients: expandedPopulation.recipients.map(({ principalId }) => ({
    recipientPrincipalId: principalId,
    acknowledgement: null,
    processing: null,
  })),
} satisfies MissionBriefingAcknowledgementsResponse;
export const missionBriefingCases = {
  notMember: {
    implementation: 'proposed',
    request: missionBriefingAcknowledgementCommand,
    authenticatedPrincipalId: 'fixture-principal-lee',
    status: 403,
  },
  historicalAfterReleaseChanged: {
    briefing: missionBriefingRecord,
    acknowledgement: missionBriefingAcknowledgementRecord,
    currentReleaseValidity: missionReleaseValidityChanged,
    response: missionBriefingHistoricalAcknowledgements,
  },
  newPopulation: {
    briefing: replacementBriefing,
    priorAcknowledgement: missionBriefingAcknowledgementRecord,
    acknowledgements: [],
    remainingPrincipalIds: expandedPopulation.recipients.map(({ principalId }) => principalId),
    response: missionBriefingNewPopulationAcknowledgements,
  },
};
