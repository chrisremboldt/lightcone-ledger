import { expect } from 'vitest';
import type {
  SmsFindingPromotionResponse,
  SmsRecordDetailResponse,
  SmsSigningPreviewResponse,
} from '../../packages/contracts/src/index.js';

// A hazard on the safety record with an avoidance area accepted on it, through the commands a person uses: a safety
// lead opens the hazard (promoting a finding, or by hand), proposes the area and assesses the hazard on the adopted
// matrix; someone holding risk acceptance authority signs the acceptance after confirming locally that it is them.

/** Sends one request as a person; headers are added to the bearer token and a fresh idempotency key. */
export type PersonCall = (
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
  headers?: Record<string, string>,
) => Promise<{ statusCode: number; body: string; json: () => unknown }>;

export interface AreaControlPlan {
  safety: PersonCall;
  safetyId: string;
  acceptor: PersonCall;
  acceptorToken: string;
  /** Promote this finding; without one the hazard is identified by hand. */
  findingId?: string;
  title?: string;
  center: { latitude: number; longitude: number };
  radiusMeters: number;
  /** The reach the control declares, from the area's edge; without one it applies to every flight. */
  appliesWithinMeters?: number;
  effectiveFrom: string;
  effectiveUntil?: string;
}

export interface AcceptedAreaControlRecords {
  hazardId: string;
  controlId: string;
  assessmentId: string;
  acceptanceId: string;
}

async function ok<T>(response: Promise<{ statusCode: number; body: string; json: () => unknown }>, status = 200) {
  const resolved = await response;
  expect(resolved.statusCode, resolved.body).toBe(status);
  return resolved.json() as T;
}

export function readSafetyRecord(call: PersonCall, id: string): Promise<SmsRecordDetailResponse> {
  return ok<SmsRecordDetailResponse>(call('GET', `/v1/sms/records/${id}`));
}

function decide(record: SmsRecordDetailResponse, decision: Record<string, unknown>) {
  return {
    kind: 'decision.record',
    subject: { kind: 'sms', id: record.record.id },
    expectedRevision: record.basis.revision,
    expectedDependencyBasis: record.basis.dependencyBasis,
    decision,
  };
}

export async function openHazard(plan: AreaControlPlan): Promise<string> {
  const record = {
    kind: 'hazard',
    schema: 'sms.hazard.1',
    title: plan.title ?? 'Fictional hazard with an avoidance area',
    ownerId: plan.safetyId,
    body: {
      description: 'Identified on a fictional flight.',
      consequence: 'Loss of the fictional aircraft over people.',
      source: { kind: plan.findingId ? 'finding' : 'manual_identification' },
    },
  };
  let origin: Record<string, unknown> | undefined;
  if (plan.findingId) {
    const shown = await ok<SmsFindingPromotionResponse>(
      plan.safety('GET', `/v1/sms/findings/${plan.findingId}/promotion`),
    );
    origin = {
      kind: 'finding',
      findingId: plan.findingId,
      evaluationId: shown.origin.evaluationId,
      expectedDependencyBasis: shown.basis.dependencyBasis,
    };
  }
  const opened = await ok<{ command: { subject: { id: string } } }>(
    plan.safety('POST', '/v1/commands', { kind: 'sms.record.open', record, ...(origin ? { origin } : {}) }),
    201,
  );
  return opened.command.subject.id;
}

export async function proposeArea(plan: AreaControlPlan, hazardId: string): Promise<string> {
  const hazard = await readSafetyRecord(plan.safety, hazardId);
  const type = hazard.controlTypes!.find((entry) => entry.id === 'control.avoidance-area')!;
  const opened = await ok<{ command: { subject: { id: string } } }>(
    plan.safety('POST', '/v1/commands', {
      kind: 'sms.record.open',
      record: {
        kind: 'control',
        schema: 'sms.control.1',
        title: 'Keep routes clear of the fictional site',
        ownerId: plan.safetyId,
        body: {
          hazardId,
          controlType: { id: type.id, version: type.version, digest: type.digest },
          parameters: {
            center: plan.center,
            radiusMeters: plan.radiusMeters,
            ...(plan.appliesWithinMeters === undefined ? {} : { appliesWithinMeters: plan.appliesWithinMeters }),
          },
          effectiveFrom: plan.effectiveFrom,
          ...(plan.effectiveUntil ? { effectiveUntil: plan.effectiveUntil } : {}),
        },
      },
    }),
    201,
  );
  return opened.command.subject.id;
}

export async function assessWithControls(plan: AreaControlPlan, hazardId: string, controls: string[]): Promise<string> {
  const hazard = await readSafetyRecord(plan.safety, hazardId);
  await ok(
    plan.safety(
      'POST',
      '/v1/commands',
      decide(hazard, {
        kind: 'risk.assess',
        note: 'Assessed with the avoidance area in place.',
        matrix: { recordId: hazard.matrix!.record.id, versionNumber: hazard.matrix!.version.versionNumber },
        initial: { severity: 'major', likelihood: 'remote' },
        controls: controls.map((recordId) => ({
          recordId,
          versionNumber: hazard.controls!.find((control) => control.id === recordId)!.versionNumber,
        })),
        residual: { severity: 'minor', likelihood: 'remote' },
        newHazardCheck: { answer: 'none_identified' },
        ...(hazard.origin?.kind === 'finding' ? { evidence: { evaluationId: hazard.origin.evaluationId } } : {}),
      }),
    ),
    201,
  );
  return (await readSafetyRecord(plan.safety, hazardId)).decisions.find((decision) => decision.kind === 'risk.assess')!
    .id;
}

export async function acceptRisk(plan: AreaControlPlan, hazardId: string, assessmentId: string): Promise<string> {
  const signing = await ok<SmsSigningPreviewResponse>(
    plan.acceptor('GET', `/v1/sms/records/${hazardId}/signing?meaning=risk.accept`),
  );
  expect(signing.available, signing.reason).toBe(true);
  const grant = await ok<{ grant: string }>(
    plan.acceptor('POST', '/v1/local/reauthentications', { credential: plan.acceptorToken }),
    201,
  );
  const accepted = await ok<{ command: { id: string } }>(
    plan.acceptor(
      'POST',
      '/v1/commands',
      {
        kind: 'decision.record',
        subject: { kind: 'sms', id: hazardId },
        expectedRevision: signing.basis.revision,
        expectedDependencyBasis: signing.basis.dependencyBasis,
        decision: {
          kind: 'risk.accept',
          note: 'Residual risk accepted with the avoidance area in place.',
          assessmentId,
          signature: { intent: signing.intent!, contentDigest: signing.contentDigest!, reviewed: true },
        },
      },
      { 'x-ledger-reauthentication': grant.grant },
    ),
    201,
  );
  return accepted.command.id;
}

/** Opens the hazard, proposes the area, assesses with it in place and accepts the risk. */
export async function acceptedAreaControl(plan: AreaControlPlan): Promise<AcceptedAreaControlRecords> {
  const hazardId = await openHazard(plan);
  const controlId = await proposeArea(plan, hazardId);
  const assessmentId = await assessWithControls(plan, hazardId, [controlId]);
  const acceptanceId = await acceptRisk(plan, hazardId, assessmentId);
  return { hazardId, controlId, assessmentId, acceptanceId };
}
