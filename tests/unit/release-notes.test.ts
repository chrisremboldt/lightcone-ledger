import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { releaseNoteProblems } from '../../tools/check-release-notes.mjs';

const changelog = readFileSync(new URL('../../CHANGELOG.md', import.meta.url), 'utf8');

describe('the upgrade note with each release', () => {
  it('is there for every section of CHANGELOG.md, Unreleased included', () => {
    expect(releaseNoteProblems(changelog)).toEqual([]);
  });

  it('is named by the release workflow, and is missing for a release with no section or no note', () => {
    const workflow = readFileSync(new URL('../../.github/workflows/image.yml', import.meta.url), 'utf8');
    expect(workflow).toContain('node tools/check-release-notes.mjs "$TAG"');
    const unreleased = '## Unreleased\n\n### Upgrading\n\nNothing yet.\n';
    expect(releaseNoteProblems(unreleased, 'v9.9.9')).toEqual([
      'CHANGELOG.md has no "## v9.9.9" section: move what Unreleased says under it',
    ]);
    expect(
      releaseNoteProblems(`${unreleased}\n## v9.9.9 (2027-01-04)\n\n### Changed\n\n- Something.\n`, 'v9.9.9'),
    ).toEqual(['v9.9.9 (2027-01-04) has no "### Upgrading" part']);
    expect(
      releaseNoteProblems(
        `${unreleased}\n## v9.9.9 (2027-01-04)\n\n### Upgrading\n\n### Changed\n\n- Something.\n`,
        'v9.9.9',
      ),
    ).toEqual(['v9.9.9 (2027-01-04) has an empty "### Upgrading" part']);
    expect(
      releaseNoteProblems(`${unreleased}\n## v9.9.9 (2027-01-04)\n\n### Upgrading\n\nRun the migrations.\n`, 'v9.9.9'),
    ).toEqual([]);
    expect(releaseNoteProblems('## v9.9.9\n\n### Upgrading\n\nRun the migrations.\n')).toEqual([
      'CHANGELOG.md has no "## Unreleased" section for what main has gained since the last release',
    ]);
  });
});
