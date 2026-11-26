import { describe, expect, it } from 'vitest';
import { findingRoleNote } from '../../apps/web/src/finding-role-note.js';

const taker = { who: 'A person who records decisions', otherwise: 'A person who records decisions can take it.' };

describe('what a person who cannot take a finding is told', () => {
  it('tells a person who only reads that they read it, not that they review it', () => {
    const note = findingRoleNote(['evidence:read', 'flight:read'], taker);
    expect(note).toBe(
      'You can read this finding and what is on file about it. A person who records decisions takes it, assigns it and closes it.',
    );
    expect(note).not.toContain('review');
  });

  it('keeps the review sentence for a role that records other things', () => {
    expect(findingRoleNote(['evidence:read', 'flight:write'], taker)).toBe(
      'Your role can review this finding. A person who records decisions can take it.',
    );
  });
});
