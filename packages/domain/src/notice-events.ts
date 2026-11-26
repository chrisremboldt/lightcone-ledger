import {
  type SmsDecisionRecord,
  type SmsDocumentDistributionOutcome,
  type SmsDocumentIssueOutcome,
} from '@ledger/contracts';
import type { AuthContext, PoolClient } from '@ledger/persistence';
import { noticeKey } from './notice-content.js';
import { findingNoticeRecords, queueNotices, safetyNoticeRecord, type NoticeDraft } from './notices.js';
import { closedActions, signedVersions } from './sms-assurance.js';
import type { SmsRecordRow } from './sms-envelope.js';

/**
 * The notices an event causes (docs/design/notices.md): an assignment and an issue for acknowledgement write theirs in
 * the transaction that records them. Each draft's key names its cause, so a retry writes nothing new.
 */

/** A finding assigned to a person: from its treatment, in the treatment's transaction. */
export async function noticeFindingAssigned(
  client: PoolClient,
  actor: AuthContext,
  treatmentId: string,
  findingId: string,
  assigneeId: string,
): Promise<void> {
  const record = (await findingNoticeRecords(client, actor.tenantId, [findingId])).get(findingId);
  if (!record) return;
  await queueNotices(client, actor.tenantId, [
    {
      key: noticeKey(['finding.assigned', findingId, treatmentId]),
      recipientId: assigneeId,
      event: 'finding.assigned',
      record,
      by: actor.name,
      ownDoing: assigneeId === actor.id,
    },
  ]);
}

/**
 * The notices a safety-record decision causes, in its transaction: the actions a signature sets for a person who did
 * not hold them in the previous signed version, and the people an issue or a distribution asks to acknowledge it.
 */
export async function noticeSmsDecision(
  client: PoolClient,
  actor: AuthContext,
  record: SmsRecordRow,
  decision: SmsDecisionRecord,
): Promise<void> {
  const drafts: NoticeDraft[] = [];
  if (decision.kind === 'assurance.sign') {
    const signed = await signedVersions(client, actor.tenantId, record.id);
    const latest = signed.find((version) => version.decisionId === decision.id);
    const previous = signed.filter((version) => version.decisionId !== decision.id).at(-1);
    const closed = await closedActions(client, actor.tenantId, record.id);
    for (const action of latest?.body.actions ?? []) {
      if (closed.has(action.id)) continue;
      if (previous?.body.actions.find((held) => held.id === action.id)?.ownerId === action.ownerId) continue;
      drafts.push({
        key: noticeKey(['action.assigned', record.id, action.id, decision.id]),
        recipientId: action.ownerId,
        event: 'action.assigned',
        record: safetyNoticeRecord(record),
        actionId: action.id,
        dueOn: action.dueOn,
        by: actor.name,
        ownDoing: action.ownerId === actor.id,
      });
    }
  }
  if (decision.kind === 'document.issue' || decision.kind === 'document.distribute') {
    const outcome = decision.outcome as SmsDocumentIssueOutcome | SmsDocumentDistributionOutcome;
    const issueId =
      decision.kind === 'document.issue' ? decision.id : (outcome as SmsDocumentDistributionOutcome).issueId;
    for (const recipient of outcome.recipients)
      drafts.push({
        key: noticeKey(['document.acknowledgement', issueId]),
        recipientId: recipient.id,
        event: 'document.acknowledgement',
        record: safetyNoticeRecord(record, issueId),
        dueAt: outcome.acknowledgementDueAt,
        by: actor.name,
        ownDoing: recipient.id === actor.id,
      });
  }
  await queueNotices(client, actor.tenantId, drafts);
}
