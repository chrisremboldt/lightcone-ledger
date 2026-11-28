import {
  djiFlightHub2FlightsAdapter,
  FLIGHTHUB2_TASK_LIST_PATH,
  FlightHub2FlightPoll,
  flightHub2PointTimeUnits,
  type FlightHub2PointTimeUnit,
  type ObservationAdapter,
} from '@ledger/adapters';
import type { BindingValues, PollAdapter } from './runnable.js';

const DEFAULT_LOOK_BACK_HOURS = 48;

/*
 * BUILT FROM DOCUMENTATION ONLY: how the adapter process runs the completed-flights adapter for DJI FlightHub 2.
 * It has been run against the emulator only, never against a real project.
 */

/** The --point-times value that leaves positions out: nobody has compared a track with the product yet. */
export const POINT_TIMES_NOT_COMPARED = 'not-compared';
const TOKEN_HEADER = 'x-user-token';

const pointTimeUnit = (values: BindingValues): FlightHub2PointTimeUnit | undefined =>
  flightHub2PointTimeUnits.find((unit) => unit === values.pointTimes);

/** Why a --point-times value cannot be used, or undefined. */
export function pointTimesProblem(given: string): string | undefined {
  return given === POINT_TIMES_NOT_COMPARED || flightHub2PointTimeUnits.includes(given as FlightHub2PointTimeUnit)
    ? undefined
    : `the unit of a track point's timestamp is ${flightHub2PointTimeUnits.join(' or ')} once you have compared a track with the product, or ${POINT_TIMES_NOT_COMPARED} to leave positions out`;
}

export const flightHub2Flights: PollAdapter = {
  adapter: djiFlightHub2FlightsAdapter as ObservationAdapter<never>,
  transport: 'poll',
  // A completed flight is an event: none is dropped.
  delivery: 'every',
  bindingOptions: ['project', 'pointTimes'],
  binding: (values) => {
    const unit = pointTimeUnit(values);
    return unit ? { pointTimeUnit: unit } : {};
  },
  subjects: () => ({ scope: 'source' }),
  path: () => FLIGHTHUB2_TASK_LIST_PATH,
  // A flight task completes a few times an hour at most; its track is read once.
  defaultPollSeconds: 300,
  serviceCredential: { header: TOKEN_HEADER },
  // The list is asked for the flight tasks of the hours before each poll (--look-back-hours).
  lookBack: { defaultHours: DEFAULT_LOOK_BACK_HOURS, path: () => FLIGHTHUB2_TASK_LIST_PATH },
  // The service keeps one record of a flight task and changes it: a changed report replaces the one on file.
  oneCurrentPerSubject: ['flight.report'],
  startNotice:
    'This adapter was built from the published documentation only and has not been run against a real FlightHub 2 project: test it against your own before operational use.',
  source: (values, config, receive) => {
    const readTracks = pointTimeUnit(values) !== undefined;
    if (!readTracks)
      config.log({
        event: 'positions_left_out',
        message: `Flown positions are left out: the documentation does not state the unit of a track point's timestamp. Compare a track with the product, then start again with --point-times ${flightHub2PointTimeUnits.join(' or ')}.`,
      });
    return new FlightHub2FlightPoll(
      {
        origin: new URL(config.url).origin,
        userToken: config.headers[TOKEN_HEADER]!,
        projectUuid: values.project!,
        intervalMs: config.intervalMs,
        readTracks,
        lookBackMs: (config.lookBackHours ?? DEFAULT_LOOK_BACK_HOURS) * 3_600_000,
        log: config.log,
        ...(config.fetcher ? { fetcher: config.fetcher } : {}),
      },
      receive,
    );
  },
};
