import type {
  DecisionEvidenceBundle,
  EvidenceEnvelope,
  FlightEvidenceBundle,
  SubjectEvidenceBundle,
} from '../../packages/contracts/src/index.js';
import {
  missionBriefingAcknowledgementCommand,
  missionBriefingAcknowledgementRecord,
  missionBriefingCommand,
  missionBriefingRecord,
} from '../../packages/contracts/fixtures/demo/v1/mission-briefing.js';
import { appendJournalHistory } from './journal-history-fixture.js';
import { missionReleaseHistoryEffect } from './mission-release-history-fixture.js';

type InventoryBundle = DecisionEvidenceBundle | FlightEvidenceBundle | SubjectEvidenceBundle;

export function missionBriefingHistoryEffects(tenantId: string): EvidenceEnvelope[] {
  const { id: briefingId, recordedAt: briefingTime, ...briefing } = missionBriefingRecord;
  const {
    id: acknowledgementId,
    recordedAt: acknowledgementTime,
    ...acknowledgement
  } = missionBriefingAcknowledgementRecord;
  const base = missionReleaseHistoryEffect(tenantId);
  return [
    {
      ...base,
      eventId: briefingId,
      sequence: '2',
      type: 'mission.brief',
      principalId: briefing.actor.id,
      receivedAt: briefingTime,
      payload: { ...missionBriefingCommand, acceptance: briefing, declaredSubjects: [briefing.flightId] },
    },
    {
      ...base,
      eventId: acknowledgementId,
      sequence: '3',
      type: 'mission.briefing-acknowledge',
      principalId: acknowledgement.actor.id,
      receivedAt: acknowledgementTime,
      payload: {
        ...missionBriefingAcknowledgementCommand,
        acceptance: acknowledgement,
        declaredSubjects: [acknowledgement.flightId],
      },
    },
  ];
}

export function appendMissionBriefingHistory<T extends InventoryBundle>(bundle: T): T {
  return appendJournalHistory(
    bundle,
    [missionReleaseHistoryEffect(bundle.manifest.tenantId), ...missionBriefingHistoryEffects(bundle.manifest.tenantId)],
    `flight:${missionBriefingRecord.flightId}`,
  );
}
