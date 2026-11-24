import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import {
  CommandSchema,
  SmsDecisionCommandSchema,
  SmsRecordOpenCommandSchema,
  UploadCreateSchema,
} from '../../packages/contracts/src/index.js';
import { exampleRiskMatrix } from '../../packages/domain/src/sms-example-matrix.js';
import { notAcceptableWords } from '../../packages/domain/src/sms-decisions.js';
import {
  coveringRiskCapability,
  evaluateRiskMatrix,
  highestRiskAuthority,
  riskMatrixProblems,
} from '../../packages/domain/src/sms-matrix.js';

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const hazard = {
  kind: 'sms.record.open',
  record: {
    kind: 'hazard',
    schema: 'sms.hazard.1',
    title: 'Loss of link near energized line',
    ownerId: 'person-1',
    body: {
      description: 'Link degrades near the river crossing.',
      consequence: 'Uncontrolled descent onto a conductor.',
      source: { kind: 'manual_identification' },
    },
  },
};

describe('tenant risk matrix evaluation', () => {
  it('computes each level from the retained 5×5 cells', () => {
    expect(riskMatrixProblems(exampleRiskMatrix)).toEqual([]);
    expect(evaluateRiskMatrix(exampleRiskMatrix, { severity: 'catastrophic', likelihood: 'probable' })?.level).toBe(
      'high',
    );
    expect(evaluateRiskMatrix(exampleRiskMatrix, { severity: 'major', likelihood: 'remote' })?.level).toBe('medium');
    expect(evaluateRiskMatrix(exampleRiskMatrix, { severity: 'minimal', likelihood: 'remote' })?.level).toBe('low');
    expect(evaluateRiskMatrix(exampleRiskMatrix, { severity: 'unknown', likelihood: 'remote' })).toBeUndefined();
  });

  it('rejects a matrix with a missing or duplicated cell', () => {
    const missing = { ...exampleRiskMatrix, cells: exampleRiskMatrix.cells.slice(1) };
    expect(riskMatrixProblems(missing)).toContain('Every severity and likelihood combination needs exactly one level.');
    const duplicated = {
      ...exampleRiskMatrix,
      cells: [...exampleRiskMatrix.cells.slice(1), exampleRiskMatrix.cells[1]],
    };
    expect(riskMatrixProblems(duplicated).join(' ')).toMatch(/defined twice/);
  });

  it('lets higher risk authority cover lower levels but never the reverse', () => {
    expect(coveringRiskCapability('medium', ['risk:accept:high'])).toBe('risk:accept:high');
    expect(coveringRiskCapability('medium', ['risk:accept:low', 'risk:accept:medium'])).toBe('risk:accept:medium');
    expect(coveringRiskCapability('high', ['risk:accept:low', 'risk:accept:medium'])).toBeUndefined();
    expect(coveringRiskCapability('low', ['decision:write', 'authority:write'])).toBeUndefined();
    expect(coveringRiskCapability('low', ['risk:accept:high', 'risk:accept:low'])).toBe('risk:accept:low');
    expect(highestRiskAuthority(['risk:accept:low', 'risk:accept:medium'])).toBe('medium');
    expect(highestRiskAuthority(['sms:read'])).toBeNull();
    expect(coveringRiskCapability('not_acceptable', ['risk:accept:high'])).toBeUndefined();
  });

  it("computes an organization's own levels, and says in its words when nobody may accept one", () => {
    const bands = structuredClone(exampleRiskMatrix);
    bands.name = 'Band matrix';
    bands.levels = [
      { id: 'green', label: 'Green', meaning: 'Carry on.', acceptance: 'low' },
      { id: 'yellow', label: 'Yellow', meaning: 'Written sign-off.', acceptance: 'high' },
      { id: 'orange', label: 'Orange', meaning: 'Mitigate first.', acceptance: 'high' },
      { id: 'red', label: 'Red', meaning: 'Stop the affected operation.', acceptance: 'not_acceptable' },
    ];
    const band = { low: 'green', medium: 'yellow', high: 'orange' } as Record<string, string>;
    bands.cells = bands.cells.map((cell) => ({
      ...cell,
      level: cell.severity === 'catastrophic' && cell.likelihood === 'frequent' ? 'red' : band[cell.level]!,
    }));
    expect(riskMatrixProblems(bands)).toEqual([]);
    expect(evaluateRiskMatrix(bands, { severity: 'catastrophic', likelihood: 'frequent' })).toEqual({
      severity: 'catastrophic',
      likelihood: 'frequent',
      level: 'red',
      acceptance: 'not_acceptable',
    });
    expect(evaluateRiskMatrix(bands, { severity: 'minimal', likelihood: 'remote' })?.acceptance).toBe('low');
    expect(notAcceptableWords(bands, 'red')).toBe(
      '“Band matrix” says Red risk may not be accepted: Stop the affected operation. Reassess it with further controls',
    );
  });
});

describe('SMS envelope schemas', () => {
  const open = ajv.compile(SmsRecordOpenCommandSchema);
  const decision = ajv.compile(SmsDecisionCommandSchema);
  const commands = ajv.compile(CommandSchema);
  const uploads = ajv.compile(UploadCreateSchema);

  it('accepts a manually identified hazard through the shared command route', () => {
    expect(open(hazard), JSON.stringify(open.errors)).toBe(true);
    expect(commands(hazard)).toBe(true);
    expect(open({ ...hazard, confidentiality: 'restricted_asset_information' })).toBe(true);
    expect(open({ ...hazard, confidentiality: 'secret' })).toBe(false);
    expect(open({ ...hazard, record: { ...hazard.record, status: 'accepted' } })).toBe(false);
    expect(open({ ...hazard, record: { ...hazard.record, body: { ...hazard.record.body, flightId: 'f' } } })).toBe(
      false,
    );
  });

  it('takes a typed hazard origin and flight or finding link targets', () => {
    const basis = 'a'.repeat(64);
    const fromFinding = {
      ...hazard,
      record: { ...hazard.record, body: { ...hazard.record.body, source: { kind: 'finding' } } },
      origin: { kind: 'finding', findingId: 'finding-1', evaluationId: 'evaluation-1', expectedDependencyBasis: basis },
    };
    expect(open(fromFinding), JSON.stringify(open.errors)).toBe(true);
    expect(open({ ...hazard, origin: { kind: 'report', recordId: 'report-1', versionNumber: 1 } })).toBe(true);
    expect(open({ ...hazard, origin: { kind: 'manual' } })).toBe(true);
    // The rule, subject and digest come from Ledger, never from the client.
    expect(open({ ...fromFinding, origin: { ...fromFinding.origin, rule: { ruleId: 'r' } } })).toBe(false);
    expect(open({ ...fromFinding, origin: { kind: 'finding', findingId: 'finding-1' } })).toBe(false);
    const linked = (target: Record<string, unknown>) => ({
      ...hazard,
      record: { ...hazard.record, links: [{ relation: 'derived_from', target }] },
    });
    expect(open(linked({ kind: 'flight', id: 'flight-1' }))).toBe(true);
    expect(open(linked({ kind: 'finding', id: 'finding-1' }))).toBe(true);
    expect(open(linked({ kind: 'finding', id: 'finding-1', label: 'x' }))).toBe(false);
    const assess = {
      kind: 'decision.record',
      subject: { kind: 'sms', id: 'hazard-1' },
      expectedRevision: 1,
      expectedDependencyBasis: basis,
      decision: {
        kind: 'risk.assess',
        note: 'Assessed.',
        matrix: { recordId: 'matrix-1', versionNumber: 1 },
        initial: { severity: 'major', likelihood: 'remote' },
        controls: [],
        residual: { severity: 'minor', likelihood: 'remote' },
        newHazardCheck: { answer: 'none_identified' },
        evidence: { evaluationId: 'evaluation-1' },
      },
    };
    expect(decision(assess), JSON.stringify(decision.errors)).toBe(true);
    expect(decision({ ...assess, decision: { ...assess.decision, evidence: { evaluationDigest: basis } } })).toBe(
      false,
    );
  });

  it('accepts only a complete 5×5 matrix body', () => {
    const matrix = { ...hazard, record: { ...hazard.record, kind: 'risk_matrix', schema: 'sms.risk-matrix.1' } };
    expect(open({ ...matrix, record: { ...matrix.record, body: exampleRiskMatrix } })).toBe(true);
    const fourByFive = { ...exampleRiskMatrix, severities: exampleRiskMatrix.severities.slice(1) };
    expect(open({ ...matrix, record: { ...matrix.record, body: fourByFive } })).toBe(false);
  });

  it('never lets a client choose a risk level or omit what was signed', () => {
    const assessment = {
      kind: 'decision.record',
      subject: { kind: 'sms', id: 'hazard-1' },
      expectedRevision: 2,
      expectedDependencyBasis: 'a'.repeat(64),
      decision: {
        kind: 'risk.assess',
        note: 'Assessed.',
        matrix: { recordId: 'matrix-1', versionNumber: 1 },
        initial: { severity: 'major', likelihood: 'remote' },
        controls: [{ recordId: 'control-1', versionNumber: 1 }],
        residual: { severity: 'minor', likelihood: 'remote' },
        newHazardCheck: { answer: 'none_identified' },
      },
    };
    expect(decision(assessment), JSON.stringify(decision.errors)).toBe(true);
    // Controls are records cited by version; a free-text control with a fixed type is no longer accepted.
    expect(
      decision({
        ...assessment,
        decision: { ...assessment.decision, controls: [{ type: 'procedure', description: 'Brief the crew.' }] },
      }),
    ).toBe(false);
    expect(
      decision({
        ...assessment,
        decision: { ...assessment.decision, residual: { severity: 'minor', likelihood: 'remote', level: 'low' } },
      }),
    ).toBe(false);
    const acceptance = {
      ...assessment,
      decision: {
        kind: 'risk.accept',
        note: 'Accepted.',
        assessmentId: 'decision-1',
        signature: { intent: 'I accept.', contentDigest: 'b'.repeat(64), reviewed: true },
      },
    };
    expect(decision(acceptance)).toBe(true);
    expect(decision({ ...acceptance, decision: { ...acceptance.decision, signature: undefined } })).toBe(false);
    expect(
      decision({
        ...acceptance,
        decision: { ...acceptance.decision, signature: { ...acceptance.decision.signature, reviewed: false } },
      }),
    ).toBe(false);
  });

  it('accepts SMS documentation and generic status decisions on the same envelope', () => {
    const policy = {
      ...hazard,
      record: {
        ...hazard.record,
        kind: 'document',
        schema: 'sms.document.1',
        body: { documentType: 'safety_policy', revisionLabel: 'Revision 1', summary: 'Objectives and commitment.' },
      },
    };
    expect(open(policy), JSON.stringify(open.errors)).toBe(true);
    expect(
      open({ ...policy, record: { ...policy.record, body: { ...policy.record.body, documentType: 'memo' } } }),
    ).toBe(false);
    const status = {
      kind: 'decision.record',
      subject: { kind: 'sms', id: 'hazard-1' },
      expectedRevision: 3,
      expectedDependencyBasis: 'c'.repeat(64),
      decision: { kind: 'record.close', note: 'Operation discontinued.' },
    };
    expect(decision(status)).toBe(true);
    expect(decision({ ...status, decision: { ...status.decision, kind: 'record.delete' } })).toBe(false);
  });

  it('fixes upload confidentiality to the declared classes', () => {
    expect(uploads({ contentType: 'text/plain', byteLength: 4, confidentiality: 'restricted_asset_information' })).toBe(
      true,
    );
    expect(uploads({ contentType: 'text/plain', byteLength: 4, confidentiality: 'internal' })).toBe(false);
  });
});
