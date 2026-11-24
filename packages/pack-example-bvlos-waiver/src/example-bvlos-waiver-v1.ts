import { readFileSync } from 'node:fs';
import { waiverRulePack, type WaiverDefinition } from '@ledger/pack-example-waiver';

export const EXAMPLE_BVLOS_WAIVER_PACK_ID = 'ledger.example-bvlos-waiver';

/** The pack and rule the relief provision names: the Part 107 pack's visual-line-of-sight rule. */
export const RELIEVED_PACK_ID = 'ledger.part107';
export const RELIEVED_RULE_IDS = ['ledger.part107.107.31.a'];

/** The invented certificate, kept unmodified beside the pack. */
export const exampleBvlosWaiverFilename = 'example-bvlos-waiver-alpha-dispatch.txt';

const VERSION_ONE_DIGEST = 'bbf9bdee5356e4ca53c51c7303e63adf5053538a19c582c5be9c1ba6472a6c05';

/**
 * Invented for this repository: a waiver for operations beyond visual line of sight, held by a seeded fictional
 * organization. It grants nothing and is modelled on no real waiver. Its first provision relieves the Part 107 pack's
 * visual-line-of-sight rule; the others are the conditions, each an ordinary rule.
 */
export const exampleBvlosWaiverV1: WaiverDefinition = {
  packId: EXAMPLE_BVLOS_WAIVER_PACK_ID,
  version: 1,
  title: 'Example waiver BVW-0001 for Alpha Dispatch, beyond visual line of sight (fictional)',
  certificate: {
    number: 'BVW-0001',
    holder: 'Alpha Dispatch',
    responsiblePerson: 'Dana Ortiz',
    byteLength: 2013,
    sha256: 'f0be12ea92c559b011064d7658af2d8b423542f603f2bedf46bec0e9626a2afb',
  },
  conditionsCover: 'flights_citing_certificate',
  effective: { from: '2026-09-01', through: '2028-08-31' },
  provisions: [
    {
      number: '1',
      title: 'Relief from visual line of sight',
      start: 641,
      end: 928,
      sha256: 'e37a7744938df8a07d5aad91a18c0cdc88b3a4c46998690606a6bd4b68fd47a8',
      obligation: 'authority.flight-cites-certificate',
      parameters: { certificateNumber: 'BVW-0001', effectiveFrom: '2026-09-01', effectiveThrough: '2028-08-31' },
      relieves: [{ packId: RELIEVED_PACK_ID, ruleIds: RELIEVED_RULE_IDS }],
    },
    {
      number: '2',
      title: 'Operating area',
      start: 930,
      end: 1146,
      sha256: '1331951f5bb38678272a1868e8a264ae99274a9751074ba12b7b5858fd478a9c',
      obligation: 'condition.operating-area',
      parameters: { areas: ['BVW-AREA: circle 41.87995, -87.6274 radius 3000'], marginMeters: 100 },
    },
    {
      number: '3',
      title: 'Detect and avoid',
      start: 1148,
      end: 1278,
      sha256: '8c8dcfb244add1b15a6afa38f2d78005f189f1949063761cfe653ddacd4705da',
      obligation: 'equipment.detect-and-avoid',
    },
    {
      number: '4',
      title: 'Lost-link procedure',
      start: 1280,
      end: 1425,
      sha256: '1e4cd4e9eac4bd99f9278bcb1ab7442477d89f2659dea1be76d0e12955b0e541',
      obligation: 'procedure.on-file',
      parameters: { procedureKind: 'lost_link' },
    },
    {
      number: '5',
      title: 'Wind at takeoff',
      start: 1427,
      end: 1575,
      sha256: '7c414acd3a48bdbc303f17cd191dac40cc55b46ac19245418e95cca67e71e932',
      obligation: 'weather.wind-at-takeoff',
      parameters: { maxMetersPerSecond: 10 },
    },
    {
      number: '6',
      title: 'Visibility at takeoff',
      start: 1577,
      end: 1709,
      sha256: 'ae7760bd9b5321754dfdcfb30d64daa597ae77b068e2cdce60cfd786fc3a3450',
      obligation: 'weather.visibility-at-takeoff',
      parameters: { minStatuteMiles: 3 },
    },
    {
      number: '7',
      title: 'Named pilots',
      start: 1711,
      end: 1882,
      sha256: 'e9b109700e3421a211903cd8e2465d8ff569d4416f35a1dffefb1cb328b8e4b4',
      obligation: 'eligibility.listed-pilot',
      parameters: { personIds: ['ALPHA-PILOT-01', 'ALPHA-PILOT-03'] },
    },
    {
      number: '8',
      title: 'Notification',
      start: 1884,
      end: 2012,
      sha256: '3369fcedabfd119129f651d18ec67c7bf402934b35a3233cdad6d2becc1fdb24',
      obligation: 'notification.before-operations',
      parameters: { party: 'Canal District harbor office', leadHours: 24 },
    },
  ],
};

export function readExampleBvlosWaiverCertificate(): Buffer {
  return readFileSync(new URL(`../resources/${exampleBvlosWaiverFilename}`, import.meta.url));
}

/** Reads the retained certificate and assembles version 1; throws if any pinned byte or the pack content changed. */
export function exampleBvlosWaiverRulePack() {
  const pack = waiverRulePack(exampleBvlosWaiverV1, readExampleBvlosWaiverCertificate());
  if (pack.versions[0]!.digest !== VERSION_ONE_DIGEST)
    throw new Error(
      `Rule pack ${pack.packId} version 1 changed without a new pack version: its digest is now ${pack.versions[0]!.digest}`,
    );
  return pack;
}
