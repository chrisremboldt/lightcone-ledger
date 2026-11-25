import { readFileSync } from 'node:fs';

/**
 * Reports recorded from the Aviation Weather Center data API (aviationweather.gov) on 2026-11-25 between 19:16 and
 * 19:18 UTC: GET /api/data/metar with format=json for nine large public airports, each report object exactly as the
 * service sent it, one per line. Published government weather observations, kept as reference data.
 */
export const RECORDED_METAR_FILE = new URL('../recordings/published-metar-2026-11-25.jsonl', import.meta.url);

/** The recorded reports, each the exact text of one report object. */
export function recordedMetarReports(): string[] {
  return readFileSync(RECORDED_METAR_FILE, 'utf8').split('\n').filter(Boolean);
}

export interface MetarAnswer {
  readonly status: 200 | 204 | 400;
  readonly body: string;
}

const STATION = /^[A-Z0-9]{3,4}$/;
const parameters = ['ids', 'format', 'hours'];

/**
 * Answers GET /api/data/metar as the service does for format=json: the latest report of each requested station at
 * or before `now`, or with `hours` every report in the hours before it, newest first, as one JSON array; 204 with
 * no body when none matches. Parameters the service would refuse are refused.
 */
export function answerMetarRequest(reports: readonly string[], query: URLSearchParams, now: string): MetarAnswer {
  const refuse = (body: string): MetarAnswer => ({ status: 400, body });
  const unknown = [...query.keys()].find((key) => !parameters.includes(key));
  if (unknown) return refuse(`Unsupported parameter ${unknown}`);
  if (query.get('format') !== 'json') return refuse('This emulator answers format=json only');
  const ids = (query.get('ids') ?? '').split(',').filter(Boolean);
  if (!ids.length || ids.some((id) => !STATION.test(id))) return refuse('ids must name stations, separated by commas');
  const hoursText = query.get('hours');
  const hours = hoursText === null ? undefined : Number(hoursText);
  if (hours !== undefined && (!Number.isSafeInteger(hours) || hours < 1 || hours > 720))
    return refuse('hours must be a whole number from 1 to 720');
  const until = Date.parse(now) / 1000;
  const parsed = reports
    .map((text) => ({ text, report: JSON.parse(text) as { icaoId: string; obsTime: number } }))
    .filter(({ report }) => ids.includes(report.icaoId) && report.obsTime <= until)
    .sort((a, b) => b.report.obsTime - a.report.obsTime || a.report.icaoId.localeCompare(b.report.icaoId));
  const chosen =
    hours === undefined
      ? parsed.filter(
          (entry, index) => parsed.findIndex((other) => other.report.icaoId === entry.report.icaoId) === index,
        )
      : parsed.filter(({ report }) => report.obsTime > until - hours * 3600);
  return chosen.length
    ? { status: 200, body: `[${chosen.map(({ text }) => text).join(',')}]` }
    : { status: 204, body: '' };
}
