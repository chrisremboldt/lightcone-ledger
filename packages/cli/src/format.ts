import type { ApiError } from '@ledger/contracts/client';
/** A plain text table: one header row, columns padded to their widest cell. */
export function table(headers: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? '').length)),
  );
  const line = (cells: readonly string[]) =>
    cells
      .map((cell, column) => (column === cells.length - 1 ? cell : cell.padEnd(widths[column]!)))
      .join('  ')
      .trimEnd();
  return [line(headers), line(widths.map((width) => '-'.repeat(width))), ...rows.map(line)];
}

/** A cell's words in lines of at most `width` characters, broken between words; a longer word is broken where it must be. */
export function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (let word of text.split(/\s+/).filter(Boolean)) {
    while (word.length > width) {
      if (line) lines.push(line);
      lines.push(word.slice(0, width));
      word = word.slice(width);
      line = '';
    }
    if (!line) line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line || !lines.length) lines.push(line);
  return lines;
}

/**
 * A plain text table no wider than `width`: the columns named in `wrapped` share what the others leave, in the
 * proportions given, and their cells are wrapped onto as many lines as they need. A row's lines follow one another.
 */
export function wrappedTable(
  allHeaders: readonly string[],
  allRows: readonly (readonly string[])[],
  width: number,
  shared: Readonly<Record<number, number>>,
  /** Columns left out. */
  dropped: readonly number[] = [],
): string[] {
  const kept = allHeaders.map((_, column) => column).filter((column) => !dropped.includes(column));
  const headers = kept.map((column) => allHeaders[column]!);
  const rows = allRows.map((row) => kept.map((column) => row[column] ?? ''));
  const wrapped: Record<number, number> = {};
  kept.forEach((column, index) => {
    if (column in shared) wrapped[index] = shared[column]!;
  });
  const longestWord = (column: number) =>
    Math.max(0, ...rows.flatMap((row) => (row[column] ?? '').split(/\s+/).map((word) => word.length)));
  const natural = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? '').length)),
  );
  const fixed = natural.reduce((sum, value, column) => sum + (column in wrapped ? 0 : value), 0);
  const room = Math.max(0, width - fixed - 2 * (headers.length - 1));
  const shares = Object.values(wrapped).reduce((sum, share) => sum + share, 0);
  const widths = natural.map((value, column) =>
    column in wrapped
      ? Math.min(value, Math.max(12, longestWord(column), Math.floor((room * wrapped[column]!) / shares)))
      : value,
  );
  const line = (cells: readonly string[]) =>
    cells
      .map((cell, column) => (column === cells.length - 1 ? cell : cell.padEnd(widths[column]!)))
      .join('  ')
      .trimEnd();
  const rowLines = (row: readonly string[]) => {
    const cells = headers.map((_, column) =>
      column in wrapped ? wrap(row[column] ?? '', widths[column]!) : [row[column] ?? ''],
    );
    const height = Math.max(...cells.map((cell) => cell.length));
    return Array.from({ length: height }, (_, index) => line(cells.map((cell) => cell[index] ?? '')));
  };
  return [line(headers), line(widths.map((value) => '-'.repeat(value))), ...rows.flatMap(rowLines)];
}

/** A subject by the organization's own id, with the name a person knows it by when that differs. */
export function subjectWords(subject: { id: string; name?: string }): string {
  return subject.name && subject.name !== subject.id ? `${subject.id} (${subject.name})` : subject.id;
}

export const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** The part of a rule id after its pack id, which is how a person refers to it. */
export function shortRuleId(packId: string, leafId: string): string {
  return leafId.startsWith(`${packId}.`) ? leafId.slice(packId.length + 1) : leafId;
}

/** A recorded value shortened for one table cell. */
export function cell(value: unknown, width = 60): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > width ? `${text.slice(0, width - 1)}…` : text;
}

/** "a" or "an" before a phrase, by its first letter: "an aircraft id", "an organization or flight id", "a person id". */
export function withIndefiniteArticle(phrase: string): string {
  return `${/^[aeiou]/i.test(phrase.trim()) ? 'an' : 'a'} ${phrase}`;
}

/** A day as the organization's calendar shows an instant. */
export function dayIn(instant: string, zone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date(instant))
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** The API's own sentence for a refusal, with its status and code. */
export function refusalWords(error: ApiError): string {
  const body = error.body as { error?: { code?: string; message?: string } } | string;
  const inner = typeof body === 'object' && body ? body.error : undefined;
  const sentence = inner?.message ?? (typeof body === 'string' && body ? body : error.message);
  return `Ledger refused this (${error.status}${inner?.code ? ` ${inner.code}` : ''}): ${sentence}`;
}
