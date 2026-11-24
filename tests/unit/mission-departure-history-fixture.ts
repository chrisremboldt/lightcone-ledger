import type {
  DecisionEvidenceBundle,
  EvidenceEnvelope,
  FlightEvidenceBundle,
  SubjectEvidenceBundle,
} from '../../packages/contracts/src/index.js';
import {
  missionDepartureAuthorization,
  missionDeparturePermit,
  missionReleaseRecord,
} from '../../packages/contracts/fixtures/demo/v1/mission-release.js';
import type { MissionDepartureIssuanceBasis } from '../../packages/domain/src/mission-departure-types.js';
import { canonicalDigest } from '../../packages/integrity/src/index.js';
import { appendJournalHistory } from './journal-history-fixture.js';
import { missionReleaseHistoryEffect } from './mission-release-history-fixture.js';

type InventoryBundle = DecisionEvidenceBundle | FlightEvidenceBundle | SubjectEvidenceBundle;

/** The list a departure pins when no control was in scope. */
const noControls = {
  version: 'flight.controls-seen.1' as const,
  controls: [],
  notApplicable: [],
  complete: true,
  mission: null,
};

export function missionDepartureHistoryBasis(): MissionDepartureIssuanceBasis {
  const { previewDigest: _previewDigest, ...preview } = missionReleaseRecord.basis.avoidance;
  const freshPreview = { ...preview, evaluatedAt: missionDeparturePermit.authorizedAt };
  // The review as read, whose digest covers every considered control, kept without those that do not apply.
  const { notApplicable: _notApplicable, ...reviewed } = {
    ...freshPreview,
    previewDigest: canonicalDigest(freshPreview),
  };
  return {
    version: 'mission.departure-issuance.2',
    release: missionReleaseRecord,
    avoidance: reviewed,
    candidateContexts: missionReleaseRecord.basis.candidateContexts,
    renderedInputCut: missionReleaseRecord.basis.renderedInputCut,
    acceptedInputCut: missionReleaseRecord.basis.acceptedInputCut,
    basisManifest: missionReleaseRecord.basis.basisManifest,
    controls: { ...noControls, digest: canonicalDigest(noControls) },
  };
}

export function missionDepartureHistoryEffect(tenantId: string): EvidenceEnvelope {
  const issuanceBasis = missionDepartureHistoryBasis();
  const { id, authorizedAt, validUntil: _validUntil, ...permit } = missionDeparturePermit;
  return {
    ...missionReleaseHistoryEffect(tenantId),
    eventId: id,
    sequence: '2',
    type: 'mission.departure-authorize',
    principalId: permit.actor.id,
    receivedAt: authorizedAt,
    payload: {
      ...missionDepartureAuthorization,
      acceptance: { permit, issuanceBasis },
      declaredSubjects: [permit.flightId],
    },
  };
}

export function appendMissionDepartureHistory<T extends InventoryBundle>(bundle: T): T {
  return appendJournalHistory(
    bundle,
    [missionReleaseHistoryEffect(bundle.manifest.tenantId), missionDepartureHistoryEffect(bundle.manifest.tenantId)],
    `flight:${missionReleaseRecord.flightId}`,
  );
}
