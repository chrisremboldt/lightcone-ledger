import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const deploy = readFileSync(new URL('../../docs/guides/deploy.md', import.meta.url), 'utf8');
const firstDay = deploy.slice(deploy.indexOf('5. **Safety**'), deploy.indexOf('\n\n', deploy.indexOf('5. **Safety**')));

describe('The deployment guide’s first day', () => {
  it('describes a matrix of the organization’s own levels, each saying who may accept it or that nobody may', () => {
    expect(firstDay).toContain('two to six, least to most serious');
    expect(firstDay).toContain('or nobody');
    expect(firstDay).not.toContain('the label and meaning of each acceptance level');
    expect(firstDay).not.toMatch(/who may accept low, medium and high risk/);
  });
});
