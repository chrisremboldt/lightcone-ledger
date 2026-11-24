import { expect, test } from 'vitest';
import { canonicalDigest as retainedDigest } from '../../packages/integrity/src/index.js';
import {
  areaControlAcceptance,
  areaControlBody,
  areaControlContext,
} from '../../packages/contracts/fixtures/demo/v1/area-control.js';
import {
  adoptedCommandLinkFinding,
  draftCommandLinkFinding,
} from '../../packages/contracts/fixtures/demo/v1/c2-execution.js';
import {
  landingDisagreementEvaluation,
  landingDisagreementRuleEvaluation,
  landingReportObservations,
} from '../../packages/contracts/fixtures/demo/v1/landing-hazards.js';
import type {
  AcceptedObservation,
  EvaluationRecord,
  RuleEvaluationExplanation,
} from '../../packages/contracts/src/index.js';
import {
  canonicalDigest,
  isLandingDisagreementFinding,
  landingReportRows,
  safetyFindingOrigin,
} from '../../apps/web/src/safety.js';

test('browser pins match the complete retained record digests', async () => {
  for (const record of [areaControlBody, areaControlAcceptance, areaControlContext]) {
    const reordered = Object.fromEntries(Object.entries(record).reverse());
    expect(await canonicalDigest(reordered)).toBe(retainedDigest(record));
  }
  const parameters = { ...areaControlBody.parameters, radiusMeters: areaControlBody.parameters.radiusMeters + 1 };
  expect(await canonicalDigest({ ...areaControlBody, parameters })).not.toBe(retainedDigest(areaControlBody));
});

test('safety discovery matches the exact C2 origin versions and disagreeing reports by the check, not the rule', () => {
  const commandLink = draftCommandLinkFinding.latestEvaluation;
  const landing: EvaluationRecord = landingDisagreementRuleEvaluation;
  expect(safetyFindingOrigin(commandLink)).toBe('command_link');
  expect(safetyFindingOrigin(landing)).toBe('landing_disagreement');
  expect(isLandingDisagreementFinding(landing)).toBe(true);
  // Any rule whose check compares reported values is shown the same way; its id and versions do not matter, and a
  // later evaluation that finds the reports agree keeps the presentation.
  expect(
    safetyFindingOrigin({
      ...landing,
      outcome: 'pass',
      explanation: { ...landingDisagreementRuleEvaluation.explanation, code: 'values_agree' },
    }),
  ).toBe('landing_disagreement');
  expect(safetyFindingOrigin({ ...landing, leafId: 'another.rule', leafVersion: 7, bindingVersion: 9 })).toBe(
    'landing_disagreement',
  );
  for (const unsupported of [
    landingDisagreementEvaluation,
    {
      ...landing,
      explanation: {
        ...landingDisagreementRuleEvaluation.explanation,
        ruleEvaluation: {
          ...landingDisagreementRuleEvaluation.explanation.ruleEvaluation,
          check: { kind: 'evidence.due', version: 1 },
        },
      },
    },
    { ...commandLink, leafVersion: 2 },
  ]) {
    expect(safetyFindingOrigin(unsupported)).toBeNull();
    expect(isLandingDisagreementFinding(unsupported)).toBe(false);
  }
});

test('landing report rows read each cited observation’s compared value without selecting a latest time', () => {
  const evaluation: EvaluationRecord = structuredClone(landingDisagreementRuleEvaluation);
  const retained = structuredClone(evaluation);
  const unreadable: AcceptedObservation = {
    ...structuredClone(landingReportObservations[1]!),
    id: 'retained-unreadable-landing',
    eventId: 'retained-unreadable-landing',
    sourceId: 'ground-note',
  };
  (unreadable.observation.values as Record<string, unknown>).landingAt = 'after handover';
  const explanation = evaluation.explanation as RuleEvaluationExplanation;
  explanation.evidence.push({
    eventId: unreadable.eventId,
    receiptId: unreadable.receiptId,
    sourceId: unreadable.sourceId,
    occurredAt: unreadable.occurredAt,
    observationId: unreadable.id,
    type: 'flight.report',
    version: 1,
  });
  const rows = landingReportRows(evaluation, [...landingReportObservations, unreadable]);
  expect(rows.map(({ sourceId, value, reportedTime, field }) => ({ sourceId, value, reportedTime, field }))).toEqual([
    {
      sourceId: 'aircraft-log',
      value: '2026-10-16T14:12:00.000Z',
      reportedTime: '2026-10-16T14:12:00.000Z',
      field: 'values.landingAt',
    },
    {
      sourceId: 'ground-log',
      value: '2026-10-16T14:13:00.000Z',
      reportedTime: '2026-10-16T14:13:00.000Z',
      field: 'values.landingAt',
    },
    { sourceId: 'ground-note', value: 'after handover', reportedTime: null, field: 'values.landingAt' },
  ]);
  // An observation the evaluation does not cite is never shown.
  expect(landingReportRows(retained, landingReportObservations.slice(0, 1))).toHaveLength(1);
  expect(landingReportRows(draftCommandLinkFinding.latestEvaluation, landingReportObservations)).toEqual([]);
});
