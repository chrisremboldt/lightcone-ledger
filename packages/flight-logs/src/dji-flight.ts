import type { LogReading, Place, ReadFlight } from './flights.js';

/**
 * The one flight of a DJI flight record, told sample by sample. Shared by the reader of the file itself (dji.ts) and
 * the reader of the CSV an open tool writes from it (dji-frames-csv.ts), so that the two cut a flight by one rule:
 * from the first sample that says the aircraft is in the air to the last return to the ground, each return a landing
 * place, and a file that ends in the air not a whole flight. docs/design/manufacturer-flight-logs.md has the reasons.
 */

export const HEIGHT_REFERENCE = 'above the takeoff point, the reference the app records height from';
/** How every reading of either reader ends: what a person compares before relying on it. */
export const COMPARE_FIRST =
  'Test it against your own before you rely on it: compare what it reads here (the times, the places, the height, the aircraft’s name and serial number) with what the app shows for this flight.';

const SHOWN_CHARACTERS = 80;

export const round1 = (value: number) => Math.round(value * 10) / 10;
const round7 = (value: number) => Math.round(value * 1e7) / 1e7;
export const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
export const rounded = (place: Place): Place => ({
  latitude: round7(place.latitude),
  longitude: round7(place.longitude),
});
export const utcWords = (milliseconds: number) =>
  new Date(Math.round(milliseconds / 1000) * 1000).toISOString().replace('.000Z', 'Z');

/** A value of the file as a person reads it: one line, no control characters, not longer than a name is. */
export function shown(value: string): string {
  const line = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return line.length > SHOWN_CHARACTERS ? `${line.slice(0, SHOWN_CHARACTERS)}…` : line;
}

export function durationWords(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = round1(seconds - minutes * 60);
  return minutes ? `${minutes} min ${rest} s` : `${rest} s`;
}

export interface Sample {
  /** Milliseconds on the app's clock: since 1970 in UTC when the file says so, and good for a duration either way. */
  at: number;
  inAir: boolean;
  motorsOn: boolean;
  place?: Place;
  /** Metres above the takeoff point, when the sample states a height. */
  height?: number;
  /** Where the sample begins and ends in the file. */
  offset: number;
  end: number;
}

export class OneFlight {
  samples = 0;
  positions = 0;
  backwards = 0;
  motorsRan = false;
  private firstAt?: number;
  private lastAt?: number;
  private flying = false;
  private airborne?: { at: number; offset: number };
  private touchdown?: { at: number; end: number };
  private latest?: Place;
  private takeoff?: Place;
  private readonly landings: Place[] = [];
  private greatest?: number;

  /** `unit` is what the file's samples are called in a sentence: a record of the file, a row of the CSV. */
  constructor(private readonly unit: 'record' | 'row') {}

  add(sample: Sample): void {
    this.samples += 1;
    if (this.lastAt !== undefined && sample.at < this.lastAt) this.backwards += 1;
    this.firstAt ??= sample.at;
    this.lastAt = sample.at;
    if (sample.motorsOn) this.motorsRan = true;
    if (sample.place) {
      this.latest = sample.place;
      this.positions += 1;
    }
    if (sample.inAir && !this.flying) {
      this.flying = true;
      if (!this.airborne) {
        this.airborne = { at: sample.at, offset: sample.offset };
        this.takeoff = this.latest;
      }
    } else if (!sample.inAir && this.flying) {
      this.flying = false;
      this.touchdown = { at: sample.at, end: sample.end };
      if (this.latest) this.landings.push(this.latest);
    }
    if (!this.flying) return;
    this.takeoff ??= sample.place;
    if (sample.height !== undefined) this.greatest = Math.max(this.greatest ?? -Infinity, sample.height);
  }

  /**
   * The flight when the file holds it whole, or why it does not. `stopped`: the reader stopped before the end of
   * the file. `timeOfDay`: the samples' times are UTC, so the takeoff and landing times are written.
   */
  end(stopped: boolean, timeOfDay = true): { flight?: ReadFlight; unfinished?: LogReading['unfinished'] } {
    if (!this.airborne) return {};
    if (this.flying || !this.touchdown)
      return {
        unfinished: {
          startedSecondsIntoLog: round1((this.airborne.at - this.firstAt!) / 1000),
          reason: stopped
            ? `the reader stopped while the file’s ${this.unit}s still said the aircraft was in the air`
            : `the file’s last ${this.unit} still says the aircraft is in the air`,
        },
      };
    const seconds = (this.touchdown.at - this.airborne.at) / 1000;
    const notRead: string[] = [];
    if (seconds <= 0)
      notRead.push(
        'The app’s time at the landing is not after its time at the takeoff, so no takeoff or landing time is written.',
      );
    if (!this.takeoff)
      notRead.push(
        this.landings.length
          ? 'The file holds no position before this flight’s landing: no takeoff place.'
          : 'The file holds no position during this flight: no takeoff or landing place.',
      );
    if (this.greatest === undefined) notRead.push('The file holds no height during this flight.');
    return {
      flight: {
        number: 1,
        rule: 'first_in_air_to_last_on_ground',
        ...(seconds > 0 && timeOfDay
          ? { takeoffAt: utcWords(this.airborne.at), landingAt: utcWords(this.touchdown.at) }
          : {}),
        durationSeconds: Math.max(0, round1(seconds)),
        ...(this.takeoff ? { takeoffPlace: rounded(this.takeoff) } : {}),
        landingPlaces: this.landings.map(rounded),
        ...(this.greatest !== undefined
          ? { greatestHeight: { meters: round1(this.greatest), reference: HEIGHT_REFERENCE } }
          : {}),
        bytes: { offset: this.airborne.offset, length: this.touchdown.end - this.airborne.offset },
        notRead,
      },
    };
  }
}
