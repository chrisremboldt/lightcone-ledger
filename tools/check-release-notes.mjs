#!/usr/bin/env node
// Fails when CHANGELOG.md has no section for a release, or a section without its upgrade note.
//   node tools/check-release-notes.mjs v0.2.0   the release's section must be there, with its Upgrading part
//   node tools/check-release-notes.mjs          every section, Unreleased included, must have one
// The image workflow runs the first form for every published release.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The changelog's sections: each `## ` heading's first word (a tag, or Unreleased) and the text under it. */
export function changelogSections(text) {
  const sections = [];
  for (const part of text.split(/^## /m).slice(1)) {
    const [heading, ...body] = part.split('\n');
    sections.push({ name: heading.trim().split(/\s+/)[0], heading: heading.trim(), body: body.join('\n') });
  }
  return sections;
}

/** What is wrong with one section's upgrade note, or undefined when it has one. */
export function upgradeNoteProblem(section) {
  const match = /^### Upgrading\s*$([^]*?)(?=^### |(?![^]))/m.exec(section.body);
  if (!match) return `${section.heading} has no "### Upgrading" part`;
  if (!match[1].trim()) return `${section.heading} has an empty "### Upgrading" part`;
  return undefined;
}

/** Every problem with the changelog, for one release when a tag is given, or for every section. */
export function releaseNoteProblems(text, tag) {
  const sections = changelogSections(text);
  if (!sections.some((section) => section.name === 'Unreleased'))
    return ['CHANGELOG.md has no "## Unreleased" section for what main has gained since the last release'];
  if (tag) {
    const section = sections.find((candidate) => candidate.name === tag);
    if (!section) return [`CHANGELOG.md has no "## ${tag}" section: move what Unreleased says under it`];
    return [upgradeNoteProblem(section)].filter(Boolean);
  }
  return sections.map(upgradeNoteProblem).filter(Boolean);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const text = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  const problems = releaseNoteProblems(text, process.argv[2]);
  if (problems.length) {
    for (const problem of problems) console.error(problem);
    process.exit(1);
  }
  console.log(
    process.argv[2] ? `CHANGELOG.md has the upgrade note for ${process.argv[2]}.` : 'CHANGELOG.md is complete.',
  );
}
