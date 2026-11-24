import { isCheckedRuleLeaf, type CheckedRuleLeaf, type RulePackLeaf, type RulePackVersion } from '@ledger/contracts';
import { defineCheckedRule, withPopulation } from '@ledger/domain';
import { canonicalDigest } from '@ledger/integrity';
import * as checks from './checks.js';
import { PART107_PACK_ID, uncheckedEntries, versionOneLeaves } from './part107-v1.js';
import { PART107_EDITION_DATE, paragraph, quotedSource, type QuotedParagraph } from './retained-document.js';
import { requiredRecords } from './required-records.js';
import { sectioned } from './sections.js';

const VERSION_TWO_DIGEST = '701c04fe1e9c8ad0e330b9826fe864391d0583cb706387f248d24c40e4b0a1c8';

/**
 * A paragraph version 1 quoted without a check, now served by one. The leaf keeps its id and takes version 2, since
 * version 1 of the id is the unchecked entry. `answers` and `forAPerson` are kept beside the entry, not in the pinned
 * leaf: what the check shows, and what in the paragraph it does not.
 */
interface NewlyCheckedEntry {
  id: string;
  check: checks.SourceNeutralCheck;
  answers: string;
  forAPerson: string;
}

/** The paragraph version 1 quoted for an id; read when leaves are built, as versions 1 and 2 import each other. */
export function quotedInVersionOne(id: string): QuotedParagraph {
  const entry = uncheckedEntries.find((item) => item.id === id);
  if (!entry) throw new Error(`Version 1 quotes no unchecked paragraph ${id}`);
  return entry.paragraph;
}

export const newlyCheckedEntries: readonly NewlyCheckedEntry[] = [
  {
    id: 'ledger.part107.107.12.b.assigned',
    check: withPopulation(checks.assignedPilotCertificateHeld, checks.flights),
    answers:
      'Per flight, one result for each person a role assignment names as remote pilot in command: is that person’s latest remote pilot certificate recorded as held?',
    forAPerson:
      'Whether the certificate was held at the time of the flight (the check reads the latest record when it runs), whether it carries a small UAS rating, and the § 107.65 requirement the paragraph also names.',
  },
  {
    id: 'ledger.part107.107.9.timing',
    check: withPopulation(checks.injuryReportTiming, checks.flights),
    answers:
      'Per flight: is the latest recorded serious injury or loss of consciousness reported to the authority within 10 calendar days after its local date, in the time zone the organization sets on adoption?',
    forAPerson:
      'Whether the report was made in a manner acceptable to the Administrator; property damage (§ 107.9(b)) is not timed here, because whether a report is due turns on a repair cost or value judgment.',
  },
];

const controlledAirspace = paragraph(
  '107.41',
  30615,
  30877,
  '8dbb2d2f47e4aa253099c0fab6c13c330a8aa3f6a0a59c92e468b0b6c99b103f',
);

/**
 * Rules that read what the aircraft and the airspace service reported (docs/design/observed-values.md). The height and
 * speed rules are version 1 leaves shared with pack version 1; the authorization rule is new in version 2.
 * `answers` and `forAPerson` say what each shows and what it leaves to a person.
 */
export const observedValueEntries = [
  {
    id: 'ledger.part107.107.51.a',
    answers:
      'Per flight: is the highest ground speed the planned aircraft reported in the planned window at most 87 knots? With no reported ground speed, is the planned maximum ground speed? The result says which it read.',
    forAPerson:
      'The speed between reports, and the speed of a flight flown outside its planned window or by an aircraft the plan does not name.',
  },
  {
    id: 'ledger.part107.107.51.b',
    answers:
      'Per flight: is the highest height above ground level, or above the takeoff point, that the planned aircraft reported in the planned window at most 400 feet? With no such height, is the planned maximum height above ground level? The result says which it read; a height above the ellipsoid or sea level is named and not compared.',
    forAPerson:
      'Height above ground where the aircraft reported height above its takeoff point and the ground rose or fell, the height between reports, and whether the structure allowance in (b)(1) and (2) applies to a height above 400 feet.',
  },
  {
    id: 'ledger.part107.107.41',
    answers:
      'Per flight: does an airspace authorization the airspace service reported about the flight cover its time (flown, else planned), every flown position, and its height (flown, else planned) under its ceiling, as reported approved by the flight’s end? None on record is reported as not on file.',
    forAPerson:
      'Whether the flight was in Class B, C or D airspace or a surface area of Class E airspace at all; an authorization obtained another way; the authorization’s other terms; and, for a flight with no flown positions, whether its area covers where the flight went.',
  },
] as const;

/** The § 107.41 rule: version 1, since no earlier pack version quotes the paragraph. */
function controlledAirspaceLeaf(documentBytes: Buffer): CheckedRuleLeaf {
  return defineCheckedRule({
    ...withPopulation(checks.controlledAirspaceAuthorization, checks.flights, {
      plan: 'flight plan',
      authorizations: 'airspace authorization',
    }),
    id: 'ledger.part107.107.41',
    version: 1,
    source: quotedSource(documentBytes, controlledAirspace),
  });
}

/**
 * Which rule to rely on for which question, where version 2 asks a paragraph twice. The answers differ, so neither
 * result counts the other's: a person without a held certificate is one finding per person and one per flight they
 * are assigned to, under different questions.
 */
export const readerGuide = [
  {
    question: 'Does this person hold a remote pilot certificate (as recorded)?',
    ruleId: 'ledger.part107.107.12.b',
  },
  {
    question: 'Does each person assigned as remote pilot in command of this flight hold one (as recorded)?',
    ruleId: 'ledger.part107.107.12.b.assigned',
  },
  {
    question: 'Has each recorded serious injury or loss of consciousness on this flight a report time recorded?',
    ruleId: 'ledger.part107.107.9.a',
  },
  {
    question: 'Was the latest such event on this flight reported within 10 calendar days?',
    ruleId: 'ledger.part107.107.9.timing',
  },
] as const;

function checkedLeaf(documentBytes: Buffer, entry: NewlyCheckedEntry): CheckedRuleLeaf {
  return defineCheckedRule({
    ...entry.check,
    id: entry.id,
    version: 2,
    source: quotedSource(documentBytes, quotedInVersionOne(entry.id)),
  });
}

/**
 * Version 2 leaves: version 1's checked rules unchanged, the paragraphs version 1 quoted without a check now served by
 * one, the airspace authorization rule, then the paragraphs that stay for a person.
 */
export function versionTwoLeaves(documentBytes: Buffer): RulePackLeaf[] {
  const newIds = newlyCheckedEntries.map(({ id }) => id);
  const before = versionOneLeaves(documentBytes);
  return [
    ...before.filter(isCheckedRuleLeaf),
    ...newlyCheckedEntries.map((entry) => checkedLeaf(documentBytes, entry)),
    controlledAirspaceLeaf(documentBytes),
    ...before.filter((leaf) => !isCheckedRuleLeaf(leaf) && !newIds.includes(leaf.id)),
  ];
}

export function versionTwo(documentBytes: Buffer): RulePackVersion {
  const { leaves, sections } = sectioned(versionTwoLeaves(documentBytes));
  const content: Omit<RulePackVersion, 'digest'> = {
    packId: PART107_PACK_ID,
    version: 2,
    title: `Part 107 checks (14 CFR as of ${PART107_EDITION_DATE})`,
    status: 'draft',
    review: 'ai_drafted',
    adopted: false,
    bindings: [],
    leaves,
    sections,
    requiredRecords: requiredRecords(documentBytes),
  };
  const pack = { ...content, digest: canonicalDigest(content) };
  if (pack.digest !== VERSION_TWO_DIGEST)
    throw new Error(
      `Rule pack ${pack.packId} version 2 changed without a new pack version: its digest is now ${pack.digest}`,
    );
  return pack;
}
