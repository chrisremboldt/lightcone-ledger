import type { FindingRecord } from '@ledger/contracts';

type FindingState = Pick<FindingRecord, 'id' | 'status'> & {
  latestEvaluation: Pick<FindingRecord['latestEvaluation'], 'outcome' | 'recordedAt' | 'id'>;
};

function priority(finding: FindingState) {
  if (finding.status === 'resolved') return 2;
  return finding.latestEvaluation.outcome === 'attention' ? 0 : 1;
}

export function orderAndSelectFindings<T extends FindingState>(findings: readonly T[], selectedId: string | null) {
  const ordered = [...findings].sort(
    (left, right) =>
      priority(left) - priority(right) ||
      right.latestEvaluation.recordedAt.localeCompare(left.latestEvaluation.recordedAt) ||
      right.latestEvaluation.id.localeCompare(left.latestEvaluation.id),
  );
  return {
    findings: ordered,
    selected: ordered.find((finding) => finding.id === selectedId) ?? ordered[0],
  };
}
