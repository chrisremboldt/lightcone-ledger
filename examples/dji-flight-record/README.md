# A DJI flight record the reader cannot read: an open tool's CSV

`pnpm ledger records read-log` reads a DJI flight record of version 12 or earlier from the file alone. From version 13 on the records in the file are encrypted with a key that only the maker's service gives out, and the reader stops and says so ([Flight logs from a manufacturer's app](../../docs/design/manufacturer-flight-logs.md) has the detail). This folder is the way in for such a file: an open-source tool decodes it on your own computer, with a developer key of your own, and writes a CSV with one row for every frame of the flight; `records read-log` reads that CSV by the same rule as the flight record itself. A column mapping for one row of the CSV is kept as a second way.

**Built from documentation, and run against nothing real.** Nobody on this project has a DJI aircraft, a flight record, a developer key or a CSV the tool wrote. The column names were read from the tool's source (`dji-log-parser` version 0.6.0, MIT licence, `dji-log-cli/src/exporters/csv.rs`), which names its columns and does not say how their values are written; the CSV in this folder is invented and holds 17 of the tool's more than two hundred columns. Check the first flights you bring in this way against what your app shows before you rely on it; the list is at the end. Everything here is fictional: the operator, the aircraft and the flight.

| File | What it is |
| --- | --- |
| `frames.csv` | An invented CSV of frames, as the tool lays one out: forty rows, a second apart, of a short flight. On the ground at the ridge pad, up to 44.8 m, along to the quarry gate, down. |
| `dji-log-frames.mapping.yaml` | The column mapping of the second way. It reads the two times of one row, and says for every other column here why it is not read. |

## 1. Decode the flight record with the tool

The tool, `dji-log`, is not part of Ledger and Ledger does not run it. It runs on your own computer. Getting a developer key means an account with the maker and its terms; the tool's own page says how, and what it sends to the maker. With the key in `DJI_API_KEY`:

```sh
dji-log --csv frames.csv "DJIFlightRecord_2026-11-10_[09-05-12].txt"
```

The command is put together from the examples on the tool's page; `dji-log --help` lists its options.

## 2. Read the CSV with `read-log`

From the Ledger checkout:

```sh
pnpm ledger records read-log frames.csv --out FLT-2026-1105.flight.record.csv
```

It recognises the file by its header row (or take `--format dji-frames-csv`), reads it a row at a time whatever its size, sends nothing anywhere, and writes one `flight.record` row:

- `takeoffAt` and `landingAt`: the time, in `CUSTOM.dateTime`, of the first frame that says the aircraft is in the air and of the last frame at which it is back on the ground (`OSD.isOnGround`). A file whose last frame is still in the air holds a flight that is not whole, which is reported and not written.
- `takeoffLocation` and `landingLocations`: the position (`OSD.latitude`, `OSD.longitude`) at those frames; every return to the ground is listed, the last one where it landed.
- `heightNotes`: the greatest `OSD.height` while in the air, as a height above the takeoff point. `maxHeightFlownAboveGroundMeters` is left empty for a person: the tool calls the column "height above ground level", but it is counted from where the aircraft took off.
- The aircraft's name and serial number (`DETAILS.aircraftName`, `DETAILS.aircraftSerial`) are printed and written to no id column. Write your own id for the flight (`subjectId`) and for the aircraft (`secondarySubjectId`) in the CSV it wrote.

For `frames.csv` here it reads one flight, 2026-11-10T16:05:06Z to 2026-11-10T16:05:37Z, from 39.5012345, -105.2034567 to 39.5141000, -105.1873000, greatest height 44.8 m above the takeoff point.

Then check and import, as the command prints:

```sh
pnpm ledger records check flight.record FLT-2026-1105.flight.record.csv --original frames.csv
pnpm ledger records import flight.record FLT-2026-1105.flight.record.csv --original frames.csv
```

Ledger keeps `frames.csv` as the record's original when it is at most 10 MB. A longer flight's CSV is larger: the command says so and leaves `--original` out, the rows import all the same, and you keep the CSV yourself. Either way keep the flight record itself (the `.txt` file) in your own files: the CSV is the tool's decoding of it.

What the reader expects and cannot know from the tool's source: that `CUSTOM.dateTime` is written with its zone (`2026-11-10T16:05:06.000Z`), and that `OSD.isOnGround` is written `true` or `false`. If the times have no zone it writes durations and no time of day, and says so; at a cell that is neither `true` nor `false` it stops and says the row. Tell us what your file holds if either happens.

## 3. The second way: one row through a column mapping

Use this only if you want the start and the end of the log rather than the takeoff and the landing, or cannot use the reader. A column mapping reads one row as one record and does no arithmetic, so it cannot take a CSV of frames as it comes. The last row holds the start of the log and the time of the last frame. Keep the header row and the last row, with your own id for the flight and for the aircraft in front:

```sh
{ printf 'Flight id,Aircraft id,'; head -n 1 frames.csv; printf 'FLT-2026-1105,RIDGE-AC-1,'; tail -n 1 frames.csv; } > FLT-2026-1105.flight.csv
pnpm ledger records check flight.record FLT-2026-1105.flight.csv --mapping examples/dji-flight-record/dji-log-frames.mapping.yaml
pnpm ledger records import flight.record FLT-2026-1105.flight.csv --mapping examples/dji-flight-record/dji-log-frames.mapping.yaml
```

If the last line has fewer cells than the header, a cell holds a line break: copy the last row in a spreadsheet instead. The mapping reads `DETAILS.startTime` as `takeoffAt` and the last row's `CUSTOM.dateTime` as `landingAt`, which include the motors running on the ground before the takeoff and after the landing. It reads no place and no height, and the record is kept as incomplete until a person writes them. Import a flight one way or the other, not both.

## What to compare with the app

For the first flights of each aircraft and app version, open the same flight in the app and compare:

1. The date and time the app shows for the flight, in UTC, with the start of the log the printout gives and with `takeoffAt` (expect `takeoffAt` later, by the time on the ground with the motors running).
2. The flight time the app shows with the total time the printout gives, and with `landingAt` less `takeoffAt`.
3. Where the app's map shows the takeoff and the end of the track with `takeoffLocation` and the last of `landingLocations`.
4. The greatest height the app shows with the greatest height in `heightNotes` and the one the printout gives from `DETAILS.maxHeight`.
5. The aircraft's name and serial number with the two the printout gives.
6. Whether the printout says the reader stopped, left rows out, or found times without a zone.

`packages/flight-logs/tests/dji-frames-csv.test.ts` reads `frames.csv`, `tests/unit/dji-flight-record-mapping.test.ts` reads its last row through the mapping, and `tests/integration/dji-flight-record-example.integration.test.ts` imports it both ways through the API. The `dji-log` command above was not run for this page.
