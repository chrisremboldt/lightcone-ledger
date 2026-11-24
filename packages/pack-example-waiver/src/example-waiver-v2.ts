import { readFileSync } from 'node:fs';
import {
  EXAMPLE_WAIVER_PACK_ID,
  exampleWaiverRulePack as versionOneOnly,
  exampleWaiverV1,
} from './example-waiver-v1.js';
import { waiverRulePack, type WaiverDefinition } from './waiver.js';

/** The fictional certificate as amended, kept unmodified beside the pack. */
export const exampleWaiverAmendmentFilename = 'example-waiver-alpha-dispatch-amendment-1.txt';

const VERSION_TWO_DIGEST = '821114f93f9db2fbb53eeb06137ed397d58fed6ba91dd8b4a6eb9ea5f7dafea0';

// The amendment adds a line before the provisions and changes only provision 1; the rest keep their text.
const AMENDMENT_SHIFT = 165;

/**
 * Invented for this repository, like version 1. The amendment lists Alpha Dispatch's pilots by the identifiers its
 * crew records use. ALPHA-PILOT-02 is left out on purpose, so the sample flights that pilot commands have an example
 * of the listed-pilot finding. Only provision 1 changes: its quoted text and the pilots it lists, so its rule takes
 * version 2.
 */
export const exampleWaiverV2: WaiverDefinition = {
  ...exampleWaiverV1,
  version: 2,
  title: 'Example waiver EXW-0001 amendment 1 for Alpha Dispatch (fictional)',
  certificate: {
    ...exampleWaiverV1.certificate,
    byteLength: 2414,
    sha256: 'b146809f89d3b13674b5b77600fb41630e66fed91e9e5dda7483b3fe545e839e',
  },
  provisions: [
    {
      number: '1',
      title: 'Listed pilots',
      start: 847,
      end: 1020,
      sha256: '344aa8a729df66fbcc78105226e44e3a581fbf536afc6d60278cdc4982f51f5d',
      obligation: 'eligibility.listed-pilot',
      parameters: { personIds: ['ALPHA-PILOT-01', 'ALPHA-PILOT-03'] },
      ruleVersion: 2,
    },
    ...exampleWaiverV1.provisions.slice(1).map((provision) => ({
      ...provision,
      start: provision.start + AMENDMENT_SHIFT,
      end: provision.end + AMENDMENT_SHIFT,
    })),
  ],
};

export function readExampleWaiverAmendment(): Buffer {
  return readFileSync(new URL(`../resources/${exampleWaiverAmendmentFilename}`, import.meta.url));
}

/** Reads the amended certificate and assembles version 2; throws if any pinned byte or the pack content changed. */
export function exampleWaiverVersionTwo() {
  const pack = waiverRulePack(exampleWaiverV2, readExampleWaiverAmendment());
  if (pack.versions[0]!.digest !== VERSION_TWO_DIGEST)
    throw new Error(
      `Rule pack ${pack.packId} version 2 changed without a new pack version: its digest is now ${pack.versions[0]!.digest}`,
    );
  return pack;
}

/** Both versions of the example waiver; the provisions listed are those of the latest. */
export function exampleWaiverRulePack() {
  const latest = exampleWaiverVersionTwo();
  return { ...latest, versions: [versionOneOnly().versions[0]!, latest.versions[0]!] };
}

export { EXAMPLE_WAIVER_PACK_ID };
