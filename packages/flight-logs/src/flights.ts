/**
 * What a reader found in a log, in the same shape whatever the format: one entry per flight, with only what the log
 * holds. A reader feeds the tracker the moments it reads (arming, the land detector, positions, heights, the clock)
 * and the tracker cuts them into flights by one rule, said with each flight.
 */

export type LogFormat = 'ulog' | 'dataflash' | 'tlog';

export interface Place {
  /** Decimal degrees, WGS84. */
  latitude: number;
  longitude: number;
}

export interface StatedHeight {
  meters: number;
  /** What the height is measured from, in the log's own terms. */
  reference: string;
}

export interface ReadFlight {
  /** 1 for the first flight of the log. */
  number: number;
  /**
   * takeoff_to_landing: the log's land detector said when the aircraft left the ground and touched down again.
   * arming_to_disarming: the log has no land detector, so the flight runs from arming to disarming.
   */
  rule: 'takeoff_to_landing' | 'arming_to_disarming';
  /** UTC, only when the log holds an absolute time. */
  takeoffAt?: string;
  landingAt?: string;
  /** From the log's own clock, which every log has. */
  durationSeconds: number;
  takeoffPlace?: Place;
  /** Each place it touched down, the last one where it landed. */
  landingPlaces: Place[];
  /** The greatest height, from a reference the log states, such as home. */
  greatestHeight?: StatedHeight;
  /** The greatest altitude above mean sea level the log states. */
  greatestAltitude?: StatedHeight;
  /** Where in the log the flight's messages are, from the one that armed it to the one that ended it. */
  bytes: { offset: number; length: number };
  /** What the reader could not read for this flight. */
  notRead: string[];
}

export interface LogReading {
  format: LogFormat;
  /** The format's name as people know it. */
  formatName: string;
  /** How far the reader got, in bytes. */
  bytesRead: number;
  /** Where the absolute time came from; absent when the log holds none. */
  absoluteTime?: string;
  /** The vehicle's identifier and the field of the log it came from, if the log holds one. */
  vehicle?: { identifier: string; from: string };
  /** Whole flights, in order. */
  flights: ReadFlight[];
  /** A flight the log does not hold to its end, because the log ends or stops being readable first. */
  unfinished?: { startedSecondsIntoLog: number; reason: string };
  /** Why the reader stopped before the end of the file, if it did. */
  stopped?: { offset: number; reason: string };
  /** About the log as a whole: what it holds and what it does not. */
  notes: string[];
}

/** The rule the tracker uses for each format's flights, in a sentence a person reads. */
export const flightRuleWords: Record<ReadFlight['rule'], string> = {
  takeoff_to_landing:
    'from the first moment the land detector said the aircraft was in the air after arming, to the last moment it said it was on the ground again before disarming',
  arming_to_disarming: 'from arming to disarming: the log holds no land detector',
};

interface Position extends Place {
  at: number;
  altitude?: number;
  height?: number;
}

/** One stream of positions, such as the estimator's or the receiver's. */
class Track {
  latest?: Position;
  takeoff?: Position;
  landings: Position[] = [];
  greatestAltitude?: number;
  greatestHeight?: number;
  seen = false;
}

interface Armed {
  armedAt: number;
  armedOffset: number;
  airborneAt?: number;
  /** The last touchdown after the aircraft was airborne, and the time it happened. */
  touchdownAt?: number;
  inAir: boolean;
  tracks: Map<string, Track>;
  notRead: string[];
}

export interface PositionSource {
  /** A short name for the stream, such as the topic it came from. */
  name: string;
  /** Lower is preferred when a flight has positions from more than one stream. */
  rank: number;
  /** What a height from this stream is measured from, when the stream states one. */
  heightReference?: string;
  /** Where its altitude above mean sea level comes from. */
  altitudeReference?: string;
}

/** Leap seconds between GPS time and UTC since 1980, by the UTC instant each took effect. */
const LEAP_SECONDS: readonly [number, number][] = [
  [Date.UTC(2017, 0, 1), 18],
  [Date.UTC(2015, 6, 1), 17],
  [Date.UTC(2012, 6, 1), 16],
  [Date.UTC(2009, 0, 1), 15],
  [Date.UTC(2006, 0, 1), 14],
];
const GPS_EPOCH = Date.UTC(1980, 0, 6);

/** UTC milliseconds for a GPS week and milliseconds into it, or undefined before the table starts. */
export function gpsWeekToUtc(week: number, millisecondsOfWeek: number): number | undefined {
  const gps = GPS_EPOCH + week * 604_800_000 + millisecondsOfWeek;
  const leap = LEAP_SECONDS.find(([from, seconds]) => gps - seconds * 1000 >= from);
  return leap ? gps - leap[1] * 1000 : undefined;
}

export class FlightTracker {
  private armed?: Armed;
  private readonly flights: ReadFlight[] = [];
  private landDetector = false;
  private landed = true;
  private utcOffsetMicros?: number;
  private absoluteTime?: string;
  private lastAt = 0;
  private firstAt?: number;
  private readonly sources = new Map<string, PositionSource>();
  private readonly notes: string[] = [];
  private groundOnly = 0;
  private everArmed = false;
  /** The current message's start and end offsets, set by the reader before it reports what the message held. */
  messageStart = 0;
  messageEnd = 0;

  /** Every time a reader reads, in microseconds of the log's own clock (time since the autopilot started). */
  time(at: number): void {
    if (!Number.isFinite(at) || at <= 0) return;
    this.firstAt ??= at;
    if (at > this.lastAt) this.lastAt = at;
  }

  /** The log's clock at `at` was this UTC instant; the first such pairing is kept. */
  utc(at: number, utcMicros: number, from: string): void {
    if (this.utcOffsetMicros !== undefined || !(utcMicros > Date.UTC(2000, 0, 1) * 1000)) return;
    this.utcOffsetMicros = utcMicros - at;
    this.absoluteTime = from;
  }

  /** The log's own clock is UTC, in microseconds since 1970, as a ground station's is. */
  clockIsUtc(from: string): void {
    this.utcOffsetMicros = 0;
    this.absoluteTime = from;
  }

  armedState(at: number, armed: boolean): void {
    this.time(at);
    if (armed) this.everArmed = true;
    if (armed && !this.armed) {
      this.armed = {
        armedAt: at,
        armedOffset: this.messageStart,
        inAir: false,
        tracks: new Map(),
        notRead: [],
      };
      if (this.landDetector && !this.landed) this.liftOff(at);
    } else if (!armed && this.armed) this.endFlight(at);
  }

  landedState(at: number, landed: boolean): void {
    this.time(at);
    this.landDetector = true;
    this.landed = landed;
    const flight = this.armed;
    if (!flight) return;
    if (!landed && !flight.inAir) this.liftOff(at);
    else if (landed && flight.inAir) {
      flight.inAir = false;
      flight.touchdownAt = at;
      for (const track of flight.tracks.values()) if (track.latest) track.landings.push(track.latest);
    }
  }

  private liftOff(at: number): void {
    const flight = this.armed!;
    flight.inAir = true;
    flight.airborneAt ??= at;
    for (const track of flight.tracks.values()) if (!track.takeoff && track.latest) track.takeoff = track.latest;
  }

  /** A position; `height` only when the log states one from a reference, `altitude` above mean sea level. */
  position(
    at: number,
    source: PositionSource,
    place: Place,
    measured: { altitude?: number; height?: number } = {},
  ): void {
    this.time(at);
    if (!validPlace(place)) return;
    this.sources.set(source.name, source);
    const flight = this.armed;
    if (!flight) return;
    let track = flight.tracks.get(source.name);
    if (!track) flight.tracks.set(source.name, (track = new Track()));
    const position: Position = { ...place, at, ...measured };
    track.latest = position;
    track.seen = true;
    const flying = this.landDetector ? flight.inAir : true;
    if (flying && !track.takeoff) track.takeoff = position;
    if (!flying) return;
    if (measured.altitude !== undefined && Number.isFinite(measured.altitude))
      track.greatestAltitude = Math.max(track.greatestAltitude ?? -Infinity, measured.altitude);
    if (measured.height !== undefined && Number.isFinite(measured.height))
      track.greatestHeight = Math.max(track.greatestHeight ?? -Infinity, measured.height);
  }

  note(sentence: string): void {
    if (!this.notes.includes(sentence)) this.notes.push(sentence);
  }

  private endFlight(at: number): void {
    const flight = this.armed!;
    this.armed = undefined;
    if (this.landDetector && flight.airborneAt === undefined) {
      this.groundOnly += 1;
      return;
    }
    const byLand = this.landDetector;
    if (byLand && flight.inAir) {
      flight.notRead.push(
        'The land detector still said in the air at disarming; the landing is taken as the disarming.',
      );
      flight.touchdownAt = at;
      for (const track of flight.tracks.values()) if (track.latest) track.landings.push(track.latest);
    }
    const start = byLand ? flight.airborneAt! : flight.armedAt;
    const end = byLand ? flight.touchdownAt! : at;
    if (!byLand) for (const track of flight.tracks.values()) if (track.latest) track.landings.push(track.latest);
    this.flights.push(this.flight(flight, start, end, byLand));
  }

  private flight(flight: Armed, start: number, end: number, byLand: boolean): ReadFlight {
    const tracks = [...flight.tracks.entries()]
      .filter(([, track]) => track.seen)
      .sort(([a], [b]) => this.sources.get(a)!.rank - this.sources.get(b)!.rank);
    const [name, track] = tracks[0] ?? [];
    const source = name ? this.sources.get(name) : undefined;
    const notRead = [...flight.notRead];
    if (!track) notRead.push('The log holds no position during this flight: no takeoff or landing place.');
    const takeoff = track?.takeoff;
    const greatestHeight = this.greatestHeight(track, source);
    if (track && !greatestHeight) notRead.push('The log holds no height during this flight.');
    return {
      number: this.flights.length + 1,
      rule: byLand ? 'takeoff_to_landing' : 'arming_to_disarming',
      ...(this.utcOffsetMicros !== undefined ? { takeoffAt: this.utcAt(start), landingAt: this.utcAt(end) } : {}),
      durationSeconds: Math.round((end - start) / 100_000) / 10,
      ...(takeoff ? { takeoffPlace: placeOf(takeoff) } : {}),
      landingPlaces: (track?.landings ?? []).map(placeOf),
      ...(greatestHeight ? { greatestHeight } : {}),
      ...(track?.greatestAltitude !== undefined && source?.altitudeReference
        ? { greatestAltitude: { meters: round1(track.greatestAltitude), reference: source.altitudeReference } }
        : {}),
      bytes: { offset: flight.armedOffset, length: this.messageEnd - flight.armedOffset },
      notRead,
    };
  }

  /** The stated height when the stream states one; otherwise the altitude above the takeoff point's altitude. */
  private greatestHeight(track: Track | undefined, source: PositionSource | undefined): StatedHeight | undefined {
    if (!track || !source) return undefined;
    if (track.greatestHeight !== undefined && source.heightReference)
      return { meters: round1(track.greatestHeight), reference: source.heightReference };
    if (track.greatestAltitude !== undefined && track.takeoff?.altitude !== undefined && source.altitudeReference)
      return {
        meters: round1(track.greatestAltitude - track.takeoff.altitude),
        reference: `above the takeoff point: the greatest altitude less the altitude at takeoff, both from ${source.altitudeReference.replace(/^above mean sea level, /, '')}`,
      };
    return undefined;
  }

  private utcAt(at: number): string {
    const milliseconds = Math.round((at + this.utcOffsetMicros!) / 1_000_000) * 1000;
    return new Date(milliseconds).toISOString().replace('.000Z', 'Z');
  }

  /** Ends the reading: the flight still armed is unfinished, and the reasons a reader stopped are kept. */
  finish(format: LogFormat, formatName: string, bytesRead: number, stopped?: LogReading['stopped']): LogReading {
    const notes = [...this.notes];
    if (this.utcOffsetMicros === undefined)
      notes.push(
        'The log holds no absolute time, so no flight has a takeoff or landing time; durations are from the log’s own clock.',
      );
    if (!this.everArmed) notes.push('The log never shows the aircraft armed, so it holds no flight.');
    else if (!this.landDetector)
      notes.push('The log holds no land detector, so each flight runs from arming to disarming.');
    if (this.groundOnly)
      notes.push(
        `${this.groundOnly === 1 ? 'Once' : `${this.groundOnly} times`} the aircraft was armed and disarmed without leaving the ground; that is not a flight.`,
      );
    const armed = this.armed;
    return {
      format,
      formatName,
      bytesRead,
      ...(this.absoluteTime ? { absoluteTime: this.absoluteTime } : {}),
      ...(this.vehicle ? { vehicle: this.vehicle } : {}),
      flights: this.flights,
      ...(armed
        ? {
            unfinished: {
              startedSecondsIntoLog: Math.round((armed.armedAt - (this.firstAt ?? armed.armedAt)) / 100_000) / 10,
              reason: stopped
                ? 'the reader stopped while the aircraft was armed'
                : 'the log ends while the aircraft is armed',
            },
          }
        : {}),
      ...(stopped ? { stopped } : {}),
      notes,
    };
  }

  vehicle?: { identifier: string; from: string };
}

function validPlace(place: Place): boolean {
  const { latitude, longitude } = place;
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180 &&
    !(latitude === 0 && longitude === 0)
  );
}

const round1 = (value: number) => Math.round(value * 10) / 10;
const round7 = (value: number) => Math.round(value * 1e7) / 1e7;
const placeOf = (position: Position): Place => ({
  latitude: round7(position.latitude),
  longitude: round7(position.longitude),
});
