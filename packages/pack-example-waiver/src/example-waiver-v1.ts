import { readFileSync } from 'node:fs';
import { waiverRulePack, type WaiverDefinition } from './waiver.js';

export const EXAMPLE_WAIVER_PACK_ID = 'ledger.example-waiver';

/** The fictional certificate, kept unmodified beside the pack. */
export const exampleWaiverFilename = 'example-waiver-alpha-dispatch.txt';

const VERSION_ONE_DIGEST = '2391a4bf35c864f294595420a71fe93712ed494bae252a177c07887c0528dd3c';

/** Invented for this repository: a waiver for a seeded fictional organization. It grants nothing. */
export const exampleWaiverV1: WaiverDefinition = {
  packId: EXAMPLE_WAIVER_PACK_ID,
  version: 1,
  title: 'Example waiver EXW-0001 for Alpha Dispatch (fictional)',
  certificate: {
    number: 'EXW-0001',
    holder: 'Alpha Dispatch',
    responsiblePerson: 'Dana Ortiz',
    byteLength: 2249,
    sha256: '5560b7f9b79077506141ecc2d607247d74c9ae931a5717f68023063f758870c0',
  },
  conditionsCover: 'every_flight',
  effective: { from: '2026-09-01', through: '2028-08-31' },
  provisions: [
    {
      number: '1',
      title: 'Listed pilots',
      start: 668,
      end: 855,
      sha256: '0ebb6de8fd0ccc761fd3f20f17e80dc133200be9d10d6d8f046a0136a19da989',
      obligation: 'eligibility.listed-pilot',
      parameters: { personIds: ['PER-0201', 'PER-0202'] },
    },
    {
      number: '2',
      title: 'Listed aircraft',
      start: 857,
      end: 999,
      sha256: 'a69739b1cc15b1319a388dd4e813ab5d0d659135d4079af0c2af1c1bac8cdfb3',
      obligation: 'eligibility.listed-aircraft',
      parameters: { registrationNumbers: ['FICT-0101', 'FICT-0102'] },
    },
    {
      number: '3',
      title: 'Anti-collision lighting',
      start: 1001,
      end: 1196,
      sha256: 'a12627dfbf3c42548e1802ec8d55b55f90a5aa2ed809c68213062f6322c609ca',
      obligation: 'equipment.anti-collision-lighting',
      parameters: { visibleStatuteMiles: 3 },
    },
    {
      number: '4',
      title: 'Maximum height',
      start: 1198,
      end: 1278,
      sha256: '2b0312336bf46e34aaf9706c4ee00b47c033d1d841bb8796a9b1b144d127672d',
      obligation: 'condition.max-height',
      parameters: { maxFeetAboveGround: 300 },
    },
    {
      number: '5',
      title: 'Maximum distance',
      start: 1280,
      end: 1375,
      sha256: '7ce89e6d6d684a492fc29d77cafc3ae93f3185084218b0ca9d1ef3e22767d3df',
      obligation: 'condition.max-distance',
      parameters: { maxStatuteMiles: 1 },
    },
    {
      number: '6',
      title: 'Crew location',
      start: 1377,
      end: 1471,
      sha256: '3bf5c7281c2b7445140c124cf1ab0a2c3b5cd853e9e1f6582a475a85c7b40ee4',
      obligation: 'condition.pilot-in-operating-area',
    },
    {
      number: '7',
      title: 'Visual observer',
      start: 1473,
      end: 1574,
      sha256: '16d1114e175aba1b0f0143432c62cb6f3b091ca329846509ecc3e46c7ea5cab9',
      obligation: 'condition.visual-observer-assigned',
    },
    {
      number: '8',
      title: 'Notification',
      start: 1576,
      end: 1700,
      sha256: '88de52017a333079b8366890bad7348fbf8e9110e1d4476c09abdd3b4e197d92',
      obligation: 'notification.before-operations',
      parameters: { party: 'Canal District harbor office', leadHours: 24 },
    },
    {
      number: '9',
      title: 'Carriage',
      start: 1702,
      end: 1748,
      sha256: '49d42d392d65008dd015cbb5a78ed93eb2e3c311b873126b9d7855cb4d2cd07c',
      obligation: 'condition.no-hazardous-carriage',
    },
    {
      number: '10',
      title: 'Training',
      start: 1750,
      end: 1892,
      sha256: '0f43ee16a64655da8e9ca913514af221c734195bccad08ce197567b669904c0a',
      obligation: 'qualification.named-training-current',
      parameters: { courseTitle: 'Night delivery operations', months: 12 },
    },
    {
      number: '11',
      title: 'Remote identification',
      start: 1894,
      end: 2011,
      sha256: '88f38219ef87a1b9d0f12c6c1dfbafa7e689346145757214054af82345458d9c',
      obligation: 'equipment.remote-id-method',
      parameters: { methods: ['standard_broadcast', 'broadcast_module'] },
    },
    {
      number: '12',
      title: 'Crew briefing',
      start: 2013,
      end: 2109,
      sha256: 'b775c8371feced2a382e2a7efbec7638f2a9abae2ac25bbd1b307b434ecf9de5',
      obligation: 'record.preflight-content',
      parameters: { fields: ['participantsBriefing'] },
    },
    {
      number: '13',
      title: 'Certificate at hand',
      start: 2111,
      end: 2218,
      sha256: '094dd5a45b84ef45a2ed4749a8b7d1ea70b607105958bf8c603e34adaafca3ae',
      obligation: 'authority.certificate-at-hand',
    },
  ],
};

export function readExampleWaiverCertificate(): Buffer {
  return readFileSync(new URL(`../resources/${exampleWaiverFilename}`, import.meta.url));
}

/** Reads the retained certificate and assembles version 1; throws if any pinned byte or the pack content changed. */
export function exampleWaiverRulePack() {
  const pack = waiverRulePack(exampleWaiverV1, readExampleWaiverCertificate());
  if (pack.versions[0]!.digest !== VERSION_ONE_DIGEST)
    throw new Error(
      `Rule pack ${pack.packId} version 1 changed without a new pack version: its digest is now ${pack.versions[0]!.digest}`,
    );
  return pack;
}
