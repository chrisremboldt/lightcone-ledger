import { useEffect, useId, useState } from 'react';
import type { IndicatorHistory } from '@ledger/contracts';
import { ctDay, time, timeRange, timeZoneLabel } from './format.js';
import {
  indicatorFrame,
  indicatorGeometry,
  indicatorSentence,
  monthLabel,
  monthLabelEvery,
  monthTickLabels,
  monthlyFrame,
  monthlyGeometry,
  monthlySentence,
  narrowIndicatorFrame,
  narrowMonthlyFrame,
} from './report-charts.js';
import { PlaceLink } from './TopBar.js';

/**
 * The reports' charts: hand-drawn SVG in the theme's own colours, each told in one sentence and given as a table under
 * it, folded on screen and open in print. Nothing is told by colour alone: results that state no rate are hollow
 * squares on the baseline, closed findings are hatched, and every mark is labelled or listed.
 */

const narrowQuery = '(max-width: 719px)';

/** Whether the screen is a phone's width, followed as it changes. */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia?.(narrowQuery).matches ?? false);
  useEffect(() => {
    const query = window.matchMedia?.(narrowQuery);
    if (!query) return;
    const change = () => setNarrow(query.matches);
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  return narrow;
}

export const resultStatusWords: Record<IndicatorHistory['results'][number]['status'], string> = {
  supported: 'Rate stated',
  insufficient: 'No rate: insufficient evidence',
  conflicting: 'No rate: conflicting evidence',
};

/** An indicator's recorded results over time, with the limit its definition sets drawn and labelled. */
export function IndicatorChart({
  history,
  onOpenHazard,
}: {
  history: IndicatorHistory;
  /** Absent for a person who may not read safety records. */
  onOpenHazard?: boolean;
}) {
  const frame = useNarrow() ? narrowIndicatorFrame : indicatorFrame;
  const geometry = indicatorGeometry(history.results, history.definition.limit?.rate ?? null, frame);
  const sentence = indicatorSentence(history);
  const unit = history.definition.unitLabel ?? '';
  const titleId = useId();
  const plotTop = frame.top;
  return (
    <figure className="report-chart" aria-labelledby={titleId} data-testid="indicator-chart">
      <figcaption id={titleId} className="report-chart-sentence">
        {sentence}
      </figcaption>
      {history.results.length > 0 && (
        <svg
          className="report-chart-svg"
          viewBox={`0 0 ${frame.width} ${frame.height}`}
          role="group"
          aria-label={`Recorded results of ${history.definition.title ?? history.definition.id}`}
        >
          {geometry.yTicks.map((tick) => (
            <g key={tick.value} className="report-chart-grid">
              <line x1={frame.left} x2={frame.width - frame.right} y1={tick.y} y2={tick.y} />
              <text x={frame.left - 8} y={tick.y} dy="0.32em" textAnchor="end">
                {tick.value}
              </text>
            </g>
          ))}
          <text className="report-chart-axis-label" x={frame.left} y={plotTop - 10}>
            {unit ? `Rate, ${unit}` : 'Rate'}
          </text>
          {geometry.xTicks.map((tick, index) => (
            <text
              key={tick.at}
              className="report-chart-tick"
              x={tick.x}
              y={geometry.baseline + 18}
              textAnchor={index === 0 ? 'start' : index === geometry.xTicks.length - 1 ? 'end' : 'middle'}
            >
              {ctDay(tick.at)}
            </text>
          ))}
          {geometry.gaps.map((gap) => (
            <g key={gap.from} className="report-chart-gap">
              <rect
                x={gap.startX}
                y={plotTop}
                width={Math.max(1, gap.endX - gap.startX)}
                height={geometry.baseline - plotTop}
              />
              <text x={(gap.startX + gap.endX) / 2} y={plotTop + 12} textAnchor="middle">
                No result
              </text>
            </g>
          ))}
          {geometry.limit && history.definition.limit && (
            <g className="report-chart-limit" data-testid="indicator-limit">
              <line x1={frame.left} x2={frame.width - frame.right} y1={geometry.limit.y} y2={geometry.limit.y} />
              <text x={frame.width - frame.right} y={geometry.limit.y - 6} textAnchor="end">
                {history.definition.limit.label}: {history.definition.limit.rate} {unit}
              </text>
            </g>
          )}
          <line
            className="report-chart-baseline"
            x1={frame.left}
            x2={frame.width - frame.right}
            y1={geometry.baseline}
            y2={geometry.baseline}
          />
          {geometry.points.map((point, index) => {
            const result = history.results[index]!;
            const words = `${timeRange(result.window.start, result.window.end)}: ${
              result.rate ? `${result.rate.decimal} ${result.rate.label}` : resultStatusWords[result.status]
            }`;
            return (
              <a
                key={point.id}
                href={`#indicator-result-${point.id}`}
                className="report-chart-point"
                aria-label={words}
                data-testid="indicator-point"
              >
                <title>{words}</title>
                <line className="report-chart-window" x1={point.startX} x2={point.endX} y1={point.y} y2={point.y} />
                {point.rate === null ? (
                  <rect className="report-chart-none" x={point.x - 5} y={point.y - 5} width={10} height={10} />
                ) : (
                  <circle className="report-chart-stated" cx={point.x} cy={point.y} r={5} />
                )}
              </a>
            );
          })}
        </svg>
      )}
      {history.results.length > 0 && (
        <ul className="report-chart-legend" aria-label="Legend">
          <li>
            <svg viewBox="0 0 14 14" aria-hidden="true">
              <circle className="report-chart-stated" cx="7" cy="7" r="5" />
            </svg>
            A result that states a rate, over the window it covers
          </li>
          <li>
            <svg viewBox="0 0 14 14" aria-hidden="true">
              <rect className="report-chart-none" x="2" y="2" width="10" height="10" />
            </svg>
            A result that states none, on the baseline
          </li>
          {history.definition.limit ? (
            <li>
              <svg viewBox="0 0 14 14" aria-hidden="true">
                <line className="report-chart-limit-line" x1="0" x2="14" y1="7" y2="7" />
              </svg>
              {history.definition.limit.label}, as the indicator’s definition sets it
            </li>
          ) : (
            <li>The indicator’s definition sets no limit.</li>
          )}
        </ul>
      )}
      {history.results.length > 0 && (
        <details className="report-table">
          <summary>The results in this chart</summary>
          <table>
            <thead>
              <tr>
                <th scope="col">Window</th>
                <th scope="col">Result</th>
                <th scope="col">Rate</th>
                <th scope="col">Counted</th>
                <th scope="col">Exposure</th>
                <th scope="col">Recorded</th>
              </tr>
            </thead>
            <tbody>
              {history.results.map((result) => (
                <tr key={result.id} id={`indicator-result-${result.id}`} data-testid="indicator-result-row">
                  <td>{timeRange(result.window.start, result.window.end)}</td>
                  <td>{resultStatusWords[result.status]}</td>
                  <td>{result.rate ? `${result.rate.decimal} ${result.rate.label}` : 'None stated'}</td>
                  <td>{result.eventCount}</td>
                  <td>
                    {result.exposure.decimal} {result.exposure.unit}
                  </td>
                  <td>
                    {time(result.recordedAt, true)} {timeZoneLabel()}
                    {onOpenHazard && (
                      <>
                        {' · '}
                        <PlaceLink place={{ section: 'safety', view: 'record', kind: 'hazard', id: result.hazardId }}>
                          Open its hazard
                        </PlaceLink>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </figure>
  );
}

/** Findings opened and closed in each month: a pair of bars a month, each labelled with its count. */
export function MonthlyChart({
  months,
  opened,
  closed,
  label,
}: {
  months: readonly string[];
  opened: readonly number[];
  closed: readonly number[];
  /** What the bars count, such as all rules or one rule's title. */
  label: string;
}) {
  const frame = useNarrow() ? narrowMonthlyFrame : monthlyFrame;
  const geometry = monthlyGeometry(months, opened, closed, frame);
  const hatch = `report-hatch-${useId().replace(/:/g, '')}`;
  const titleId = useId();
  const labels = monthTickLabels(months, monthLabelEvery(months.length, frame));
  return (
    <figure className="report-chart" aria-labelledby={titleId} data-testid="monthly-chart">
      <figcaption id={titleId} className="report-chart-sentence">
        {label}: {monthlySentence(months, opened, closed)}
      </figcaption>
      <svg
        className="report-chart-svg"
        viewBox={`0 0 ${frame.width} ${frame.height}`}
        role="img"
        aria-label={`${label}, findings opened and closed by month. The numbers are in the table under the chart.`}
      >
        <defs>
          <pattern id={hatch} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line className="report-chart-hatch" x1="0" y1="0" x2="0" y2="6" />
          </pattern>
        </defs>
        {geometry.yTicks.map((tick) => (
          <g key={tick.value} className="report-chart-grid">
            <line x1={frame.left} x2={frame.width - frame.right} y1={tick.y} y2={tick.y} />
            <text x={frame.left - 8} y={tick.y} dy="0.32em" textAnchor="end">
              {tick.value}
            </text>
          </g>
        ))}
        <line
          className="report-chart-baseline"
          x1={frame.left}
          x2={frame.width - frame.right}
          y1={geometry.baseline}
          y2={geometry.baseline}
        />
        {geometry.groups.map((group, index) => (
          <g key={group.month} data-testid="monthly-group">
            {group.bars.map((bar) => (
              <g key={bar.kind}>
                {bar.height > 0 && (
                  <rect
                    className={bar.kind === 'opened' ? 'report-chart-opened' : 'report-chart-closed'}
                    x={bar.x}
                    y={bar.y}
                    width={bar.width}
                    height={bar.height}
                    {...(bar.kind === 'closed' ? { fill: `url(#${hatch})` } : {})}
                  />
                )}
                {bar.value > 0 && (
                  <text className="report-chart-value" x={bar.x + bar.width / 2} y={bar.y - 4} textAnchor="middle">
                    {bar.value}
                  </text>
                )}
              </g>
            ))}
            {labels[index]?.month && (
              <text className="report-chart-tick" x={group.x} y={geometry.baseline + 18} textAnchor="middle">
                {labels[index]!.month}
              </text>
            )}
            {labels[index]?.year && (
              <text className="report-chart-tick" x={group.x} y={geometry.baseline + 32} textAnchor="middle">
                {labels[index]!.year}
              </text>
            )}
          </g>
        ))}
      </svg>
      <ul className="report-chart-legend" aria-label="Legend">
        <li>
          <svg viewBox="0 0 14 14" aria-hidden="true">
            <rect className="report-chart-opened" x="1" y="1" width="12" height="12" />
          </svg>
          Opened in the month
        </li>
        <li>
          <svg viewBox="0 0 14 14" aria-hidden="true">
            <defs>
              <pattern
                id={`${hatch}-key`}
                width="4"
                height="4"
                patternUnits="userSpaceOnUse"
                patternTransform="rotate(45)"
              >
                <line className="report-chart-hatch" x1="0" y1="0" x2="0" y2="4" />
              </pattern>
            </defs>
            <rect className="report-chart-closed" x="1" y="1" width="12" height="12" fill={`url(#${hatch}-key)`} />
          </svg>
          Closed in the month, hatched
        </li>
      </ul>
      <details className="report-table">
        <summary>The numbers in this chart</summary>
        <table>
          <thead>
            <tr>
              <th scope="col">Month</th>
              <th scope="col">Opened</th>
              <th scope="col">Closed</th>
            </tr>
          </thead>
          <tbody>
            {months.map((month, index) => (
              <tr key={month}>
                <th scope="row">{monthLabel(month)}</th>
                <td>{opened[index] ?? 0}</td>
                <td>{closed[index] ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
