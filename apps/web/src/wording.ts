import type { NamedSubject } from '@ledger/contracts';
import { time, timeZoneLabel } from './format.js';

const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const placeholder = /\{([a-z][a-zA-Z0-9]{0,63})\}/g;

/**
 * One value that pack-supplied wording or a check's details carry, as a person reads it: a UTC instant in the
 * organization's time, the way the rest of the app shows times; the id of a subject the evaluation read as that
 * subject's name; anything else as it is. A list of instants separated by commas is read item by item.
 */
export function wordingValue(value: unknown, subjects: readonly NamedSubject[] = []): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return String(value);
  if (typeof value !== 'string') return JSON.stringify(value);
  const subject = subjects.find((item) => item.id === value);
  if (subject) return subject.name;
  return value
    .split(', ')
    .map((part) =>
      instant.test(part) && Number.isFinite(Date.parse(part)) ? `${time(part, true)} ${timeZoneLabel()}` : part,
    )
    .join(', ');
}

/**
 * A summary to show: the rule's or the check kind's wording filled again from the recorded details, each value read by wordingValue,
 * when the read returned the wording the recorded summary came from; otherwise the recorded summary as it is. The
 * recorded summary is never changed.
 */
export function wordedSummary(
  summary: string,
  template: string | undefined,
  details: Readonly<Record<string, unknown>> | undefined,
  subjects: readonly NamedSubject[] = [],
): string {
  if (!template || !details) return summary;
  let complete = true;
  const text = template.replace(placeholder, (_, name: string) => {
    const value = details[name];
    if (value === undefined || value === null) complete = false;
    return wordingValue(value, subjects);
  });
  return complete ? text : summary;
}
