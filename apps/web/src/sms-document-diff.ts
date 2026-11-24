export interface DiffLine {
  kind: 'same' | 'added' | 'removed';
  text: string;
}
export type DiffBlock = DiffLine | { kind: 'skipped'; count: number };

const MAX_TABLE_CELLS = 4_000_000;

/** A line diff. Very large rewrites fall back to removing every old line and adding every new one. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before ? before.split('\n') : [];
  const b = after ? after.split('\n') : [];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const same = (lines: string[]) => lines.map((text): DiffLine => ({ kind: 'same', text }));
  return [...same(a.slice(0, start)), ...middle(a.slice(start, endA), b.slice(start, endB)), ...same(a.slice(endA))];
}

function middle(a: string[], b: string[]): DiffLine[] {
  const removed = a.map((text): DiffLine => ({ kind: 'removed', text }));
  const added = b.map((text): DiffLine => ({ kind: 'added', text }));
  if (!a.length || !b.length || (a.length + 1) * (b.length + 1) > MAX_TABLE_CELLS) return [...removed, ...added];
  const width = b.length + 1;
  const common = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1)
    for (let j = b.length - 1; j >= 0; j -= 1)
      common[i * width + j] =
        a[i] === b[j]
          ? common[(i + 1) * width + j + 1]! + 1
          : Math.max(common[(i + 1) * width + j]!, common[i * width + j + 1]!);
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ kind: 'same', text: a[i]! });
      i += 1;
      j += 1;
    } else if (common[(i + 1) * width + j]! >= common[i * width + j + 1]!) {
      lines.push({ kind: 'removed', text: a[i]! });
      i += 1;
    } else {
      lines.push({ kind: 'added', text: b[j]! });
      j += 1;
    }
  }
  return [...lines, ...removed.slice(i), ...added.slice(j)];
}

/** Keeps a few unchanged lines around each change and folds the rest. */
export function withContext(lines: DiffLine[], context = 2): DiffBlock[] {
  const near = lines.map((_, index) =>
    lines.slice(Math.max(0, index - context), index + context + 1).some((line) => line.kind !== 'same'),
  );
  const blocks: DiffBlock[] = [];
  lines.forEach((line, index) => {
    if (near[index]) {
      blocks.push(line);
      return;
    }
    const last = blocks[blocks.length - 1];
    if (last?.kind === 'skipped') last.count += 1;
    else blocks.push({ kind: 'skipped', count: 1 });
  });
  return blocks;
}
