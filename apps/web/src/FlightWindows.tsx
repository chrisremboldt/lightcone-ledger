import { useEffect, useState } from 'react';
import { LedgerClient } from '@ledger/contracts/client';
import type { FlightMissionResponse, FlightSummary } from '@ledger/contracts';
import { flightWindow } from './labels.js';
import { missionTime } from './missionRelease.js';
import { readFailureOutcome } from './read-failure.js';
import { timeZoneLabel } from './format.js';

export function FlightWindows({
  client,
  flight,
  active,
}: {
  client: LedgerClient;
  flight: FlightSummary;
  active: boolean;
}) {
  const [read, setRead] = useState<{ mission: FlightMissionResponse | null; interrupted: boolean }>({
    mission: null,
    interrupted: false,
  });

  useEffect(() => {
    setRead({ mission: null, interrupted: false });
  }, [client, flight.id]);

  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const mission = await client.flightMission(flight.id);
        if (
          (mission.binding && mission.binding.flightId !== flight.id) ||
          (mission.acceptedHead && mission.acceptedHead.record.flightId !== flight.id) ||
          (mission.projectedHead && mission.projectedHead.flightId !== flight.id)
        )
          throw new Error('The mission belongs to a different flight.');
        if (!stopped) setRead({ mission, interrupted: false });
      } catch (failure) {
        if (!stopped)
          setRead((previous) => ({
            mission: readFailureOutcome(failure, true) === 'access_lost' ? null : previous.mission,
            interrupted: true,
          }));
      }
      if (!stopped) timer = setTimeout(() => void poll(), 3000);
    }
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [client, flight.id, active]);

  const requested = flightWindow(flight);
  const accepted = read.mission?.acceptedHead;
  const record = accepted?.record;
  const current = accepted?.processing.status === 'completed' && read.mission?.projectedHead?.id === record?.id;
  const label =
    read.interrupted && record
      ? 'Last read mission window'
      : current
        ? 'Current mission window'
        : record
          ? 'Latest mission window'
          : 'Mission window';
  const status = read.interrupted
    ? 'Unconfirmed · updates unavailable'
    : accepted?.processing.status === 'failed'
      ? 'Source review needed'
      : current
        ? null
        : 'Processing mission';

  return (
    <dl className="flight-windows" data-testid="flight-windows">
      <div data-testid="requested-window">
        <dt>Requested window</dt>
        <dd>
          {requested ? (
            <b className="mono">
              {requested} {timeZoneLabel()}
            </b>
          ) : (
            'Not recorded'
          )}
        </dd>
      </div>
      <div data-testid="mission-window">
        <dt>{label}</dt>
        <dd>
          {record ? (
            <>
              <b className="mono">
                {missionTime(record.operatingInterval.start)} – {missionTime(record.operatingInterval.end)}
              </b>
              <span className={`flight-window-state ${status ? 'is-unconfirmed' : ''}`}>
                {' '}
                · Revision {record.sourceRevision}
                {status && ` · ${status}`}
              </span>
            </>
          ) : read.interrupted ? (
            'Unavailable · mission updates interrupted'
          ) : read.mission ? (
            'No mission recorded'
          ) : (
            'Checking recorded mission…'
          )}
        </dd>
      </div>
    </dl>
  );
}
