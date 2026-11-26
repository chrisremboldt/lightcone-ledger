import { useState } from 'react';
import { Badge, Button } from '@ledger/ui';
import {
  controlResultTone,
  controlResultWords,
  notApplicablePage,
  NOT_APPLICABLE_PAGE_SIZE,
  type NotApplicableEntry,
} from './flight-controls.js';
import { missionTime } from './missionRelease.js';
import { withLocalTimes } from './wording.js';

/**
 * Controls recorded as not applying to a flight, each with its title, recorded sentence and what decided it, shown a
 * page at a time. Collapsed, it renders its entries only once opened. It reads nothing.
 */
export function NotApplicableControls({
  heading,
  entries,
  collapsed = true,
  testId,
}: {
  heading: string;
  entries: readonly NotApplicableEntry[];
  collapsed?: boolean;
  testId?: string;
}) {
  const [open, setOpen] = useState(!collapsed);
  const [pages, setPages] = useState(1);
  const { shown, remaining } = notApplicablePage(entries, pages);
  const list = open && (
    <>
      <ul className="flight-control-list not-applicable-list">
        {shown.map((entry) => (
          <li key={entry.key} className="flight-control" data-control-id={entry.controlId}>
            <strong>{entry.title}</strong>
            <p>
              <Badge tone={controlResultTone('not_applicable')}>{controlResultWords('not_applicable')}</Badge>
              <span> {withLocalTimes(entry.summary, missionTime)}</span>
            </p>
            {entry.decidedBy && <small className="muted">{entry.decidedBy}</small>}
          </li>
        ))}
      </ul>
      {remaining > 0 && (
        <Button type="button" kind="quiet" onClick={() => setPages((value) => value + 1)}>
          Show more · {Math.min(remaining, NOT_APPLICABLE_PAGE_SIZE)} of {remaining} remaining
        </Button>
      )}
    </>
  );
  if (!collapsed)
    return (
      <div className="not-applicable-controls" data-testid={testId}>
        <h4>{heading}</h4>
        {list}
      </div>
    );
  return (
    <details
      className="not-applicable-controls"
      data-testid={testId}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{heading}</summary>
      {list}
    </details>
  );
}
