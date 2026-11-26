import { readFileSync } from 'node:fs';

/**
 * Forecasts recorded from the Aviation Weather Center data API (aviationweather.gov) on 2026-11-26 at 04:33 UTC:
 * GET /api/data/taf with format=json for 24 large public airports, each forecast object exactly as the service sent
 * it, one per line. Published government weather forecasts, kept as reference data.
 */
export const RECORDED_TAF_FILE = new URL('../recordings/published-taf-2026-11-26.jsonl', import.meta.url);

/** The recorded forecasts, each the exact text of one forecast object. */
export function recordedTafForecasts(): string[] {
  return readFileSync(RECORDED_TAF_FILE, 'utf8').split('\n').filter(Boolean);
}

export interface TafAnswer {
  readonly status: 200 | 204 | 400;
  readonly body: string;
}

const STATION = /^[A-Z0-9]{3,4}$/;
const parameters = ['ids', 'format'];

/**
 * Answers GET /api/data/taf as the service does for format=json: the latest forecast of each requested station
 * issued at or before `now`, as one JSON array in the order of the recording; 204 with no body when none matches.
 * Parameters the emulator does not serve are refused.
 */
export function answerTafRequest(forecasts: readonly string[], query: URLSearchParams, now: string): TafAnswer {
  const refuse = (body: string): TafAnswer => ({ status: 400, body });
  const unknown = [...query.keys()].find((key) => !parameters.includes(key));
  if (unknown) return refuse(`Unsupported parameter ${unknown}`);
  if (query.get('format') !== 'json') return refuse('This emulator answers format=json only');
  const ids = (query.get('ids') ?? '').split(',').filter(Boolean);
  if (!ids.length || ids.some((id) => !STATION.test(id))) return refuse('ids must name stations, separated by commas');
  const until = Date.parse(now);
  const issued = forecasts
    .map((text, order) => ({ text, order, forecast: JSON.parse(text) as { icaoId: string; issueTime: string } }))
    .filter(({ forecast }) => ids.includes(forecast.icaoId) && Date.parse(forecast.issueTime) <= until);
  const latest = issued.filter(
    (entry) =>
      !issued.some(
        (other) =>
          other.forecast.icaoId === entry.forecast.icaoId &&
          Date.parse(other.forecast.issueTime) > Date.parse(entry.forecast.issueTime),
      ),
  );
  return latest.length
    ? { status: 200, body: `[${latest.map(({ text }) => text).join(',')}]` }
    : { status: 204, body: '' };
}
