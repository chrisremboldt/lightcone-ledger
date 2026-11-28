# An adapter for a flight service, built from its reference alone

Status: built, and not run against the real service. Adapter: `packages/adapters/src/skydio-cloud-flights.ts`. Emulator: `apps/emulators/src/skydio.ts`. Transport: `ServicePoll` in `packages/adapters/src/source-transports.ts`. Process entry: `apps/adapter-host/src/runnable.ts`. What a person with an account should compare is in [the deployment guide](../guides/deploy.md#how-far-each-adapter-has-been-checked).

The adapter reads Skydio Cloud's flights and their recorded telemetry. Nobody on the project has an account, so it was written from the published API reference and run against an emulator written from the same pages. This note records the decisions a later contributor would otherwise have to rediscover.

## Said everywhere a person decides to rely on it

Decided: the adapter's fidelity is `synthetic_contract`, and the sentence "not run against the real service; test it against your own account before operational use" stands in the file's header, the first limitation every observation carries, the first line the process logs, the process's `--help`, the README's list and the deployment guide. A runnable adapter may give a `startNotice`, which the process prints in its `starting` line; that line is now printed before anything else, the metrics listener included.

An emulator written from the same reference as the adapter proves that the adapter does what its author read, not that the author read the service right. The emulator's header lists each thing it had to invent because the reference is silent (the list's order, the error wording, which error code goes with which refusal, the sample rate, a flight without a landing while in the air). The adapter reads none of those as fact.

## Asked on a schedule; no webhooks

The service can call an address when a flight starts and ends. Decided: the adapter only asks on a schedule. A webhook receiver needs Ledger, or a process beside it, reachable from the service, and a signature check against the service's published key; a poll needs neither and loses only minutes. The telemetry is not in the webhook in any case, and it arrives later, so a poll is needed either way.

Each poll asks for the flights that took off in a look-back period before it (a week by default) rather than "since the last read": a flight is listed when it takes off, changes when it lands, and changes again when its telemetry is uploaded, none of which moves its takeoff time. The process keeps no state on disk. A flight that changes after it has left the look-back period is not read again.

## One current report per flight

The service keeps one record of a flight and changes it. Ledger keeps observations, which are never edited. Decided: a flight has at most one current `flight.report` from this source, and a changed flight replaces it with the intake envelope's `replaces`, as [observation-corrections.md](observation-corrections.md) describes.

- The report's `sourceEventId` is the flight id and a digest of what the report states (aircraft, times, takeoff place). It changes exactly when the statement changes.
- Before the sink submits a report it reads the current reports this source has on file about the flight (`GET /v1/observations` by the source's own flight id). One with the same `sourceEventId`: nothing is submitted. Otherwise the new report replaces the one received last. This is the option `oneCurrentPerSubject` on `HttpObservationSink` and `InMemoryObservationSink`; the adapter process sets it from the runnable entry.
- The read needs `evidence:read`, which a source's credential does not usually hold. The process checks for it at sign-in and does not start without it.

Considered: remembering the last report of each flight in the process. A restart forgets it, and a flight that changed while the process was down would then stand as two current reports. Considered: no `sourceEventId`, relying on idempotency keys from the bytes. A flight object changes in fields no observation carries (`has_telemetry` turning true), which would record the same statement twice.

Not covered: a flight whose statement goes back to one it had before. The earlier observation with that `sourceEventId` is already on file as replaced, so intake refuses the new one (`source_event_conflict`), the process logs the refusal, and the report on file stays the one before the reversal.

Within a run a flight object is handed over again only when a field a report is made from changes (`partKey`), so `has_telemetry` turning true does not retain the flight's bytes a second time.

## Telemetry: the data part, thinned

- **The retained original is the answer's `data` member, cut out exactly as sent.** The answer's envelope carries the time of the answer, which differs on every read. Retaining the whole answer would give the same telemetry a new original, and new idempotency keys, on every restart.
- **Each position's `sourceEventId` is the flight id and the sample's time.** If the service ever sends the same flight's telemetry in other bytes, intake refuses the first position as a conflict and the process drops that answer and says so; nothing is recorded twice.
- **At most 240 positions a flight.** A rule reads at most 500 positions in a flight's window and is `insufficient` beyond that ([observed-values.md](observed-values.md), section 3), and the reference states no sample rate. A flight with more is thinned to the first position in each of equal periods of whole seconds, its last, its highest and its fastest, so the values a height or speed rule compares are not thinned away. 240 leaves room for two flights of one aircraft in one planned window. Every sample is still in the retained original.
- **An answer larger than 10 MiB is not read**, because Ledger keeps one original of at most that size. The poll says so once and does not ask again in that run.

## Height, datum, time: what the reference states and nothing more

| Field of the reference | Carried as | Why |
| --- | --- | --- |
| `height_above_takeoff`, "Height in meters above the takeoff point. Estimated from visual and baro systems" | `position.altitude` with datum `takeoff_point` | The datum the reference states. The limitation says it is an estimate and not a height above the ground under the aircraft. |
| `gps_altitude`, "GPS-based absolute altitude above sea level [meters]" | `position.altitude` with datum `mean_sea_level`, only for a sample with no height above takeoff, with `gps_vertical_accuracy` | One altitude per observation. The reference names no sea-level model; the limitation says so. |
| `hybrid_altitude` | not read | A second estimate of the same altitude; one is enough, and it stays in the original. |
| `gps_latitude`, `gps_longitude`, "GPS-based global latitude [degrees]" | `position`, as WGS84 | The reference names no datum. WGS84 is the datum of the satellite system it names; the guide lists it to compare. |
| `gps_velocity`, north-east-down in meters per second | `groundSpeedMetersPerSecond`, the length of north and east | The down part is not carried: the vocabulary's vertical speed states no sign convention. |
| `timestamp`, format date-time, described as "Vehicle epoch time [microseconds]" | `occurredAt`, when it is a date and time | The reference contradicts itself. A count is not read: the sample is left out and the log says why. |
| a flight with `takeoff` and no `landing` | `takeoffAt` only, no `activity` | The reference does not say what a flight in progress looks like, and a lost connection also leaves a flight without a landing. |
| `takeoff_latitude`, `takeoff_longitude` | the report's `position` | The only place the Flight object gives. There is no landing place. |

No fix quality is given, so `fix` is `unknown`. A height above the takeoff point is the first such height any shipped adapter reports; the height rules already read one, naming it as the flown height above the takeoff point.

## What the transport gained

`ServicePoll` read one URL, or a list whose items it followed. It now also takes a URL built for each poll, reads a list a page at a time (`nextPage`, on the polled host only, at most 200 pages), hands the list's own entries over as messages while following the items it names (`split` with `follow`), knows an entry by a key (`partKey`), cuts a followed answer to the part handed over (`followedPart`), asks again for an item the service answers 404 for (`mayBeAbsent`), leaves out an item too large to read, and waits for as long as a 429's `Retry-After` asks, up to fifteen minutes. A followed item that was read before a later one failed is not read again by the retry. None of this names a service; the existing poll adapters read exactly as before.

The service takes its token as the whole `Authorization` header, with no scheme word, so a poll adapter's credential is now `bearer`, `token` or `none`.
