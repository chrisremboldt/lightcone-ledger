import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { describe, expect, test } from 'vitest';
import {
  CommandSchema,
  FindingPacketSchema,
  HazardOriginSchema,
  InputSchema,
  isCheckedRuleLeaf,
  observationRegistryV1,
  registerObservationType,
  subjectReferenceKey,
  type RuleEvaluationRecord,
  type SmsDecisionRecord,
  type SubjectReference,
} from '../../packages/contracts/src/index.js';
import { canonicalDigest, canonicalize } from '../../packages/integrity/src/index.js';
import { findCheckKind } from '../../packages/domain/src/check-kinds.js';
import {
  adoptionParameterProblem,
  defineCheckedRule,
  runCheckedRule,
} from '../../packages/domain/src/checked-rules.js';
import { getRulePackVersion, registerRulePack } from '../../packages/domain/src/rule-pack-registry.js';
import {
  calculateIndicator,
  defineIndicator,
  findIndicatorDefinition,
  registerIndicatorDefinition,
} from '../../packages/domain/src/indicators.js';
import {
  observationRegistry,
  registerObservationTypes,
  validateObservation,
} from '../../packages/domain/src/observation-registry.js';
import { findingOrigin, ruleEvaluationView } from '../../packages/domain/src/sms-origins.js';
import {
  controlParameterProblem,
  controlTypeDigest,
  registerControlType,
  registeredControlTypeDigest,
  type ControlType,
} from '../../packages/domain/src/control-types.js';
import { assessedControlEntry } from '../../packages/domain/src/sms-controls.js';
import { riskAcceptanceContent } from '../../packages/domain/src/sms-decisions.js';
import { exampleRiskMatrix } from '../../packages/domain/src/sms-example-matrix.js';
import { coveringRiskCapability, evaluateRiskMatrix } from '../../packages/domain/src/sms-matrix.js';
import { assembleFindingPacket } from '../../packages/evidence/src/finding-packet-assembly.js';
import { toyFinding, toyIssue, verifyOffline } from './finding-packet-fixture.js';
import { forbiddenLiterals, repositoryRoot, scanSource } from './generalisation-guard-scan.js';
import { rotorIcingObservation, rotorIcingType } from './rotor-icing-observation.js';

// A toy control for the toy problem: run the rotor heater before flight. Nothing in core code knows it.
const rotorHeaterControlType: ControlType<{ aircraftId: string; minimumMinutes: number }> = {
  id: 'toy.rotor-heater-run',
  version: 1,
  title: 'Toy rotor heater run',
  description: 'Run the fictional rotor heater for a minimum time before flight.',
  appliesTo: ['aircraft', 'time_window'],
  parameterSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['aircraftId', 'minimumMinutes'],
    properties: {
      aircraftId: { type: 'string', minLength: 1, maxLength: 200 },
      minimumMinutes: { type: 'integer', minimum: 1, maximum: 60 },
    },
  },
  checkedAutomatically: true,
  describe: ({ aircraftId, minimumMinutes }) => `Run the rotor heater on ${aircraftId} for ${minimumMinutes} minutes`,
};

// A made-up problem type, rotor icing, registered end to end through public extension points only: no core
// file may change to add it. Each step stays a todo until the named issue lands; that issue replaces its todo
// with a real test against the published extension point.
describe('a made-up problem type is addable through public extension points only', () => {
  test('intake: a toy rotor-icing observation type is accepted by the generic intake contract and validator once registered', () => {
    const observation = rotorIcingObservation();
    // The public input contract already admits it: kind observation, payload is the observation.
    const ajv = new Ajv({ strict: false });
    (addFormats as unknown as (instance: Ajv) => void)(ajv);
    const input = {
      sourceId: 'toy-icing-sensor',
      kind: 'observation',
      occurredAt: observation.occurredAt,
      payload: observation,
    };
    expect(ajv.validate(InputSchema, input), JSON.stringify(ajv.errors)).toBe(true);
    // Unknown until registered, through the public registry function, then valid with no intake change.
    expect(() => validateObservation(observationRegistryV1, observation)).toThrow(/not registered/);
    const registry = registerObservationType(observationRegistryV1, rotorIcingType());
    expect(validateObservation(registry, observation).definition.type).toBe('rotor.icing');
    // The process registry acceptInput reads is extended the same way (the database-backed acceptance is in
    // tests/integration/observations.integration.test.ts).
    registerObservationTypes(rotorIcingType());
    expect(validateObservation(observationRegistry(), observation).definition.type).toBe('rotor.icing');
    expect(() =>
      validateObservation(observationRegistry(), rotorIcingObservation({ values: { severity: 'extreme' } })),
    ).toThrow(/severity must be one of/);
  });
  test('evaluator: a toy rule in its own pack, using a library check kind, needs attention for the observation', () => {
    const type = 'rotor.icing-evaluated';
    registerObservationTypes(rotorIcingType(type));
    // The rule is data: a pinned procedure text, the observations it reads and a library check kind.
    const leaf = defineCheckedRule({
      id: 'toy.rotor-icing-temperature',
      version: 1,
      title: 'Outside air stays above the icing floor',
      source: {
        kind: 'operator_procedure',
        reference: 'Toy procedure 1',
        text: 'Do not continue while the outside air is at or below the icing floor.',
      },
      target: { subjectKind: 'aircraft' },
      reads: [{ name: 'subject', type, versions: [1], about: 'target', required: true, select: 'latest' }],
      check: {
        kind: findCheckKind('value.within-limit', 1)!,
        params: { field: 'values.outsideAirTemperatureCelsius', comparison: 'above' },
      },
      adoptionParameters: [{ name: 'limit', title: 'Icing floor (Celsius)', valueType: 'number' }],
    });
    const content = {
      packId: 'toy.rotor-icing',
      version: 1,
      title: 'Toy rotor icing procedures',
      status: 'draft' as const,
      review: 'ai_drafted' as const,
      adopted: false as const,
      bindings: [],
      leaves: [leaf],
    };
    registerRulePack({ packId: content.packId, versions: [{ ...content, digest: canonicalDigest(content) }] });
    const pack = getRulePackVersion(content.packId, 1)!;
    const parameters = { [leaf.id]: { limit: 0 } };
    expect(adoptionParameterProblem(pack, parameters)).toBeUndefined();

    const { observation } = validateObservation(
      observationRegistry(),
      rotorIcingObservation({ subject: { kind: 'aircraft', id: 'toy-tail-1', scope: 'source' } }, type),
    );
    const adopted = pack.leaves.find(isCheckedRuleLeaf)!;
    const result = runCheckedRule(
      adopted,
      { ...adopted.check.params, ...parameters[leaf.id] },
      {
        subject: [
          {
            id: 'toy-observation-1',
            type,
            version: 1,
            occurredAt: observation.occurredAt,
            interval: observation.interval,
            observation,
          },
        ],
      },
      { mode: 'wall', evaluatedAt: '2026-11-02T10:20:00.000Z' },
    );
    // attention is what opens a finding; the database path is in tests/integration/rule-evaluations.integration.test.ts.
    expect(result).toMatchObject({
      applicability: 'applicable',
      evidenceState: 'supported',
      outcome: 'attention',
      reasonCode: 'value_outside_limit',
      evidence: ['toy-observation-1'],
    });
  });
  test('hazard: a toy finding becomes a hazard origin with its rule kept as data, under no hazard allow-list', () => {
    const leaf = defineCheckedRule({
      id: 'toy.rotor-icing-hazard-floor',
      version: 1,
      title: 'Outside air stays above the icing floor',
      source: { kind: 'operator_procedure', reference: 'Toy procedure 2', text: 'Stop at or below the icing floor.' },
      target: { subjectKind: 'aircraft' },
      reads: [
        { name: 'subject', type: 'rotor.icing', versions: [1], about: 'target', required: true, select: 'latest' },
      ],
      check: {
        kind: findCheckKind('value.within-limit', 1)!,
        params: { field: 'values.outsideAirTemperatureCelsius', comparison: 'above', limit: 0 },
      },
    });
    const subject = { scope: 'source' as const, kind: 'aircraft' as const, id: 'toy-tail-1', sourceId: 'toy-sensor' };
    const evaluation: RuleEvaluationRecord = {
      version: 'ledger.rule-evaluation.1',
      id: 'toy-evaluation-1',
      subject,
      subjectKey: subjectReferenceKey(subject),
      organizationId: 'organization:toy',
      adoption: {
        id: 'toy-adoption',
        acceptedRevision: 1,
        effectiveInterval: { start: '2026-11-01T00:00:00.000Z', end: '2026-12-01T00:00:00.000Z' },
      },
      pack: { id: 'toy.rotor-icing-hazards', version: 1, digest: canonicalDigest({ toy: 'pack' }) },
      rule: { id: leaf.id, version: leaf.version, digest: leaf.digest, title: leaf.title, source: leaf.source },
      check: { kind: leaf.check.kind, version: leaf.check.version, definitionDigest: leaf.check.definitionDigest },
      parameters: leaf.check.params,
      applicability: 'applicable',
      evidenceState: 'supported',
      outcome: 'attention',
      reasonCode: 'value_outside_limit',
      summary: 'The toy reading is below the icing floor.',
      evidence: [],
      inputs: [],
      clock: { mode: 'wall', evaluatedAt: '2026-11-02T10:20:00.000Z' },
      trigger: { kind: 'observation', eventId: 'toy-event-1' },
      inputCut: { streams: { 'toy-stream': 3 } },
      dependencyBasis: canonicalDigest({ toy: 'basis' }),
      observationDigest: canonicalDigest({ toy: 'observations' }),
      inputDigest: canonicalDigest({ toy: 'inputs' }),
      recordedAt: '2026-11-02T10:20:01.000Z',
    };
    const latest = ruleEvaluationView(evaluation);
    const origin = findingOrigin({
      findingId: 'toy-finding-1',
      findingKind: 'subject',
      subject,
      subjectKey: evaluation.subjectKey,
      ruleId: leaf.id,
      status: 'open',
      latest,
    });
    // The pack and rule are carried as data; the evaluation is pinned by its exact digest and its input cut is what
    // newer evidence is compared against.
    expect(origin).toMatchObject({
      kind: 'finding',
      findingKind: 'subject',
      evaluationId: evaluation.id,
      evaluationDigest: canonicalDigest(evaluation),
      rule: { packId: 'toy.rotor-icing-hazards', ruleId: leaf.id, ruleVersion: 1, ruleDigest: leaf.digest },
    });
    expect(latest.acceptedInputCut).toEqual(evaluation.inputCut);
    const ajv = new Ajv({ strict: false });
    (addFormats as unknown as (instance: Ajv) => void)(ajv);
    expect(ajv.validate(HazardOriginSchema, origin), JSON.stringify(ajv.errors)).toBe(true);
    // Promoting it is an ordinary command on the shared route.
    const open = {
      kind: 'sms.record.open',
      record: {
        kind: 'hazard',
        schema: 'sms.hazard.1',
        title: 'Rotor icing below the floor',
        ownerId: 'toy-owner',
        body: { description: 'Toy icing finding.', consequence: 'Toy loss of lift.', source: { kind: 'finding' } },
      },
      origin: {
        kind: 'finding',
        findingId: origin.findingId,
        evaluationId: origin.evaluationId,
        expectedDependencyBasis: evaluation.dependencyBasis,
      },
    };
    expect(ajv.validate(CommandSchema, open), JSON.stringify(ajv.errors)).toBe(true);
    // No core hazard module names a rule, and none needs an allow-list entry. The database path is in
    // tests/integration/hazard-origins.integration.test.ts.
    const hazardModules = ['sms-origins.ts', 'sms-envelope.ts', 'sms-decisions.ts', 'sms-reads.ts'].map(
      (name) => `packages/domain/src/${name}`,
    );
    const forbidden = forbiddenLiterals();
    for (const file of hazardModules)
      expect(scanSource(file, readFileSync(join(repositoryRoot, file), 'utf8'), forbidden), file).toEqual([]);
    const allowList: { file: string }[] = JSON.parse(
      readFileSync(join(import.meta.dirname, 'generalisation-guard-allow-list.json'), 'utf8'),
    ).entries;
    expect(allowList.filter((entry) => hazardModules.includes(entry.file))).toEqual([]);
  });
  test('control: a toy control type registered here is proposed on the toy hazard and bound by its acceptance', () => {
    // The control type is data plus one wording function; registering it is all a new control needs.
    registerControlType(rotorHeaterControlType);
    const digest = registeredControlTypeDigest(rotorHeaterControlType.id, 1)!;
    expect(digest).toBe(controlTypeDigest(rotorHeaterControlType));
    const pinned = { id: rotorHeaterControlType.id, version: 1, digest };
    const ajv = new Ajv({ strict: false });
    (addFormats as unknown as (instance: Ajv) => void)(ajv);
    // Proposing it on the toy hazard is an ordinary record command on the shared route.
    const body = {
      hazardId: 'toy-hazard-1',
      controlType: pinned,
      parameters: { aircraftId: 'toy-tail-1', minimumMinutes: 5 },
      effectiveFrom: '2026-11-03T00:00:00.000Z',
    };
    const propose = {
      kind: 'sms.record.open',
      record: {
        kind: 'control',
        schema: 'sms.control.1',
        title: 'Heater run before flight',
        ownerId: 'toy-owner',
        body,
      },
    };
    expect(ajv.validate(CommandSchema, propose), JSON.stringify(ajv.errors)).toBe(true);
    expect(controlParameterProblem(pinned, body.parameters)).toBeUndefined();
    expect(controlParameterProblem(pinned, { aircraftId: 'toy-tail-1' })).toMatch(/minimumMinutes/);

    // The assessment lists the control version; the acceptance a person signs binds it and its wording.
    const row = (recordId: string, versionNumber: number, title: string, version: Record<string, unknown>) => ({
      id: `${recordId}-event-${versionNumber}`,
      record_id: recordId,
      version_number: versionNumber,
      revision: '1',
      schema: 'sms.toy.1',
      record_class: 'srm_output' as const,
      confidentiality: 'ordinary' as const,
      title,
      body: version,
      body_digest: canonicalDigest(version),
      owner_id: 'toy-owner',
      due_at: null,
      links: [],
      actor_id: 'toy-owner',
      recorded_at: new Date('2026-11-03T00:00:00.000Z'),
    });
    const control = assessedControlEntry(row('toy-control-1', 1, 'Heater run before flight', body) as never);
    expect(control).toMatchObject({
      recordId: 'toy-control-1',
      versionNumber: 1,
      controlType: pinned,
      type: rotorHeaterControlType.title,
      description: 'Run the rotor heater on toy-tail-1 for 5 minutes',
    });
    const assess = {
      kind: 'decision.record',
      subject: { kind: 'sms', id: 'toy-hazard-1' },
      expectedRevision: 1,
      expectedDependencyBasis: canonicalDigest({ toy: 'basis' }),
      decision: {
        kind: 'risk.assess',
        note: 'Toy assessment.',
        matrix: { recordId: 'toy-matrix', versionNumber: 1 },
        initial: { severity: 'major', likelihood: 'remote' },
        controls: [{ recordId: control.recordId, versionNumber: control.versionNumber }],
        residual: { severity: 'minor', likelihood: 'remote' },
        newHazardCheck: { answer: 'none_identified' },
      },
    };
    expect(ajv.validate(CommandSchema, assess), JSON.stringify(ajv.errors)).toBe(true);
    const matrix = row('toy-matrix', 1, 'Toy matrix', exampleRiskMatrix);
    const hazardBody = { description: 'Toy icing.', consequence: 'Toy loss of lift.', source: { kind: 'finding' } };
    const assessment: SmsDecisionRecord = {
      version: 'sms.decision.1',
      id: 'toy-assessment',
      subjectId: 'toy-hazard-1',
      kind: 'risk.assess',
      note: 'Toy assessment.',
      acceptedRevision: 2,
      acceptedBasisRevision: 1,
      outcome: {
        matrix: { recordId: 'toy-matrix', versionNumber: 1, bodyDigest: matrix.body_digest },
        initial: evaluateRiskMatrix(exampleRiskMatrix, { severity: 'major', likelihood: 'remote' })!,
        controls: [control],
        residual: evaluateRiskMatrix(exampleRiskMatrix, { severity: 'minor', likelihood: 'remote' })!,
        newHazardCheck: { answer: 'none_identified' },
        assessedVersion: { versionNumber: 1, bodyDigest: canonicalDigest(hazardBody) },
      },
      actor: {
        policyVersion: 'toy',
        principalId: 'toy-owner',
        name: 'Toy Safety Lead',
        kind: 'human',
        principalRevision: 1,
        capabilities: [],
        checkedCapabilities: [],
      },
      dependencyBasis: canonicalDigest({ toy: 'basis' }),
      recordedAt: '2026-11-03T00:00:00.000Z',
    };
    const signer = {
      id: 'toy-signer',
      tenantId: 'toy-tenant',
      name: 'Toy Accountable Executive',
      kind: 'human',
      capabilities: ['decision:write', 'risk:accept:high'],
      revision: 1,
    };
    const hazard = {
      id: 'toy-hazard-1',
      tenant_id: 'toy-tenant',
      kind: 'hazard' as const,
      revision: '2',
      title: 'Rotor icing below the floor',
    };
    const signing = riskAcceptanceContent(
      signer as never,
      hazard as never,
      row('toy-hazard-1', 1, 'Rotor icing below the floor', hazardBody) as never,
      assessment,
      matrix as never,
    );
    // The acceptance authority comes from the one lookup.
    const residual = (assessment.outcome as { residual: { level: 'low' | 'medium' | 'high' } }).residual.level;
    expect(signing.satisfyingCapability).toBe(coveringRiskCapability(residual, signer.capabilities));
    expect(signing.content.bindings).toContainEqual({
      kind: 'record_version',
      recordId: 'toy-control-1',
      versionNumber: 1,
      bodyDigest: control.bodyDigest,
    });
    expect(signing.content.statement.controls).toEqual([control]);
    const accept = {
      ...assess,
      expectedRevision: 2,
      decision: {
        kind: 'risk.accept',
        note: 'Toy acceptance.',
        assessmentId: assessment.id,
        signature: { intent: signing.content.intent, contentDigest: canonicalDigest(signing.content), reviewed: true },
      },
    };
    expect(ajv.validate(CommandSchema, accept), JSON.stringify(ajv.errors)).toBe(true);
    // The database path, including the accepted-control rows, is in tests/integration/sms.integration.test.ts.
  });
  test('effectiveness: a toy indicator definition (icing reports per 100 flight hours) is calculated for a control', () => {
    const type = 'rotor.icing-indicated';
    registerObservationTypes(rotorIcingType(type));
    // The indicator is data: which observations count, what they are divided by, and what a stated rate needs.
    registerIndicatorDefinition(
      defineIndicator({
        id: 'toy.rotor-icing-rate',
        version: 1,
        title: 'Moderate or severe rotor icing per 100 flight hours',
        description: 'Toy indicator: rotor icing reports of moderate or worse, per 100 reported flight hours.',
        scope: { kind: 'subject_kind', subjectKind: 'aircraft' },
        events: {
          kind: 'observations',
          type,
          versions: [1],
          condition: { field: 'values.severity', operator: 'one_of', values: ['moderate', 'severe'] },
        },
        exposure: { kind: 'exposure.flight-hours', version: 1, params: {} },
        window: { maxMilliseconds: 7 * 24 * 60 * 60 * 1000 },
        completeness: { exposureMustExceed: '0', populationDeclaredComplete: true, coverageWithoutGaps: true },
        unit: { per: 100, label: 'per 100 flight hours', fractionDigits: 2 },
      }),
    );
    const definition = findIndicatorDefinition('toy.rotor-icing-rate', 1)!;
    const tail = { kind: 'aircraft' as const, id: 'toy-tail-1', scope: 'source' as const };
    const subjects: SubjectReference[] = [{ ...tail, sourceId: 'toy-icing-sensor' }];
    const accepted = (observation: Record<string, unknown>, id: string, named: SubjectReference[] = subjects) => {
      const valid = validateObservation(observationRegistry(), observation).observation;
      return {
        id,
        type: valid.type as string,
        version: valid.version as number,
        occurredAt: valid.occurredAt as string,
        ...(valid.interval ? { interval: valid.interval as { start: string; end?: string } } : {}),
        subjects: named,
        observation: valid,
      };
    };
    const icing = (id: string, severity: string, start: string) => ({
      kind: 'observation' as const,
      ...accepted(
        rotorIcingObservation({ subject: tail, occurredAt: start, interval: { start }, values: { severity } }, type),
        id,
      ),
    });
    const flown = accepted(
      {
        type: 'flight.report',
        version: 1,
        subject: { kind: 'flight', id: 'toy-flight-1', scope: 'source' },
        secondarySubject: tail,
        occurredAt: '2026-11-02T12:00:00.000Z',
        fidelity: 'synthetic_contract',
        limitations: [],
        originalArtifactId: 'artifact-under-test',
        values: { activity: 'landed', takeoffAt: '2026-11-02T10:00:00.000Z', landingAt: '2026-11-02T12:00:00.000Z' },
      },
      'toy-flight-report-1',
      [{ scope: 'source', kind: 'flight', id: 'toy-flight-1', sourceId: 'toy-icing-sensor' }, ...subjects],
    );
    const input = {
      window: { start: '2026-11-02T00:00:00.000Z', end: '2026-11-03T00:00:00.000Z' },
      recordedThrough: '2026-11-03T00:00:00.000Z',
      control: { id: 'toy.rotor-heater-control', version: 1 },
      population: { subjects, complete: true, declaredBy: { kind: 'person', id: 'toy-safety-lead' } },
      selection: { complete: true, exceeded: [] },
      events: [
        icing('toy-icing-1', 'severe', '2026-11-02T10:30:00.000Z'),
        icing('toy-icing-2', 'trace', '2026-11-02T11:00:00.000Z'),
      ],
      exposure: [flown],
    };
    const result = calculateIndicator(definition, input);
    // Evidence for a person to review: one counted report over two flight hours, never a verdict on the control.
    expect(result).toMatchObject({
      status: 'supported',
      eventCount: 1,
      exposure: { decimal: '2.00', unit: 'flight_hour' },
      rate: { decimal: '50.00', label: 'per 100 flight hours' },
      control: { id: 'toy.rotor-heater-control', version: 1 },
      counted: { events: ['toy-icing-1'], exposure: ['toy-flight-report-1'] },
    });
    // Without the flight report the exposure is unknown, so no rate is stated.
    expect(calculateIndicator(definition, { ...input, exposure: [] })).toMatchObject({
      status: 'insufficient',
      rate: null,
      reasons: ['exposure_not_positive'],
    });
  });
  test('evidence: the generic evidence packet is issued for the toy finding, bound by digests, with no packet allow-list', () => {
    const { sources, evaluation, pack } = toyFinding({ mode: 'shadow' });
    const packet = assembleFindingPacket(sources, toyIssue);
    const ajv = new Ajv({ strict: false });
    (addFormats as unknown as (instance: Ajv) => void)(ajv);
    expect(ajv.validate(FindingPacketSchema, packet), JSON.stringify(ajv.errors)).toBe(true);
    // The rule is carried as data: pack, rule, check kind and adoption, each pinned by digest.
    expect(packet.manifest.evaluations[0]).toMatchObject({
      id: evaluation.id,
      digest: canonicalDigest(evaluation),
      mode: 'shadow',
      observations: [{ observationId: 'toy-observation-1', receiptId: 'toy-receipt-1', artifactId: 'toy-artifact-1' }],
      corrections: [{ kind: 'withdrawal', eventId: 'toy-withdrawal', observationId: 'toy-observation-0' }],
    });
    expect(packet.manifest.adoptions).toEqual([
      expect.objectContaining({ id: 'toy-adoption', mode: 'shadow', packId: pack.packId, packDigest: pack.digest }),
    ]);
    expect(packet.manifest.decisions.hazards).toEqual([
      expect.objectContaining({
        recordId: 'toy-hazard',
        evaluationId: evaluation.id,
        assessmentIds: ['toy-assessment'],
      }),
    ]);
    expect(packet.manifest.statements[0]).toMatch(/adopted in shadow/);
    expect(packet.manifestDigest).toBe(canonicalDigest(packet.manifest));
    // No core packet module names a rule, and none needs an allow-list entry.
    const packetModules = ['finding-packets.ts', 'finding-packet-assembly.ts', 'finding-packet-records.ts'].map(
      (name) => `packages/evidence/src/${name}`,
    );
    const forbidden = forbiddenLiterals();
    for (const file of [...packetModules, 'apps/api/src/finding-packets.ts'])
      expect(scanSource(file, readFileSync(join(repositoryRoot, file), 'utf8'), forbidden), file).toEqual([]);
    const allowList: { file: string }[] = JSON.parse(
      readFileSync(join(import.meta.dirname, 'generalisation-guard-allow-list.json'), 'utf8'),
    ).entries;
    expect(allowList.filter((entry) => packetModules.includes(entry.file))).toEqual([]);
  });
  test('evidence: the toy finding packet verifies offline from its bytes alone, by a verifier that names no rule', () => {
    const { sources } = toyFinding({ mode: 'shadow' });
    const packet = assembleFindingPacket(sources, toyIssue);
    // Ledger signs no packet, so there are no keys: the holder keeps the manifest digest apart from the packet.
    const { status, result } = verifyOffline(canonicalize(packet), [
      '--expected-manifest-sha256',
      packet.manifestDigest,
    ]);
    expect(status).toBe(0);
    expect(result).toMatchObject({
      status: 'verified',
      findingId: sources.finding.id,
      subjectKey: sources.finding.subjectKey,
      counts: packet.manifest.counts,
    });
    // The verifier is the same code for every rule; no verifier file names one or needs an allow-list entry.
    const verifierModules = ['finding-packet.mjs', 'finding-packet-cli.mjs'].map((name) => `tools/verifier/${name}`);
    const forbidden = forbiddenLiterals();
    for (const file of verifierModules)
      expect(scanSource(file, readFileSync(join(repositoryRoot, file), 'utf8'), forbidden), file).toEqual([]);
  });
});
