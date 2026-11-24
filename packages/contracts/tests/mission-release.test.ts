import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { canonicalDigest } from '../../integrity/src/index.js';
import { capabilityValues, CommandSchema, FlightMissionReleaseParamsSchema } from '../src/index.js';
import { LedgerClient } from '../src/client.js';
import { CommandResponseSchema, openApiDocument, ResponseMetaSchema } from '../src/openapi.js';
import {
  MissionDepartureAcceptedCommandSchema,
  MissionDepartureAuthorizationCommandSchema,
  MissionDepartureAuthorizationResultSchema,
  MissionDepartureFitWitnessSchema,
  MissionDeparturePermitSchema,
  MissionDeparturePolicySchema,
  MissionReleaseCommandSchema,
  MissionReleaseAcceptedCommandSchema,
  MissionReleaseFindingsResponseSchema,
  MissionReleasePolicySchema,
  MissionReleaseRecordResponseSchema,
  MissionReleaseRecordSchema,
  MissionReleaseControlRecordContextSchema,
  MissionReleaseValidityResponseSchema,
} from '../src/mission-release.js';
import {
  missionDepartureAuthorization,
  missionDepartureAuthorizationResponse,
  missionDepartureAllocation,
  missionDepartureFitWitness,
  missionDeparturePermit,
  missionDeparturePolicy,
  missionReleaseAvoidance,
  missionReleaseCommand,
  missionReleaseFindingsResponse,
  missionReleaseCommandResponse,
  missionReleaseCases,
  missionReleasePolicy,
  missionReleaseRecord,
  missionReleaseRecordResponse,
  missionReleaseValidityChanged,
  missionReleaseValidityCurrent,
  missionReleaseValidityExpired,
  missionReleaseValidityPending,
  missionReleaseValidityScheduled,
} from '../fixtures/demo/v1/mission-release.js';
import {
  areaControlAcceptance,
  areaControlAssessment,
  areaControlBody,
  areaControlRecordId,
  areaControlVersion,
} from '../fixtures/demo/v1/area-control.js';
import { missionRevision2Record } from '../fixtures/demo/v1/missions.js';

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);

describe('recorded mission release handoff', () => {
  it('pins exact mission, policy, safety preimages and author authority inside a bounded departure window', () => {
    for (const [schema, value] of [
      [MissionReleasePolicySchema, missionReleasePolicy],
      [MissionReleaseCommandSchema, missionReleaseCommand],
      [MissionReleaseAcceptedCommandSchema, missionReleaseCommandResponse.command],
      [ResponseMetaSchema, missionReleaseCommandResponse.meta],
      [MissionReleaseRecordSchema, missionReleaseRecord],
      [MissionReleaseRecordResponseSchema, missionReleaseRecordResponse],
      [MissionReleaseFindingsResponseSchema, missionReleaseFindingsResponse],
    ] as const) {
      const validate = ajv.compile(schema);
      expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
    }
    const { digest, ...definition } = missionReleasePolicy;
    expect(digest).toBe(canonicalDigest(definition));
    const { digest: findingsDigest, ...findings } = missionReleaseRecord.basis.findings;
    expect(findingsDigest).toBe(canonicalDigest(findings));
    expect(missionReleaseCommand.expectedFindingsDigest).toBe(findingsDigest);
    expect(missionReleaseFindingsResponse.basis).toEqual(missionReleaseRecord.basis.findings);
    expect(missionReleaseFindingsResponse.proposed.every((finding) => !findings.findings.includes(finding))).toBe(true);
    // Only the current record and policy versions are release records.
    const validateRecord = ajv.compile(MissionReleaseRecordSchema);
    expect(validateRecord({ ...missionReleaseRecord, version: 'flight.mission-release.1' })).toBe(false);
    expect(ajv.compile(MissionReleasePolicySchema)({ ...missionReleasePolicy, version: 1 })).toBe(false);
    const record = missionReleaseRecord;
    expect(Object.keys(missionReleaseCommandResponse).sort()).toEqual(['command', 'meta']);
    expect(missionReleaseCommandResponse.command).toEqual({
      id: record.id,
      kind: missionReleaseCommand.kind,
      flightId: record.flightId,
      actorId: record.actor.id,
      recordedAt: record.recordedAt,
      payload: missionReleaseCommand,
    });
    expect(missionReleaseCommandResponse.meta.effectId).toBe(record.id);
    expect(missionReleaseRecordResponse).toEqual({ release: record, digest: canonicalDigest(record) });
    expect(record.policy).toEqual(missionReleasePolicy);
    expect(missionReleaseCommand.policy).toEqual({ id: record.policy.id, version: record.policy.version, digest });
    expect(missionReleaseCommand.flightId).toBe(record.flightId);
    expect(missionReleaseCommand.aircraftId).toBe(record.aircraftId);
    expect(record.basis.mission.flightId).toBe(record.flightId);
    expect(record.basis.mission.aircraftId).toBe(record.aircraftId);
    expect(record.basis.mission).toEqual(missionRevision2Record);
    expect(missionReleaseCommand.mission).toEqual({
      missionId: record.basis.mission.missionId,
      sourceRevision: record.basis.mission.sourceRevision,
      eventId: record.basis.mission.id,
      contentDigest: record.basis.mission.contentDigest,
      recordDigest: canonicalDigest(record.basis.mission),
    });
    expect(record.basis.avoidance).toEqual(missionReleaseAvoidance);
    expect(record.basis.avoidance.mission).toEqual(missionReleaseCommand.mission);
    expect(missionReleaseCommand.expectedContextDigest).toBe(record.basis.avoidance.contextDigest);
    const { id, version, digest: calculationDigest } = record.basis.avoidance.calculation;
    expect(missionReleaseCommand.calculation).toEqual({ id, version, digest: calculationDigest });
    expect(record.basis.avoidance.contextDigest).toBe(
      canonicalDigest({
        version: 'mission.avoidance-context.1',
        mission: record.basis.avoidance.mission,
        calculation: missionReleaseCommand.calculation,
        candidates: record.basis.avoidance.candidates,
        notApplicable: record.basis.avoidance.notApplicable,
        consideredTypes: record.basis.avoidance.consideredTypes,
        candidateCompleteness: record.basis.avoidance.candidateCompleteness,
      }),
    );
    const { previewDigest, ...preview } = record.basis.avoidance;
    expect(previewDigest).toBe(canonicalDigest(preview));
    expect(record.basis.candidateContexts).toHaveLength(record.basis.avoidance.candidates.length);
    const validateContext = ajv.compile(MissionReleaseControlRecordContextSchema);
    for (const candidate of record.basis.avoidance.candidates) {
      const retained = record.basis.candidateContexts.find(
        (entry) => entry.controlEventId === candidate.controlEventId && entry.acceptanceId === candidate.acceptance.id,
      )!;
      expect(retained).toBeDefined();
      expect(validateContext(retained.context), JSON.stringify(validateContext.errors)).toBe(true);
      expect(canonicalDigest(retained.context)).toBe(candidate.safetyContextDigest);
      expect(retained.context.assessment).toEqual(candidate.assessment);
      expect(candidate.controlEventId).toBe(areaControlVersion.id);
      expect(candidate.controlDigest).toBe(canonicalDigest(areaControlBody));
      expect(candidate.template).toEqual(areaControlBody.controlType);
      expect(candidate.assessment).toEqual({
        id: areaControlAssessment.id,
        acceptedRevision: areaControlAssessment.acceptedRevision,
        digest: canonicalDigest(areaControlAssessment.outcome),
      });
      expect(candidate.interval).toEqual({ start: areaControlBody.effectiveFrom, end: areaControlBody.effectiveUntil });
      expect(candidate.acceptance).toEqual({
        id: areaControlAcceptance.id,
        acceptedRevision: areaControlAcceptance.acceptedRevision,
        digest: areaControlAcceptance.signature.contentDigest,
      });
      expect(candidate.authority!.policyVersion).toBe('ledger.sms-decision-authority.1');
      expect(candidate.authority!.principalId).toBe(areaControlAcceptance.actor.principalId);
      expect(candidate.authority!.principalRevision).toBe(areaControlAcceptance.actor.principalRevision);
      expect(retained.context.version).toBe('mission.avoidance-control-record-context.1');
      expect(retained.context.hazard).toEqual({ id: candidate.hazardId, latestAcceptanceId: candidate.acceptance.id });
      expect(retained.context.control).toEqual({
        recordId: areaControlRecordId,
        versionNumber: candidate.controlVersion,
        status: 'open',
      });
      expect(candidate.context).toBe('current');
      expect(candidate.geometry).toBe('outside');
    }
    expect(record.actor.checkedCapabilities).toEqual(['decision:write', 'flight:read', 'mission:release']);
    expect(record.actor.capabilities).toEqual(expect.arrayContaining(record.actor.checkedCapabilities));
    expect(record.actor.policyVersion).toBe('ledger.mission-release-authority.1');
    expect(record.actor.scope).toEqual({ kind: 'flight', id: record.flightId });
    expect(record.actor.principalRevision).toBe(missionReleaseCommand.expectedPrincipalRevision);
    expect(record.basis.basisManifest.subjectId).toBe(record.flightId);
    expect(record.basis.basisManifest.principalId).toBe(record.actor.id);
    expect(record.basis.basisManifest.principalRevision).toBe(record.actor.principalRevision);
    expect(record.departureWindow).toEqual(missionReleaseCommand.departureWindow);
    expect(Date.parse(record.departureWindow.start)).toBeGreaterThanOrEqual(
      Date.parse(record.basis.mission.operatingInterval.start),
    );
    expect(Date.parse(record.departureWindow.end)).toBeLessThanOrEqual(
      Date.parse(record.basis.mission.operatingInterval.end),
    );
    expect(Date.parse(record.departureWindow.start)).toBeLessThan(Date.parse(record.departureWindow.end));
    expect(Date.parse(record.recordedAt)).toBeLessThan(Date.parse(record.departureWindow.end));
    expect(Date.parse(record.recordedAt)).toBeLessThan(Date.parse(record.departureWindow.start));
    expect(Date.parse(missionReleaseCases.windowOutsideMission.request.departureWindow.start)).toBeLessThan(
      Date.parse(record.basis.mission.operatingInterval.start),
    );
    expect(missionReleaseCases.windowOutsideMission.status).toBe(400);
    expect(missionReleaseCases.windowEmpty.request.departureWindow.start).toBe(
      missionReleaseCases.windowEmpty.request.departureWindow.end,
    );
    expect(missionReleaseCases.windowEmpty.status).toBe(400);
    const command = ajv.compile(MissionReleaseCommandSchema);
    expect(command({ ...missionReleaseCommand, tenantId: 'caller-cannot-select-tenant' })).toBe(false);
    expect(command({ ...missionReleaseCommand, expectedContextDigest: 'not-a-digest' })).toBe(false);
    expect(
      ajv.compile(MissionReleaseRecordSchema)({
        ...record,
        basis: {
          ...record.basis,
          avoidance: {
            ...record.basis.avoidance,
            candidates: record.basis.avoidance.candidates.map((candidate) => ({ ...candidate, context: 'pending' })),
          },
        },
      }),
    ).toBe(false);
  });

  it('keeps all five as-of validity states separate from the immutable acceptance', () => {
    const validate = ajv.compile(MissionReleaseValidityResponseSchema);
    const record = structuredClone(missionReleaseRecord);
    for (const [status, shown] of [
      ['scheduled', missionReleaseValidityScheduled],
      ['current', missionReleaseValidityCurrent],
      ['expired', missionReleaseValidityExpired],
      ['changed', missionReleaseValidityChanged],
      ['pending', missionReleaseValidityPending],
    ] as const) {
      expect(validate(shown), JSON.stringify(validate.errors)).toBe(true);
      expect(shown.status).toBe(status);
      expect(shown.release).toEqual({ id: record.id, digest: canonicalDigest(record) });
    }
    expect(Date.parse(missionReleaseValidityScheduled.evaluatedAt)).toBeLessThan(
      Date.parse(record.departureWindow.start),
    );
    expect(Date.parse(missionReleaseValidityCurrent.evaluatedAt)).toBeGreaterThanOrEqual(
      Date.parse(record.departureWindow.start),
    );
    expect(Date.parse(missionReleaseValidityCurrent.evaluatedAt)).toBeLessThan(Date.parse(record.departureWindow.end));
    expect(Date.parse(missionReleaseValidityExpired.evaluatedAt)).toBeGreaterThanOrEqual(
      Date.parse(record.departureWindow.end),
    );
    expect(missionReleaseValidityCurrent.currentContextDigest).toBe(record.basis.avoidance.contextDigest);
    expect(missionReleaseValidityChanged.currentContextDigest).not.toBe(record.basis.avoidance.contextDigest);
    expect(missionReleaseValidityPending.currentContextDigest).toBeNull();
    const higher = missionReleaseCases.higherFailedMission;
    expect(higher.acceptedSourceRevision).toBeGreaterThan(record.basis.mission.sourceRevision);
    expect(higher.acceptedMissionProcessing).toBe('failed');
    expect(validate(higher.validity), JSON.stringify(validate.errors)).toBe(true);
    expect(higher.validity.status).toBe('changed');
    expect(higher.validity.currentContextDigest).toBeNull();
    for (const replay of [missionReleaseCases.exactReplayAfterChange, missionReleaseCases.exactReplayAfterExpiry]) {
      expect(replay.status).toBe(201);
      expect(replay.request).toEqual(missionReleaseCommand);
      expect(replay.response.command).toEqual(missionReleaseCommandResponse.command);
      expect(ajv.compile(ResponseMetaSchema)(replay.response.meta)).toBe(true);
      expect(replay.response.meta.computedAt).toBe(replay.evaluatedAt);
      expect(replay.response.meta.requestId).not.toBe(missionReleaseCommandResponse.meta.requestId);
      expect(replay.recordRead).toEqual(missionReleaseRecordResponse);
      expect(replay.key).toBe(missionReleaseCases.exactReplayAfterChange.key);
    }
    expect(
      ajv.compile(MissionReleaseRecordResponseSchema)({
        ...missionReleaseRecordResponse,
        validity: missionReleaseValidityCurrent,
      }),
    ).toBe(false);
  });

  it('pins a nonrenewable flight lease and exact remaining-operation fit at consumption', () => {
    const { digest, ...definition } = missionDeparturePolicy;
    expect(digest).toBe(canonicalDigest(definition));
    expect(missionDeparturePolicy.authorization).toBe('finite_lease_at_authorized_at');
    expect(missionDeparturePolicy.replay).toBe('same_original_unexpired_lease');
    expect(missionDeparturePolicy.renewal).toBe('unsupported');
    expect(missionDeparturePolicy.uniqueness).toBe('tenant_flight_and_attempt_and_allocation');
    expect(missionDeparturePolicy.operationFit).toBe('producer_checks_before_authorization_and_at_consumption');
    const authorization = missionDepartureAuthorizationResponse.authorization;
    expect(Object.keys(missionDepartureAuthorizationResponse).sort()).toEqual(['authorization', 'command', 'meta']);
    expect(authorization).toEqual({
      permit: missionDeparturePermit,
      digest: canonicalDigest(missionDeparturePermit),
      evaluatedAt: missionDeparturePermit.authorizedAt,
      disposition: 'issued',
    });
    expect(missionDepartureAuthorizationResponse.command).toEqual({
      id: missionDeparturePermit.id,
      kind: missionDepartureAuthorization.kind,
      flightId: missionDeparturePermit.flightId,
      actorId: missionDeparturePermit.actor.id,
      recordedAt: missionDeparturePermit.authorizedAt,
      payload: { permit: missionDeparturePermit, digest: canonicalDigest(missionDeparturePermit) },
    });
    expect(missionDepartureAuthorizationResponse.meta.effectId).toBe(missionDeparturePermit.id);
    const replay = missionReleaseCases.safetyChangedUnexpiredReplay;
    expect(replay.request).toEqual(missionDepartureAuthorization);
    expect(replay.currentValidity.status).toBe('changed');
    expect(replay.currentValidity.currentContextDigest).not.toBe(missionDeparturePermit.contextDigest);
    expect(replay.currentPrincipalRevision).toBeGreaterThan(replay.request.expectedPrincipalRevision);
    expect(replay.status).toBe(201);
    expect(replay.response.command).toEqual(missionDepartureAuthorizationResponse.command);
    expect(replay.response.authorization).toEqual({
      ...authorization,
      evaluatedAt: replay.response.meta.computedAt,
      disposition: 'replayed',
    });
    expect(ajv.compile(MissionDepartureAuthorizationResultSchema)(replay.response.authorization)).toBe(true);
    expect(ajv.compile(ResponseMetaSchema)(replay.response.meta)).toBe(true);
    expect(replay.response.meta.inputCut.principalRevision).toBe(replay.currentPrincipalRevision);
    expect(Date.parse(replay.response.authorization.evaluatedAt)).toBeGreaterThan(
      Date.parse(replay.currentValidity.evaluatedAt),
    );
    expect(Date.parse(replay.response.authorization.evaluatedAt)).toBeLessThan(
      Date.parse(missionDeparturePermit.validUntil),
    );
    expect(missionDepartureAuthorization.release).toEqual({
      id: missionReleaseRecord.id,
      digest: canonicalDigest(missionReleaseRecord),
    });
    expect(missionDeparturePermit.release).toEqual(missionDepartureAuthorization.release);
    expect(missionDeparturePermit.mission).toEqual(missionReleaseCommand.mission);
    expect(missionDeparturePermit.contextDigest).toBe(missionReleaseCommand.expectedContextDigest);
    expect(missionDepartureAuthorization.allocation).toEqual({
      id: missionDepartureAllocation.id,
      digest: canonicalDigest(missionDepartureAllocation),
    });
    expect(missionDeparturePermit.allocation).toEqual(missionDepartureAuthorization.allocation);
    expect(missionDeparturePermit.departureAttemptId).toBe(missionDepartureAllocation.departureAttemptId);
    expect(missionDeparturePermit.actor.checkedCapabilities).toEqual([
      'decision:write',
      'flight:read',
      'mission:release',
    ]);
    expect(missionDeparturePermit.actor.policyVersion).toBe('ledger.mission-departure-authority.1');
    // The lease also ends at the next instant an accepted control starts or stops being in force.
    const boundary = [areaControlBody.effectiveFrom, areaControlBody.effectiveUntil]
      .map((at) => Date.parse(at))
      .filter((at) => at > Date.parse(missionDeparturePermit.authorizedAt))
      .sort((left, right) => left - right)[0];
    expect(Date.parse(missionDeparturePermit.validUntil)).toBe(
      Math.min(
        Date.parse(missionDeparturePermit.authorizedAt) + missionDeparturePolicy.permitSeconds * 1000,
        Date.parse(missionReleaseRecord.departureWindow.end),
        boundary ?? Infinity,
      ),
    );
    for (const bounds of missionReleaseCases.expiryBounds) {
      expect(Date.parse(bounds.validUntil)).toBe(
        Math.min(
          Date.parse(bounds.authorizedAt) + 30000,
          Date.parse(bounds.releaseEnd),
          Date.parse(bounds.selectionBoundary),
        ),
      );
      expect(Date.parse(bounds.validUntil)).toBeGreaterThan(Date.parse(bounds.authorizedAt));
    }
    const retry = missionReleaseCases.expiredRetry;
    expect(retry.request).toEqual(missionDepartureAuthorization);
    expect(Date.parse(retry.evaluatedAt)).toBeGreaterThanOrEqual(
      Date.parse(retry.priorResponse.authorization.permit.validUntil),
    );
    expect(retry.status).toBe(409);
    expect(retry.code).toBe('departure_permit_expired');
    expect(retry.key).toBe(replay.key);
    expect(retry.priorResponse).toEqual(missionDepartureAuthorizationResponse);
    expect(retry.priorResponse.authorization.digest).toBe(canonicalDigest(retry.priorResponse.authorization.permit));
    expect('response' in retry).toBe(false);
    const reused = missionReleaseCases.allocationReusedForNewAttempt;
    expect(reused.request.allocation).toEqual(reused.original.allocation);
    expect(reused.request.departureAttemptId).not.toBe(reused.original.departureAttemptId);
    expect(reused.key).not.toBe(retry.key);
    expect(reused.status).toBe(409);
    expect(reused.code).toBe('departure_allocation_conflict');
    const changed = missionReleaseCases.changedAllocation;
    expect(changed.request.departureAttemptId).toBe(changed.original.departureAttemptId);
    expect(changed.request.allocation).not.toEqual(changed.original.allocation);
    expect(changed.status).toBe(409);
    expect(changed.code).toBe('departure_attempt_conflict');
    const second = missionReleaseCases.secondAuthorizationSameFlight;
    expect(second.request.flightId).toBe(missionDeparturePermit.flightId);
    expect(second.request.departureAttemptId).not.toBe(missionDeparturePermit.departureAttemptId);
    expect(second.request.allocation.id).not.toBe(missionDeparturePermit.allocation.id);
    expect(second.key).not.toBe(replay.key);
    expect(Date.parse(second.evaluatedAt)).toBeGreaterThan(Date.parse(missionDeparturePermit.validUntil));
    expect(second.status).toBe(409);
    expect(second.code).toBe('departure_flight_already_authorized');
    const unused = missionReleaseCases.unusedExpiredPermit;
    expect(unused.permit).toEqual(missionDeparturePermit);
    expect(unused.evaluatedAt).toBe(unused.permit.validUntil);
    expect(unused.consumed).toBe(false);
    expect(unused.outcome).toBe('held');
    expect(unused.replacementSupported).toBe(false);

    const consume = missionReleaseCases.callerConsumption;
    const fit = missionDepartureFitWitness;
    const validateFit = ajv.compile(MissionDepartureFitWitnessSchema);
    expect(validateFit(fit), JSON.stringify(validateFit.errors)).toBe(true);
    expect(validateFit({ ...fit, marginMs: 0 })).toBe(false);
    expect(fit.permit).toEqual({ id: missionDeparturePermit.id, digest: canonicalDigest(missionDeparturePermit) });
    expect(consume.fitWitness).toEqual(fit);
    expect(consume.mission).toEqual(fit.mission);
    expect(consume.mission).toEqual(missionDeparturePermit.mission);
    expect(consume.mission.recordDigest).toBe(canonicalDigest(missionRevision2Record));
    expect(consume.aircraftId).toBe(fit.aircraftId);
    expect(consume.aircraftId).toBe(missionDeparturePermit.aircraftId);
    expect(consume.route).toEqual(missionRevision2Record.route);
    expect(consume.allocation).toEqual(missionDepartureAllocation);
    expect(canonicalDigest(consume.allocation)).toBe(missionDeparturePermit.allocation.digest);
    for (const interval of [
      { start: missionDeparturePermit.authorizedAt, end: missionDeparturePermit.validUntil },
      missionRevision2Record.operatingInterval,
      consume.allocation.interval,
    ]) {
      expect(Date.parse(fit.evaluatedAt)).toBeGreaterThanOrEqual(Date.parse(interval.start));
      expect(Date.parse(fit.evaluatedAt)).toBeLessThan(Date.parse(interval.end));
    }
    const duration = fit.remainingDurationMs + fit.holdAllowanceMs + fit.marginMs;
    expect(Number.isSafeInteger(duration)).toBe(true);
    expect(Date.parse(fit.requiredCompletionAt)).toBe(Date.parse(fit.evaluatedAt) + duration);
    expect(Date.parse(fit.requiredCompletionAt)).toBeLessThanOrEqual(
      Date.parse(missionRevision2Record.operatingInterval.end),
    );
    expect(Date.parse(fit.requiredCompletionAt)).toBeGreaterThan(Date.parse(missionDeparturePermit.validUntil));
    expect(consume.oncePerFlight).toEqual({
      tenantId: consume.allocation.tenantId,
      flightId: missionDeparturePermit.flightId,
    });
    expect(consume.atomicCommit).toEqual({
      retains: ['fit_witness', 'once_per_flight_consumption', 'physical_transition'],
      permit: fit.permit,
      consumedAt: fit.evaluatedAt,
      physicalTransition: { activity: 'airborne', departedAt: fit.evaluatedAt },
    });
    expect(consume.restart).toBe('resume_same_transition_without_another_departure');
    for (const precheck of [missionReleaseCases.operationPrecheck, missionReleaseCases.insufficientRemainingFit]) {
      expect(precheck.evaluatedAt).toBe(missionDeparturePermit.authorizedAt);
      expect(precheck.leaseHandoffAllowanceMs).toBe(missionDeparturePolicy.permitSeconds * 1000);
      expect(Date.parse(precheck.requiredCompletionAt)).toBe(
        Date.parse(precheck.evaluatedAt) +
          precheck.remainingDurationMs +
          precheck.holdAllowanceMs +
          precheck.marginMs +
          precheck.leaseHandoffAllowanceMs,
      );
    }
    expect(Date.parse(missionReleaseCases.operationPrecheck.requiredCompletionAt)).toBeLessThanOrEqual(
      Date.parse(missionRevision2Record.operatingInterval.end),
    );
    const insufficient = missionReleaseCases.insufficientRemainingFit;
    expect(Date.parse(insufficient.requiredCompletionAt)).toBeGreaterThan(Date.parse(insufficient.missionEnd));
    expect(insufficient.sent).toBe(false);
    expect(insufficient.outcome).toBe('held');
    expect(insufficient.nextAction).toBe('replan_and_release_before_authorization');
    expect('status' in insufficient).toBe(false);
  });

  it('serves release reads and departure commands with the original authorization on replay', async () => {
    for (const [schema, value] of [
      [MissionDeparturePolicySchema, missionDeparturePolicy],
      [MissionDepartureAuthorizationCommandSchema, missionDepartureAuthorization],
      [MissionDeparturePermitSchema, missionDeparturePermit],
      [MissionDepartureFitWitnessSchema, missionDepartureFitWitness],
      [MissionDepartureAcceptedCommandSchema, missionDepartureAuthorizationResponse.command],
      [MissionDepartureAuthorizationResultSchema, missionDepartureAuthorizationResponse.authorization],
      [ResponseMetaSchema, missionDepartureAuthorizationResponse.meta],
    ] as const) {
      const validate = ajv.compile(schema);
      expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
    }
    const command = ajv.compile(CommandSchema);
    expect(command(missionReleaseCommand), JSON.stringify(command.errors)).toBe(true);
    expect(command(missionDepartureAuthorization), JSON.stringify(command.errors)).toBe(true);
    expect(capabilityValues).toContain('mission:release');
    expect(Object.keys(openApiDocument.paths).filter((path) => /mission.*(?:release|departure)/.test(path))).toEqual([
      '/v1/flights/{id}/mission-releases/{releaseId}',
      '/v1/flights/{id}/mission-release-findings',
      '/v1/flights/{id}/mission-releases/{releaseId}/validity',
    ]);
    const response = ajv.compile(CommandResponseSchema);
    for (const value of [
      missionReleaseCommandResponse,
      missionDepartureAuthorizationResponse,
      missionReleaseCases.safetyChangedUnexpiredReplay.response,
    ])
      expect(response(value), JSON.stringify(response.errors)).toBe(true);
    const params = ajv.compile(FlightMissionReleaseParamsSchema);
    expect(params({ id: 'flight/one', releaseId: 'release/one' })).toBe(true);
    expect(params({ id: 'flight/one' })).toBe(false);
    const paths: string[] = [];
    const submissions: { body: unknown; key: string | null }[] = [];
    const client = new LedgerClient('https://ledger.invalid', 'fixture-token', async (input, init) => {
      const url = String(input);
      paths.push(url);
      if (url.endsWith('/v1/commands')) {
        submissions.push({
          body: JSON.parse(String(init?.body)),
          key: new Headers(init?.headers).get('idempotency-key'),
        });
        return Response.json(
          submissions.length === 1
            ? missionDepartureAuthorizationResponse
            : missionReleaseCases.safetyChangedUnexpiredReplay.response,
        );
      }
      return Response.json(url.endsWith('/validity') ? missionReleaseValidityCurrent : missionReleaseRecordResponse);
    });
    expect(await client.missionRelease('flight/one', 'release/one')).toEqual(missionReleaseRecordResponse);
    expect(await client.missionReleaseValidity('flight/one', 'release/one')).toEqual(missionReleaseValidityCurrent);
    expect(paths).toEqual([
      'https://ledger.invalid/v1/flights/flight%2Fone/mission-releases/release%2Fone',
      'https://ledger.invalid/v1/flights/flight%2Fone/mission-releases/release%2Fone/validity',
    ]);
    const key = missionReleaseCases.safetyChangedUnexpiredReplay.key;
    const issued = await client.command(missionDepartureAuthorization, key);
    const replayed = await client.command(missionDepartureAuthorization, key);
    expect(issued.authorization).toEqual(missionDepartureAuthorizationResponse.authorization);
    expect(replayed.authorization).toEqual(missionReleaseCases.safetyChangedUnexpiredReplay.response.authorization);
    expect(submissions).toEqual([
      { body: missionDepartureAuthorization, key },
      { body: missionDepartureAuthorization, key },
    ]);
    expect(paths.slice(-2)).toEqual(['https://ledger.invalid/v1/commands', 'https://ledger.invalid/v1/commands']);
  });
});
