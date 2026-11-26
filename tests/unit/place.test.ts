import { describe, expect, test } from 'vitest';
import {
  addressOf,
  barSection,
  placeFromAddress,
  placePath,
  placeTitle,
  type Place,
} from '../../apps/web/src/place.js';
import { returnAddress } from '../../apps/web/src/openid-connect.js';

const places: Place[] = [
  { section: 'start' },
  { section: 'setup' },
  { section: 'flights' },
  { section: 'flights', flightId: '6f1d2c4e-0000-4000-8000-000000000001' },
  { section: 'flights', flightId: 'RIDGE-AC-1 morning/2', findingId: 'f-1' },
  { section: 'flights', flightId: 'flight-7', mission: true },
  { section: 'safety', view: 'home' },
  { section: 'safety', view: 'hazards' },
  { section: 'safety', view: 'hazards', choices: { state: 'accepted', order: 'due' } },
  { section: 'safety', view: 'assurance', choices: { type: 'audit' } },
  { section: 'safety', view: 'documents' },
  { section: 'safety', view: 'reports' },
  { section: 'safety', view: 'assurance' },
  { section: 'safety', view: 'new-risk-matrix' },
  { section: 'safety', view: 'record', kind: 'hazard', id: 'h-1' },
  { section: 'safety', view: 'record', kind: 'control', id: 'c-1' },
  { section: 'safety', view: 'record', kind: 'document', id: 'd-1' },
  { section: 'safety', view: 'record', kind: 'document', id: 'd-1', issueId: 'i-2' },
  { section: 'safety', view: 'record', kind: 'risk_matrix', id: 'm-1' },
  { section: 'safety', view: 'record', kind: 'report', id: 'r-1' },
  { section: 'safety', view: 'record', kind: 'assurance', id: 'a-1' },
  { section: 'safety', view: 'finding', findingId: 'f-2' },
  { section: 'safety', view: 'finding', findingId: 'f-2', flightId: 'flight-7' },
  { section: 'records', pane: 'subjects' },
  { section: 'records', pane: 'subjects', kind: 'aircraft' },
  { section: 'records', pane: 'subjects', kind: 'aircraft', id: 'RIDGE-AC-1' },
  { section: 'records', pane: 'subjects', kind: 'person', id: 'Avery Example' },
  { section: 'records', pane: 'produce' },
  { section: 'records', pane: 'produced' },
  { section: 'records', pane: 'produced', id: '6f1c2a90-produced-set' },
  { section: 'records', pane: 'required' },
  { section: 'records', pane: 'browse' },
  { section: 'records', pane: 'browse', type: 'person.training@1' },
  { section: 'records', pane: 'import', type: 'aircraft.maintenance@2' },
  { section: 'records', pane: 'enter', type: 'person.training@1' },
  { section: 'rules', pane: 'coverage' },
  { section: 'rules', pane: 'coverage', packId: 'ledger.part107' },
  { section: 'rules', pane: 'open' },
  { section: 'rules', pane: 'open', owner: 'none' },
  { section: 'rules', pane: 'open', subject: { kind: 'flight', id: 'flight-7' } },
  { section: 'rules', pane: 'open', subject: { sourceId: 'operator-records', kind: 'person', id: 'P/1 #a' } },
  { section: 'rules', pane: 'subjects' },
  { section: 'people' },
  { section: 'people', personId: 'principal-7' },
  { section: 'reports', report: 'home' },
  { section: 'reports', report: 'summary', from: '2026-11-01', until: '2026-11-30' },
  { section: 'reports', report: 'findings' },
  { section: 'reports', report: 'findings', from: '2025-12', until: '2026-11' },
  { section: 'reports', report: 'indicators' },
  { section: 'reports', report: 'indicators', id: 'example-airspace.excursions-per-flight-hour', version: 2 },
  { section: 'reports', report: 'flight', flightId: 'RIDGE-FLT-1' },
  { section: 'reports', report: 'grants' },
  { section: 'reports', report: 'operators' },
];

function roundTrip(place: Place): Place {
  const address = new URL(placePath(place), 'https://ledger.example');
  return placeFromAddress(address.pathname, address.search);
}

describe('places and their addresses', () => {
  test.each(places.map((place) => [placePath(place), place] as const))('%s names its place', (_path, place) => {
    expect(roundTrip(place)).toEqual(place);
  });

  test('every place has its own address', () => {
    expect(new Set(places.map(placePath)).size).toBe(places.length);
  });

  test('addresses are readable, with ids percent-encoded', () => {
    expect(placePath({ section: 'records', pane: 'subjects', kind: 'aircraft', id: 'RIDGE-AC-1' })).toBe(
      '/records/aircraft/RIDGE-AC-1',
    );
    expect(placePath({ section: 'flights', flightId: 'RIDGE-AC-1 morning/2', findingId: 'f-1' })).toBe(
      '/flights/RIDGE-AC-1%20morning%2F2/findings/f-1',
    );
    expect(placePath({ section: 'records', pane: 'browse', type: 'person.training@1' })).toBe(
      '/records/browse/person.training@1',
    );
    expect(placePath({ section: 'rules', pane: 'open', owner: 'none' })).toBe('/rules/findings?owner=none');
    expect(placePath({ section: 'safety', view: 'record', kind: 'document', id: 'd-1', issueId: 'i-2' })).toBe(
      '/safety/documents/d-1/issues/i-2',
    );
  });

  test('a trailing slash names the same place', () => {
    expect(placeFromAddress('/rules/')).toEqual({ section: 'rules', pane: 'coverage' });
    expect(placeFromAddress('/')).toEqual({ section: 'start' });
  });

  test.each([
    '/nowhere',
    '/flights/one/two/three/four',
    '/flights/one/reports',
    '/safety/unknown-kind/1',
    '/safety/hazards/1/issues/2',
    '/safety/findings',
    '/records/browse/a/b',
    '/records/vehicles/1',
    '/rules/coverage/a/b',
    '/rules/findings/a/b/c/d',
    '/people/someone/else',
    '/setup/more',
    '/flights//x',
    '/flights/%E0%A4%A',
    '/reports/summary/2026-11-01',
    '/reports/summary/2026-11-30/2026-11-01',
    '/reports/summary/2026-02-30/2026-03-01',
    '/reports/findings/2026-13/2026-12',
    '/reports/findings/2026-01',
    '/reports/indicators/one/zero',
    '/reports/flights',
    '/reports/flights/a/b',
    '/reports/elsewhere',
    '/reports/grants/one',
    '/reports/operators/one',
  ])('%s goes to the place that says nothing is here', (path) => {
    expect(placeFromAddress(path)).toEqual({ section: 'unknown', path });
    expect(placeTitle(placeFromAddress(path))).toBe('Not found here · Ledger');
    expect(barSection(placeFromAddress(path))).toBeNull();
  });

  test('an address keeps the parameters that are not the place’s own, such as a scene being watched', () => {
    expect(addressOf({ section: 'rules', pane: 'coverage' }, '?autopilot=rules&pace=fast&owner=none')).toBe(
      '/rules?autopilot=rules&pace=fast',
    );
    expect(addressOf({ section: 'rules', pane: 'open', owner: 'none' }, '?replay=1')).toBe(
      '/rules/findings?replay=1&owner=none',
    );
  });
});

test('a register keeps only plain choices from the address, never typed text', () => {
  expect(placeFromAddress('/safety/hazards', '?state=accepted&search=gusts&order=Due%20soon')).toEqual({
    section: 'safety',
    view: 'hazards',
    choices: { state: 'accepted' },
  });
  expect(placePath({ section: 'safety', view: 'reports', choices: { order: 'oldest' } })).toBe(
    '/safety/reports?order=oldest',
  );
});

describe('page titles', () => {
  test('name the thing or pane, then the section', () => {
    expect(placeTitle({ section: 'flights', flightId: 'flight-7' }, 'Morning survey')).toBe(
      'Morning survey · Flights · Ledger',
    );
    expect(placeTitle({ section: 'safety', view: 'hazards' })).toBe('Hazard register · Safety · Ledger');
    expect(placeTitle({ section: 'rules', pane: 'open' })).toBe('Open findings · Rules · Ledger');
    expect(placeTitle({ section: 'people' })).toBe('People · Ledger');
    expect(placeTitle({ section: 'setup' })).toBe('Setup · Ledger');
    expect(placeTitle({ section: 'reports', report: 'summary', from: '2026-11-01', until: '2026-11-30' })).toBe(
      'Summary 2026-11-01 to 2026-11-30 · Reports · Ledger',
    );
    expect(placeTitle({ section: 'reports', report: 'flight', flightId: 'RIDGE-FLT-1' })).toBe(
      'Flight RIDGE-FLT-1 · Reports · Ledger',
    );
  });

  test('a report carries its period in its address, and belongs to Reports in the bar', () => {
    expect(placePath({ section: 'reports', report: 'summary', from: '2026-11-01', until: '2026-11-30' })).toBe(
      '/reports/summary/2026-11-01/2026-11-30',
    );
    expect(barSection({ section: 'reports', report: 'flight', flightId: 'RIDGE-FLT-1' })).toBe('reports');
  });

  test('never name a safety report', () => {
    expect(placeTitle({ section: 'safety', view: 'record', kind: 'report', id: 'r-1' }, 'A protected title')).toBe(
      'Safety report · Safety · Ledger',
    );
  });
});

describe('returning from a sign-in provider', () => {
  const returned = 'https://ledger.example/?autopilot=none';
  test('lands on the place opened before signing in', () => {
    expect(returnAddress(returned, '/flights/flight-7/findings/f-1')).toBe(
      'https://ledger.example/flights/flight-7/findings/f-1',
    );
  });
  test('never leaves the site', () => {
    expect(returnAddress(returned, '//elsewhere.example/x')).toBe(returned);
    expect(returnAddress(returned, 'https://elsewhere.example/')).toBe(returned);
    expect(returnAddress(returned, '/\\elsewhere.example')).toBe(returned);
    expect(returnAddress(returned, null)).toBe(returned);
  });
});
