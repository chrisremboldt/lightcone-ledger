import type { TimelineItem } from '@ledger/contracts';
import type { LandingReportRow } from './safety.js';
import { reportPayload } from './correction-presentation.js';

function sameValue(value: unknown, report: LandingReportRow): boolean {
  if (value === report.value) return true;
  if (typeof value !== 'string' || !report.normalizedTime) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === report.normalizedTime;
}

/** The field of the retained source report that states the value the evaluation read, if exactly one does. */
export function reportField(item: TimelineItem, report: LandingReportRow): string | null {
  const fields = Object.entries(reportPayload(item))
    .filter(([, value]) => sameValue(value, report))
    .map(([field]) => field);
  return fields.length === 1 ? fields[0]! : null;
}

/** The retained source report behind a cited observation, when the timeline holds it with the value read. */
export function citedLandingReport(item: TimelineItem | null | undefined, report: LandingReportRow, flightId: string) {
  if (!item || !['flight.observation', 'evidence.correct'].includes(item.kind)) return null;
  const eventId = report.eventId.endsWith(`:${flightId}`)
    ? report.eventId.slice(0, -flightId.length - 1)
    : report.eventId;
  if (item.id !== eventId && item.id !== report.eventId) return null;
  if (report.receiptId && item.receiptId && item.receiptId !== report.receiptId) return null;
  if (item.kind === 'flight.observation' && item.sourceId !== report.sourceId) return null;
  if (!reportField(item, report)) return null;
  return item;
}

export function retainedReportText(item: TimelineItem, field: string, limit = 1000) {
  const value = reportPayload(item)[field];
  return typeof value === 'string' && value.trim() ? value.slice(0, limit) : null;
}

export function localLandingInput(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function landingFromLocalInput(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const expanded = value.length === 16 ? `${value}:00` : value;
  return localLandingInput(date.toISOString()) === expanded ? date.toISOString() : null;
}
