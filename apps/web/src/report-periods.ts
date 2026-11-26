/**
 * The periods a person picks a report for, from the organization's own day: each is two calendar days, or months,
 * and never a time of day. Pure, so the choices are tested.
 */

const pad = (value: number, width = 2) => String(value).padStart(width, '0');

/** The last day of a month, YYYY-MM-DD. */
export function lastDayOf(month: string): string {
  const [year, number] = month.split('-').map(Number) as [number, number];
  return `${month}-${pad(new Date(Date.UTC(year, number, 0)).getUTCDate())}`;
}

/** The month a number of months from another, earlier when negative, as YYYY-MM. */
export function addMonths(month: string, count: number): string {
  const [year, number] = month.split('-').map(Number) as [number, number];
  const index = year * 12 + (number - 1) + count;
  return `${pad(Math.floor(index / 12), 4)}-${pad((index % 12) + 1)}`;
}

export interface PeriodChoice {
  label: string;
  from: string;
  until: string;
}

/** The periods offered from a day in the organization's time zone: this month so far, last month, this year, last year. */
export function periodChoices(today: string): PeriodChoice[] {
  const month = today.slice(0, 7);
  const year = Number(today.slice(0, 4));
  const previous = addMonths(month, -1);
  return [
    { label: 'This month', from: `${month}-01`, until: lastDayOf(month) },
    { label: 'Last month', from: `${previous}-01`, until: lastDayOf(previous) },
    { label: 'This year', from: `${year}-01-01`, until: `${year}-12-31` },
    { label: 'Last year', from: `${year - 1}-01-01`, until: `${year - 1}-12-31` },
  ];
}

/** Recorded seconds as hours and minutes, as in "12 h 05 min"; whole minutes, rounded down. */
export function hoursAndMinutes(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${Math.floor(minutes / 60)} h ${pad(minutes % 60)} min`;
}

/** What a capability lets a person read, in the words a part that is not theirs says it in. */
export const readingNeeds: Record<string, string> = {
  'evidence:read': 'permission to read records and findings',
  'sms:read': 'permission to read safety records',
};

/** "1 flight", "2 flights": a count with its noun. */
export function counted(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}
