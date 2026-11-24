import type { CheckedRuleLeaf, RuleAdoptionParameter, RulePackVersion, RuleRead } from '@ledger/contracts';
import { defineCheckedRule, findCheckKind } from '@ledger/domain';
import { canonicalDigest } from '@ledger/integrity';

export const EXAMPLE_CREW_PACK_ID = 'ledger.example-crew';
export const DUTY_PERIOD_LEAF_ID = 'ledger.example-crew.duty-period-length';
export const REST_BEFORE_DUTY_LEAF_ID = 'ledger.example-crew.rest-before-duty';
export const ROLLING_DUTY_LEAF_ID = 'ledger.example-crew.rolling-duty';
export const ASSIGNED_CREW_LEAF_ID = 'ledger.example-crew.assigned-crew-limits';

const VERSION_ONE_DIGEST = 'ae595a873cbf7b2b4f12726088c16a805a5383068728a284e03404145413bb38';

/** The look-back windows are part of the procedure; the limits within them are the organization's to set. */
export const REST_WITHIN_HOURS = 24;
export const ROLLING_HOURS = 168;

/** Invented for this repository. It is not a regulation and cites none; the numbers are the adopter's own. */
export const CREW_DUTY_PROCEDURE_V1 =
  'Example operating procedure 6.2, crew duty and rest. A crew member’s duty period lasts no longer than the maximum this organization sets when it adopts the procedure. Within the 24 hours before each duty period starts, the crew member has one continuous rest of at least the minimum the organization sets. Duty in any 168 hours totals no more than the maximum the organization sets. Only rest entered in the roster counts as rest, unless the organization states when it adopts the procedure that its duty record is complete: then the time between two recorded duty periods is rest as well. A crew member’s first duty period on record has no earlier period to count rest from. A crew member outside any of these limits, and every flight they are assigned to while outside them, needs attention from the dispatcher and the operations lead.';

const source = (procedureText: string) => ({
  kind: 'operator_procedure' as const,
  reference: 'Example operating procedure 6.2 (invented for this repository)',
  text: procedureText,
});

function dutyWithinLimits() {
  const kind = findCheckKind('duty.within-limits', 1);
  if (!kind) throw new Error('Check kind duty.within-limits version 1 is not registered');
  return kind;
}

const dutyAndRest = {
  dutySelect: { where: [{ field: 'values.period', oneOf: ['duty', 'flight_duty'] }] },
  restSelect: { where: [{ field: 'values.period', oneOf: ['rest'] }] },
};

const periodsAbout = (about: RuleRead['about']): RuleRead => ({
  name: 'periods',
  type: 'crew.duty-period',
  versions: [1],
  about,
  required: false,
  select: 'all',
});

const limits = {
  maxDutyHours: {
    name: 'maxDutyHours',
    title: 'Longest duty period (hours)',
    valueType: 'number',
    minimum: 1,
    maximum: 24,
  },
  minRestHours: {
    name: 'minRestHours',
    title: `Shortest continuous rest in the ${REST_WITHIN_HOURS} hours before duty (hours)`,
    valueType: 'number',
    minimum: 1,
    maximum: REST_WITHIN_HOURS,
  },
  maxRollingDutyHours: {
    name: 'maxRollingDutyHours',
    title: `Most duty in any ${ROLLING_HOURS} hours (hours)`,
    valueType: 'number',
    minimum: 1,
    maximum: ROLLING_HOURS,
  },
  dutyRecordComplete: {
    name: 'dutyRecordComplete',
    title: 'Every duty period is on record, so the time between two of them is rest',
    valueType: 'boolean',
  },
} satisfies Record<string, RuleAdoptionParameter>;

/** One limit per person, over the person's latest duty period started by the evaluation time. */
function personLeaf(
  id: string,
  title: string,
  params: Record<string, unknown>,
  parameters: RuleAdoptionParameter[],
  procedureText: string,
): CheckedRuleLeaf {
  return defineCheckedRule({
    id,
    version: 1,
    title,
    source: source(procedureText),
    target: { subjectKind: 'person' },
    reads: [periodsAbout('target')],
    check: { kind: dutyWithinLimits(), params: { ...dutyAndRest, ...params } },
    adoptionParameters: parameters,
  });
}

export function dutyPeriodLeafV1(procedureText: string = CREW_DUTY_PROCEDURE_V1): CheckedRuleLeaf {
  return personLeaf(
    DUTY_PERIOD_LEAF_ID,
    'Duty period longer than the adopted maximum',
    {},
    [limits.maxDutyHours],
    procedureText,
  );
}

export function restBeforeDutyLeafV1(procedureText: string = CREW_DUTY_PROCEDURE_V1): CheckedRuleLeaf {
  return personLeaf(
    REST_BEFORE_DUTY_LEAF_ID,
    'Rest before duty shorter than the adopted minimum',
    { restWithinHours: REST_WITHIN_HOURS },
    [limits.minRestHours, limits.dutyRecordComplete],
    procedureText,
  );
}

export function rollingDutyLeafV1(procedureText: string = CREW_DUTY_PROCEDURE_V1): CheckedRuleLeaf {
  return personLeaf(
    ROLLING_DUTY_LEAF_ID,
    `Duty in ${ROLLING_HOURS} hours above the adopted maximum`,
    { rollingHours: ROLLING_HOURS },
    [limits.maxRollingDutyHours],
    procedureText,
  );
}

/**
 * Per flight, one result for each person its role assignments name: the person's duty period during their
 * assignment against every limit. The window is the assignment that named the person, so the finding belongs to the
 * flight they were assigned to and names the person.
 */
export function assignedCrewLeafV1(procedureText: string = CREW_DUTY_PROCEDURE_V1): CheckedRuleLeaf {
  return defineCheckedRule({
    id: ASSIGNED_CREW_LEAF_ID,
    version: 1,
    title: 'Crew member assigned outside the adopted duty and rest limits',
    source: source(procedureText),
    target: { subjectKind: 'flight' },
    related: [
      {
        name: 'person',
        subjectKind: 'person',
        fanOut: true,
        whenNone: 'insufficient',
        from: { read: 'window', field: 'values.record.personId' },
      },
    ],
    reads: [
      {
        name: 'window',
        type: 'operator.record',
        versions: [1],
        about: 'target',
        required: true,
        select: 'all',
        where: [{ field: 'values.recordType', oneOf: ['operation.role-assignment'] }],
      },
      periodsAbout({ related: 'person' }),
    ],
    check: {
      kind: dutyWithinLimits(),
      params: {
        ...dutyAndRest,
        windowSelect: { recordType: 'operation.role-assignment', recordVersion: 1 },
        restWithinHours: REST_WITHIN_HOURS,
        rollingHours: ROLLING_HOURS,
      },
    },
    adoptionParameters: [
      limits.maxDutyHours,
      limits.minRestHours,
      limits.maxRollingDutyHours,
      limits.dutyRecordComplete,
    ],
  });
}

/** Assembles version 1 and refuses it when its content no longer matches the pinned digest. */
export function exampleCrewVersionOne(
  leaves: CheckedRuleLeaf[] = [dutyPeriodLeafV1(), restBeforeDutyLeafV1(), rollingDutyLeafV1(), assignedCrewLeafV1()],
): RulePackVersion {
  const content: Omit<RulePackVersion, 'digest'> = {
    packId: EXAMPLE_CREW_PACK_ID,
    version: 1,
    title: 'Example crew duty and rest procedures',
    status: 'draft',
    review: 'ai_drafted',
    adopted: false,
    bindings: [],
    leaves,
  };
  const pack = { ...content, digest: canonicalDigest(content) };
  if (pack.digest !== VERSION_ONE_DIGEST)
    throw new Error(
      `Rule pack ${pack.packId} version 1 changed without a new pack version: its digest is now ${pack.digest}`,
    );
  return pack;
}

export function exampleCrewRulePack() {
  return { packId: EXAMPLE_CREW_PACK_ID, versions: [exampleCrewVersionOne()] };
}
