import { randomUUID } from 'node:crypto';
import type { MissionReleaseCommandResponse, MissionReleaseValidityResponse, Principal } from '@ledger/contracts';
import { ApiError } from '@ledger/contracts/client';
import { canonicalDigest, sha256 } from '@ledger/integrity';
import type { OracleReader } from './attempt-oracle.js';
import { confirmMissionRelease, validateMissionReleaseAccepted } from './mission-release-confirmation.js';
import {
  lockMissionReleaseJournal,
  readMissionReleaseJournal,
  saveMissionReleaseJournal,
  type MissionReleaseJournal,
} from './mission-release-journal.js';
import {
  checkMissionReleaseAuthority,
  prepareMissionReleaseCommand,
  ReleasePending,
  validateMissionReleaseCommand,
  validateMissionReleasePlan,
  type MissionReleasePlan,
} from './mission-release-plan.js';
import { OracleReadError } from './oracle-api.js';

export interface MissionReleaseActorResult {
  status: 'pending' | 'accepted' | 'rejected';
  code: string;
  reason: string;
  attempts: number;
  eventId?: string;
  flightId?: string;
  record?: 'confirmed' | 'unconfirmed';
  releaseDigest?: string;
  validity?: MissionReleaseValidityResponse;
}

const endpoint = '/v1/commands';

function checkJournal(journal: MissionReleaseJournal, plan: MissionReleasePlan): void {
  if (
    journal.planDigest !== canonicalDigest(plan) ||
    journal.principalId !== plan.principalId ||
    journal.tenantId !== plan.tenantId ||
    journal.endpoint !== endpoint
  )
    throw new ReleasePending('journal_mismatch', 'The journal belongs to another release plan or acting principal');
  for (const action of journal.actions) {
    validateMissionReleaseCommand(JSON.parse(action.payload), plan);
    if (action.status === 'accepted') validateMissionReleaseAccepted(action.accepted, action, plan);
  }
}

function definitiveRejection(error: unknown): { status: number; code: string } | undefined {
  if (
    !(error instanceof ApiError) ||
    !Number.isSafeInteger(error.status) ||
    error.status < 400 ||
    error.status >= 500 ||
    [401, 403, 404, 408, 425, 429].includes(error.status) ||
    !error.body ||
    typeof error.body !== 'object' ||
    !('error' in error.body)
  )
    return undefined;
  const rejection = error.body.error;
  if (
    !rejection ||
    typeof rejection !== 'object' ||
    !('code' in rejection) ||
    typeof rejection.code !== 'string' ||
    !/^[a-z][a-z0-9_]{0,99}$/.test(rejection.code)
  )
    return undefined;
  return { status: error.status, code: rejection.code };
}

export async function runMissionRelease(
  value: MissionReleasePlan,
  statePath: string,
  api: OracleReader,
  submit: (payload: string, key: string) => Promise<MissionReleaseCommandResponse>,
  validateFreshPrincipal?: (principal: Principal) => void,
): Promise<MissionReleaseActorResult> {
  let journal: MissionReleaseJournal | undefined;
  let release: (() => Promise<void>) | undefined;
  let acceptedDurably = false;
  let stage: 'journal' | 'review' | 'submission' | 'confirmation' = 'journal';
  try {
    const plan = validateMissionReleasePlan(value);
    release = await lockMissionReleaseJournal(statePath);
    journal = await readMissionReleaseJournal(statePath);
    if (journal) checkJournal(journal, plan);
    else
      journal = {
        version: 1,
        kind: 'mission-release-action',
        planDigest: canonicalDigest(plan),
        principalId: plan.principalId,
        tenantId: plan.tenantId,
        endpoint,
        actions: [],
      };
    let action = journal.actions[0];
    acceptedDurably = action?.status === 'accepted';
    stage = 'review';
    if (action?.status === 'rejected')
      return {
        status: 'rejected',
        code: action.rejection!.code,
        attempts: 1,
        reason: 'The retained release was definitively rejected; this journal will not replace it',
      };
    if (!action) {
      const principal = await checkMissionReleaseAuthority(plan, api, true);
      validateFreshPrincipal?.(principal);
      const command = validateMissionReleaseCommand(await prepareMissionReleaseCommand(plan, api, principal), plan);
      const payload = JSON.stringify(command);
      action = {
        key: `simulator:mission-release:${randomUUID()}`,
        payload,
        payloadSha256: sha256(payload),
        status: 'submitted',
      };
      journal.actions.push(action);
      await saveMissionReleaseJournal(statePath, journal);
    } else await checkMissionReleaseAuthority(plan, api, false);
    if (action.status === 'submitted') {
      stage = 'submission';
      let response: MissionReleaseCommandResponse;
      try {
        response = await submit(action.payload, action.key);
      } catch (error) {
        const rejection = definitiveRejection(error);
        if (!rejection) throw error;
        action.status = 'rejected';
        action.rejection = rejection;
        await saveMissionReleaseJournal(statePath, journal);
        return {
          status: 'rejected',
          code: rejection.code,
          reason: 'The server definitively rejected this retained release; no replacement will be created',
          attempts: 1,
        };
      }
      action.accepted = validateMissionReleaseAccepted(response?.command, action, plan);
      action.status = 'accepted';
      await saveMissionReleaseJournal(statePath, journal);
      acceptedDurably = true;
    }
    stage = 'confirmation';
    return await confirmMissionRelease(plan, action.accepted!, api, 1);
  } catch (error) {
    const accepted = acceptedDurably ? journal?.actions[0]?.accepted : undefined;
    return {
      status: accepted ? 'accepted' : 'pending',
      code: error instanceof ReleasePending || error instanceof OracleReadError ? error.code : `${stage}_unavailable`,
      reason:
        error instanceof ReleasePending || error instanceof OracleReadError
          ? error.message
          : stage === 'journal'
            ? 'The release journal cannot be locked or validated; retain it and resolve any abandoned lock before retrying'
            : stage === 'submission'
              ? 'The outcome is uncertain; a later invocation will replay the identical retained bytes and key'
              : 'The retained release could not be confirmed; keep this journal before retrying',
      attempts: journal?.actions.length ?? 0,
      ...(accepted ? { eventId: accepted.id, flightId: accepted.flightId, record: 'unconfirmed' as const } : {}),
    };
  } finally {
    await release?.();
  }
}
