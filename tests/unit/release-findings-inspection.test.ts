import { createRequire } from 'node:module';
import { expect, test } from 'vitest';
import {
  missionReleaseFindingEvaluation,
  missionReleaseRecord,
} from '../../packages/contracts/fixtures/demo/v1/mission-release.js';
import { RecordedReleaseFindings } from '../../apps/web/src/ReleaseFindings.js';
import { shouldReadReleaseFindings } from '../../apps/web/src/missionRelease.js';

// React is a dependency of the web app only, so it resolves from there.
const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { createElement } = webRequire('react') as typeof import('react');
const { renderToStaticMarkup } = webRequire('react-dom/server') as typeof import('react-dom/server');

test('an inspected release shows the findings recorded with it', () => {
  const shown = renderToStaticMarkup(createElement(RecordedReleaseFindings, { release: missionReleaseRecord }));
  expect(shown).toContain('Open findings as recorded with this release');
  expect(shown).toContain(missionReleaseFindingEvaluation.rule.title);
  expect(shown).toContain(missionReleaseFindingEvaluation.summary);
  expect(shown).toContain('Needs attention');
  expect(shown).toContain(`Evaluation ${missionReleaseFindingEvaluation.id}`);
  const empty = {
    ...missionReleaseRecord,
    basis: { ...missionReleaseRecord.basis, findings: { ...missionReleaseRecord.basis.findings, findings: [] } },
  };
  expect(renderToStaticMarkup(createElement(RecordedReleaseFindings, { release: empty }))).toContain(
    'No open findings from rules adopted in active mode were listed when this release was recorded.',
  );
});

test('the mission review reads release findings only while the form is open or after the flight changed', () => {
  expect(shouldReadReleaseFindings({ formOpen: false, readAtRevision: null, revision: 4 })).toBe(true);
  expect(shouldReadReleaseFindings({ formOpen: false, readAtRevision: 4, revision: 4 })).toBe(false);
  expect(shouldReadReleaseFindings({ formOpen: false, readAtRevision: 4, revision: 5 })).toBe(true);
  expect(shouldReadReleaseFindings({ formOpen: true, readAtRevision: 4, revision: 4 })).toBe(true);
});
