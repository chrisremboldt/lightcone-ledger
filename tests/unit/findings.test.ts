import { expect, test } from 'vitest';
import { orderAndSelectFindings } from '../../apps/web/src/findings.js';

test('findings needing attention lead cleared open work and resolved history', () => {
  const history = {
    id: 'history',
    status: 'resolved',
    latestEvaluation: { id: 'history-evaluation', outcome: 'attention', recordedAt: '2026-10-15T18:32:00Z' },
  } as const;
  const cleared = {
    id: 'cleared',
    status: 'acknowledged',
    latestEvaluation: { id: 'cleared-evaluation', outcome: 'pass', recordedAt: '2026-10-15T18:31:00Z' },
  } as const;
  const active = {
    id: 'active',
    status: 'open',
    latestEvaluation: { id: 'evaluation-b', outcome: 'attention', recordedAt: '2026-10-15T18:30:00Z' },
  } as const;
  const response = {
    id: 'response',
    status: 'responding',
    latestEvaluation: { id: 'evaluation-a', outcome: 'attention', recordedAt: '2026-10-15T18:30:00Z' },
  } as const;
  const display = orderAndSelectFindings([history, cleared, response, active], null);
  expect(display.findings.map((finding) => finding.id)).toEqual(['active', 'response', 'cleared', 'history']);
  expect(display.selected).toBe(active);
});

test('a live priority change preserves the selected finding', () => {
  const selected = {
    id: 'selected',
    status: 'responding',
    latestEvaluation: { id: 'initial-evaluation', outcome: 'attention', recordedAt: '2026-10-15T18:30:00Z' },
  } as const;
  const initial = orderAndSelectFindings([selected], null);
  const cleared = {
    ...selected,
    latestEvaluation: { id: 'cleared-evaluation', outcome: 'pass', recordedAt: '2026-10-15T18:32:00Z' },
  } as const;
  const arriving = {
    id: 'arriving',
    status: 'open',
    latestEvaluation: { id: 'arriving-evaluation', outcome: 'attention', recordedAt: '2026-10-15T18:31:00Z' },
  } as const;
  const updated = orderAndSelectFindings([cleared, arriving], initial.selected.id);
  expect(updated.findings.map((finding) => finding.id)).toEqual(['arriving', 'selected']);
  expect(updated.selected).toBe(cleared);
});
