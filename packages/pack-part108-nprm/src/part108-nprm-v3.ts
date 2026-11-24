import type { CheckedRuleLeaf, RulePackLeaf, RulePackVersion } from '@ledger/contracts';
import { defineCheckedRule, withPopulation } from '@ledger/domain';
import { canonicalDigest } from '@ledger/integrity';
import * as checks from './checks.js';
import { PART108_NPRM_PACK_ID, retainedLeaf, type RegulatoryLeaf } from './part108-nprm-v1.js';
import {
  checkedEntries as versionTwoCheckedEntries,
  uncheckedEntries as versionTwoUncheckedEntries,
} from './part108-nprm-v2.js';
import { communicationAssessmentParagraph, quotedSource, type QuotedParagraph } from './retained-document.js';
import { addedCheckedEntries, addedUncheckedEntries, type AddedUncheckedEntry } from './part108-nprm-v3-added.js';

import { depthCheckedEntries, depthUncheckedEntries } from './part108-nprm-v3-depth.js';
import { flightRecordCheckedEntries } from './part108-nprm-v3-flight-record.js';
import { sectioned } from './sections.js';
import { flownCheckedEntries } from './part108-nprm-v3-flown.js';
import { requiredRecords } from './required-records.js';
import {
  onFileCheckedEntries,
  onFilePurposes,
  onFileUncheckedEntries,
  safetyManagementRemainder,
} from './part108-nprm-v3-on-file.js';

export { addedCheckedEntries, addedUncheckedEntries } from './part108-nprm-v3-added.js';
export { depthCheckedEntries, depthUncheckedEntries } from './part108-nprm-v3-depth.js';
export { flightRecordCheckedEntries } from './part108-nprm-v3-flight-record.js';
export { flownCheckedEntries } from './part108-nprm-v3-flown.js';
export { onFileCheckedEntries, onFileUncheckedEntries, safetyManagementRemainder } from './part108-nprm-v3-on-file.js';

const VERSION_THREE_DIGEST = 'e95017f405bd0a007cc636a3dd487685f59da94b4146d24c6af3b7b2e93f4dab';

/**
 * A paragraph version 2 quoted without a check, now served by one. The leaf keeps its id and takes version 2, since
 * version 1 of the id is the unchecked entry. `answers` and `forAPerson` are kept beside the entry, not in the pinned
 * leaf: what the check shows, and what in the paragraph it does not.
 */
interface NewlyCheckedEntry {
  id: string;
  check: checks.SourceNeutralCheck;
  answers: string;
  forAPerson: string;
}

/** The paragraph version 2 quoted for an id; read when leaves are built, as versions 1 and 2 import each other. */
export function quotedInVersionTwo(id: string): QuotedParagraph {
  const entry = versionTwoUncheckedEntries.find((item) => item.id === id);
  if (!entry) throw new Error(`Version 2 quotes no unchecked paragraph ${id}`);
  return entry.paragraph;
}

export const newlyCheckedEntries: readonly NewlyCheckedEntry[] = [
  {
    id: 'ledger.nprm.108.40.a.1',
    check: withPopulation(checks.totalTimeInService, checks.aircraft, {
      opening: 'complete aircraft time in service total',
    }),
    answers:
      'Per aircraft: can a total time in service be derived from its latest recorded total with complete coverage and the flights since, from their reported times or else the operator’s flight records?',
    forAPerson:
      'Whether the operator keeps the total in its own records, and whether flights were flown that neither a report nor a flight record names.',
  },
  {
    id: 'ledger.nprm.108.330.c',
    check: withPopulation(checks.weeklyRestDay, checks.people, { subject: 'duty or rest period' }),
    answers:
      'Per person: does recorded rest cover a whole local calendar day of the week holding the evaluation day, in the zone and week the organization sets on adoption?',
    forAPerson:
      'Whether “one day” means a local calendar day, whether the rest was free of all responsibility, and whether the operator scheduled the person for duty that week (no record says so, so a week without duty can need attention).',
  },
  {
    id: 'ledger.nprm.108.45.f',
    check: withPopulation(checks.deviationReportTiming, checks.flights),
    answers:
      'Per flight: is the latest recorded emergency deviation reported to the authority within 10 days after its local date, not counting Saturdays, Sundays and Federal holidays from 2025 through 2027?',
    forAPerson:
      'Whether the deviation was made under § 108.215, what the report held and how it was made; a deviation whose count runs past 2027 is insufficient until a later pack version extends the holiday list.',
  },
  {
    id: 'ledger.nprm.108.615.a',
    check: withPopulation(checks.partWithinLifeLimit, checks.components),
    answers:
      'Per component: is its recorded time at installation plus the time in service its aircraft recorded since installation within its recorded life limit?',
    forAPerson:
      'Whether the recorded limit is the manufacturer’s; flight time after the aircraft’s latest recorded total is not counted, because one check cannot both derive a total from flights and measure it from the installation. A new part needs its time at installation recorded as 0.',
  },
  {
    id: 'ledger.nprm.108.310.e',
    check: withPopulation(checks.coordinatorMakeModelExperience, checks.flights),
    answers:
      'Per flight, one result for each person assigned as flight coordinator: does an experience record in the make and model of the aircraft the flight plan names hold at least 5 hours of supervised operating time?',
    forAPerson:
      'Who supervised the time and whether they were a qualified coordinator, an operations supervisor or a designated person; the experience record does not name their role.',
  },
];

/**
 * The rules whose question is about a plan, or about records made for a planned window: they read plans, so a flight
 * is checked as soon as its plan and the records for it are on file, before its window starts. Version 3 carries
 * them as the next version of each rule; versions 1 and 2 keep theirs.
 */
export const planReadingIds: readonly string[] = [
  'ledger.nprm.108.170.a',
  'ledger.nprm.108.170.b',
  'ledger.nprm.108.170.d',
  'ledger.nprm.108.170.h',
  'ledger.nprm.108.210.b',
  'ledger.nprm.108.210.c',
  'ledger.nprm.108.310.a',
  'ledger.nprm.108.310.c',
  'ledger.nprm.108.310.e',
];

function readingPlans<Entry extends { id: string; check: checks.SourceNeutralCheck }>(entry: Entry): Entry {
  if (!planReadingIds.includes(entry.id)) return entry;
  return {
    ...entry,
    check: { ...entry.check, reads: entry.check.reads.map((read) => ({ ...read, plans: true as const })) },
  };
}

const planned = (id: string) => (planReadingIds.includes(id) ? 1 : 0);

function checkedLeaf(
  documentBytes: Buffer,
  entry: { id: string; paragraph: QuotedParagraph; check: checks.SourceNeutralCheck },
  version: number,
): CheckedRuleLeaf {
  return defineCheckedRule({
    ...entry.check,
    id: entry.id,
    version,
    source: quotedSource(documentBytes, entry.paragraph),
  });
}

/** A quoted paragraph no check serves, carrying what the person confirms or why nothing covers it. */
function uncheckedLeaf(documentBytes: Buffer, entry: AddedUncheckedEntry, version = 1): RegulatoryLeaf {
  const content: Omit<RegulatoryLeaf, 'digest'> = {
    id: entry.id,
    version,
    title: entry.title,
    source: quotedSource(documentBytes, entry.paragraph),
    review: 'ai_drafted',
    adopted: false,
    dependencies: [],
    coverage: entry.coverage,
    waitingFor: entry.waitingFor,
  };
  return { ...content, digest: canonicalDigest(content) };
}

/**
 * Version 3 leaves: version 2's checked rules (those about a plan as their next version, reading plans), the
 * paragraphs version 2 quoted without a check now served by one, the reporting clocks and certificate records added in
 * version 3, the items of the record of each flight, what is on file for an application and a safety management
 * system, height, airspace and area from what
 * was flown, the paragraphs added without a check, then version 1's communication assessment and what of § 108.560(a)
 * no record bears on (version 1 marked it not supported).
 */
export function versionThreeLeaves(documentBytes: Buffer): RulePackLeaf[] {
  return [
    ...versionTwoCheckedEntries.map((entry) => checkedLeaf(documentBytes, readingPlans(entry), 1 + planned(entry.id))),
    ...newlyCheckedEntries.map((entry) =>
      checkedLeaf(
        documentBytes,
        readingPlans({ ...entry, paragraph: quotedInVersionTwo(entry.id) }),
        2 + planned(entry.id),
      ),
    ),
    ...[
      ...addedCheckedEntries,
      ...flightRecordCheckedEntries,
      ...onFileCheckedEntries,
      ...flownCheckedEntries,
      ...depthCheckedEntries,
    ].map((entry) => checkedLeaf(documentBytes, entry, 1)),
    ...[...addedUncheckedEntries, ...onFileUncheckedEntries, ...depthUncheckedEntries].map((entry) =>
      uncheckedLeaf(documentBytes, entry),
    ),
    retainedLeaf(
      documentBytes,
      'ledger.nprm.108.550.a',
      'Communication assessment',
      'manual',
      communicationAssessmentParagraph,
    ),
    uncheckedLeaf(documentBytes, safetyManagementRemainder, 2),
  ];
}

export function versionThree(documentBytes: Buffer): RulePackVersion {
  const { leaves, sections } = sectioned(versionThreeLeaves(documentBytes));
  const content: Omit<RulePackVersion, 'digest'> = {
    packId: PART108_NPRM_PACK_ID,
    version: 3,
    title: 'Part 108 NPRM checks (shadow only)',
    status: 'draft',
    review: 'ai_drafted',
    adopted: false,
    bindings: [],
    leaves,
    sections,
    purposes: onFilePurposes(documentBytes),
    requiredRecords: requiredRecords(documentBytes),
  };
  const pack = { ...content, digest: canonicalDigest(content) };
  if (pack.digest !== VERSION_THREE_DIGEST)
    throw new Error(
      `Rule pack ${pack.packId} version 3 changed without a new pack version: its digest is now ${pack.digest}`,
    );
  return pack;
}
