import { withPopulation } from '@ledger/domain';
import * as checks from './checks.js';
import type { AddedCheckedEntry } from './part108-nprm-v3-added.js';
import type { QuotedParagraph } from './retained-document.js';

// Height, airspace authorization and the area of operations, read from what the aircraft and the airspace service
// reported, or else from the plan (docs/design/observed-values.md). Each result says which it read.

const paragraph = (reference: string, start: number, end: number, sha256: string): QuotedParagraph => ({
  reference: `Proposed 14 CFR ${reference}`,
  start,
  end,
  sha256,
});

export const flownCheckedEntries: readonly AddedCheckedEntry[] = [
  {
    id: 'ledger.nprm.108.175.a',
    paragraph: paragraph(
      '108.175(a)',
      1231659,
      1232163,
      'aae41c6bb50e92bdd44b223eb53f2714fde38d62456baa335241e7b836c925f7',
    ),
    check: withPopulation(checks.heightWithinLimit, checks.flights, { plan: 'flight plan' }),
    answers:
      'Per flight: is the highest flown height above ground level (or above the takeoff point, named as such) the planned aircraft reported in the planned window at most 400 feet, or, with none reported, the planned maximum height?',
    forAPerson:
      'The paragraph’s exceptions in class G airspace (steep terrain, a structure, avoiding a collision), heights between reports, and the difference between the takeoff point and the ground below. A height above the ellipsoid or mean sea level is named and never compared.',
  },
  {
    id: 'ledger.nprm.108.180.d.1',
    paragraph: paragraph(
      '108.180(d)(1)',
      1234061,
      1234274,
      '48968198bea37715563f666ba81865868b61158f46474617ba2b570730ce4b6b',
    ),
    check: withPopulation(checks.airspaceAuthorizationCoversFlight, checks.flights, {
      plan: 'flight plan',
      authorizations: 'airspace authorization',
    }),
    answers:
      'Per flight: does an airspace authorization on record, reported approved, cover the flight’s time (flown, or else planned), its flown positions and its height?',
    forAPerson:
      'Whether the flight entered airspace the designations name, so needed an authorization, and whether one was obtained another way. The status is the issuing party’s report.',
  },
  {
    id: 'ledger.nprm.108.165.a.flown',
    paragraph: paragraph(
      '108.165(a)',
      1228575,
      1228830,
      '1772f4ae2af633a2c5d22b485e58643492fc2cc2862f698003853f1a83d04f2d',
    ),
    check: withPopulation(checks.flownInsideOperatingArea, checks.flights, {
      window: 'flight plan',
      area: 'operating area',
    }),
    answers:
      'Per flight: is every usable position the planned aircraft reported in the planned window inside one of the organization’s operating areas (circles and corridors on file) current at the time of the position? An area whose shape cannot be read is named and left out.',
    forAPerson:
      'Whether each area is the one the authority approved, and the path between reports. A plan states no path, so a flight with no reported positions is not placed.',
  },
];
