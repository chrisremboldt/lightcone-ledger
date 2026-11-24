import { randomUUID } from 'node:crypto';
import type { LedgerClient } from '@ledger/adapters';
import {
  REAUTHENTICATION_HEADER,
  type CommandRecord,
  type LocalReauthenticationResponse,
  type SmsSigningPreviewResponse,
} from '@ledger/contracts';
import { canonicalDigest } from '@ledger/integrity';
import { commandsPath, readRecord } from './hazard-actor.js';
import {
  ActorPending,
  action,
  checkPrincipal,
  lockJournal,
  pending,
  saveJournal,
  submit,
} from './indicator-actor-common.js';
import {
  acceptedSmsCommand,
  readHazardJournal,
  riskAcceptanceJournalKind,
  riskAcceptanceSteps,
  validateHazardJournal,
  validateRiskAcceptancePlan,
  type HazardJournal,
  type RiskAcceptancePlan,
} from './hazard-plan.js';

// A simulated accountable person signs the risk acceptance of an assessed hazard, which binds the controls the
// assessment listed. Signing needs a fresh confirmation that it is them: a simulated person can give one only where
// Ledger offers the local fixture grant (local and test). Anywhere else the acceptance is a real person's step.

export interface RiskAcceptanceActorResult {
  status: 'pending' | 'accepted' | 'rejected';
  code: string;
  reason: string;
  attempts: number;
  hazardId?: string;
  acceptanceId?: string;
}

export const signingPath = '/v1/sms/records/{id}/signing';
export const reauthenticationPath = '/v1/local/reauthentications';

async function acceptanceRequest(plan: RiskAcceptancePlan, ledger: LedgerClient) {
  const hazard = await readRecord(ledger, plan.hazardId, 'hazard');
  const latest = hazard.decisions.find((decision) => decision.kind === 'risk.assess');
  if (latest?.id !== plan.assessmentId)
    pending('assessment_changed', 'The planned assessment is no longer the hazard’s latest');
  const shown = await ledger.request<SmsSigningPreviewResponse>(
    `${signingPath.replace('{id}', encodeURIComponent(plan.hazardId))}?meaning=risk.accept`,
  );
  if (!shown.available || !shown.intent || !shown.contentDigest)
    pending('signing_unavailable', shown.reason ?? 'This risk acceptance cannot be signed now');
  if (shown.reauthentication !== 'local_fixture')
    pending('person_required', 'Signing here needs a person’s own confirmation; a simulated person cannot sign');
  return {
    kind: 'decision.record',
    subject: { kind: 'sms', id: plan.hazardId },
    expectedRevision: shown.basis.revision,
    expectedDependencyBasis: shown.basis.dependencyBasis,
    decision: {
      kind: 'risk.accept',
      note: plan.note,
      assessmentId: plan.assessmentId,
      signature: { intent: shown.intent, contentDigest: shown.contentDigest, reviewed: true },
    },
  };
}

/** A single-use local confirmation for the bearer credential the actor holds. */
async function confirmation(ledger: LedgerClient, credential: string): Promise<string> {
  const response = await ledger.request<LocalReauthenticationResponse>(
    reauthenticationPath,
    { method: 'POST', body: JSON.stringify({ credential }) },
    `simulator:reauthentication:${randomUUID()}`,
  );
  if (typeof response?.grant !== 'string' || !response.grant)
    pending('reauthentication_unavailable', 'Ledger did not confirm the signer locally');
  return response.grant;
}

export async function runRiskAcceptance(
  value: RiskAcceptancePlan,
  statePath: string,
  ledger: LedgerClient,
  credential: string,
): Promise<RiskAcceptanceActorResult> {
  let journal: HazardJournal | undefined;
  let unlock: (() => Promise<void>) | undefined;
  let stage = 'journal';
  const accepted = () => journal?.actions[0]?.accepted;
  try {
    const plan = validateRiskAcceptancePlan(value);
    const validate = (journalValue: unknown) =>
      validateHazardJournal(journalValue, riskAcceptanceJournalKind, riskAcceptanceSteps, plan.principalId);
    if (new URL(ledger.baseUrl).origin !== plan.apiUrl)
      pending('api_changed', 'The client differs from the plan’s pinned API origin');
    unlock = await lockJournal(statePath, 'Risk acceptance');
    journal = await readHazardJournal(statePath, riskAcceptanceJournalKind, riskAcceptanceSteps, plan.principalId);
    if (journal && journal.planDigest !== canonicalDigest(plan))
      pending('journal_mismatch', 'The retained journal belongs to another plan');
    journal ??= {
      version: 2,
      kind: riskAcceptanceJournalKind,
      apiUrl: plan.apiUrl,
      planDigest: canonicalDigest(plan),
      tenantId: plan.tenantId,
      principalId: plan.principalId,
      actions: [],
    };
    stage = 'preparation';
    await checkPrincipal(ledger, plan, ['sms:read', 'decision:write']);
    let entry = journal.actions[0];
    if (!entry) {
      const body = await acceptanceRequest(plan, ledger);
      entry = action<CommandRecord>('acceptance', `simulator:sms-risk-accept:${randomUUID()}`, JSON.stringify(body));
      journal.actions.push(entry);
      await saveJournal(statePath, journal, validate);
    }
    if (entry.status === 'submitted') {
      stage = 'acceptance';
      // A replay with the same key returns the recorded acceptance without signing again; the grant goes unused.
      const grant = await confirmation(ledger, credential);
      await submit(
        entry,
        (body, key) =>
          ledger.request<unknown>(
            commandsPath,
            { method: 'POST', body: JSON.stringify(body), headers: { [REAUTHENTICATION_HEADER]: grant } },
            key,
          ),
        (response) => acceptedSmsCommand(response, entry!.payload, plan.principalId),
      );
      await saveJournal(statePath, journal, validate);
    }
    if (entry.rejection)
      return {
        status: 'rejected',
        code: entry.rejection.code,
        reason: 'The server refused the risk acceptance; no replacement will be created',
        attempts: journal.actions.length,
        hazardId: plan.hazardId,
      };
    return {
      status: 'accepted',
      code: 'risk_accepted',
      reason: 'The signed risk acceptance is on the hazard’s safety record',
      attempts: journal.actions.length,
      hazardId: plan.hazardId,
      acceptanceId: entry.accepted!.id,
    };
  } catch (error) {
    return {
      status: 'pending',
      code: error instanceof ActorPending ? error.code : `${stage}_unavailable`,
      reason:
        error instanceof ActorPending
          ? error.message
          : stage === 'acceptance'
            ? 'The outcome is uncertain; retry with this journal to replay the identical request and key'
            : 'The risk acceptance could not be recorded; retain its plan and journal before retrying',
      attempts: journal?.actions.length ?? 0,
      ...(accepted() ? { acceptanceId: accepted()!.id } : {}),
    };
  } finally {
    await unlock?.();
  }
}
