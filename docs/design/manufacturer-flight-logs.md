# Flight logs from a manufacturer's app: the DJI flight record

Status: built from documentation, and run against no real file. Code: `packages/flight-logs/src/dji.ts` (the reader of the file), `dji-frames-csv.ts` (the reader of an open tool's CSV of the file) and `dji-flight.ts` (the flight rule the two share), with `packages/flight-logs/tests/dji.test.ts` and `dji-frames-csv.test.ts` (files the tests build from the layout below); `examples/dji-flight-record` (an invented CSV of frames and the column mapping, with `tests/unit/dji-flight-record-mapping.test.ts` and `tests/integration/dji-flight-record-example.integration.test.ts`). Nobody on this project has a DJI aircraft, a flight record or a developer key. Until someone reads their own files with this reader and compares the result with what their app shows, every place a person would decide to rely on it says so; [the guide](../guides/set-up-with-a-coding-agent.md#a-dji-flight-record) lists what to compare.

## The question

The flight log most small operators have is the flight record a DJI app or controller writes for each flight: a file named like `DJIFlightRecord_2026-11-10_[09-05-12].txt` that is binary, not text. `pnpm ledger records read-log` could not read it. This note settles what a reader in Ledger reads from such a file, what it does with a file it cannot read without a key from the maker, what a flight is, and how an operator brings in a file the reader refuses: through the CSV an open tool writes from it, which `read-log` also reads.

## Where the layout comes from

The maker publishes no description of the format. This reader was built from the open-source project `dji-log-parser` (github.com/lvauvillier/dji-log-parser, MIT licence), version 0.6.0, whose changelog dates that version 2026-11-28, read on that day:

- Its documentation on docs.rs (`docs.rs/dji-log-parser/0.6.0`): the diagrams of the file for each range of versions, the statement that records are encrypted with AES from version 13 and need a keychain from the maker's service, and the documented fields of its records and frames.
- That documentation gives no byte offsets. They were taken from the project's source as docs.rs shows it beside the documentation: `layout/prefix.rs`, `layout/details.rs`, `layout/auxiliary.rs`, `record/mod.rs`, `record/osd.rs`, `record/custom.rs`, `decoder.rs`, `utils.rs`, `keychain/feature_point.rs`, `keychain/api.rs`, `frame/mod.rs`, and the command-line tool's `exporters/csv.rs` for its column names. The checksum the scrambling uses is the one the `crc64` crate documents (CRC-64 with the Jones polynomial).

No code was copied. The reader is written in TypeScript from the layout as described below, with no dependency. The pages were read through a tool that returns a description of a page, with short passages quoted, and not the page itself; the offsets of the header, of the state record and the computation of the key were asked for twice and agreed. The project says its own parser was tested against real logs of versions 1 to 14; this reader was not, so an error in that reading, or in the reader, would show only against a real file.

## Which versions need a key

The eleventh byte of the file is the format's version. As the project documents and its decoder implements:

| Version | How the records are stored | Read from the file alone |
| --- | --- | --- |
| 1 to 6 | Plainly. | The header and the records. |
| 7 to 12 | Scrambled: each record's content is XORed with an eight-byte key computed from the record's own first byte and its type. No secret is involved; the key is in the file. | The header and the records. |
| 13 and 14 | Scrambled as above, then encrypted with AES-256 in CBC mode. The keys are themselves stored encrypted in the file, and only the maker's service turns them into usable keys, for a developer key the operator requests from the maker. The header is scrambled only. | The header only. |
| 15 and later | Not described by the project. | Nothing; the reader says which version the file is. |

The project's summary, "starting with version 13, log records are AES encrypted and require a specific keychain for decryption", is therefore exact: 12 and earlier need no key, 13 and later do. A few record types of version 13 and 14 files are left unencrypted (the stored keys themselves among them), but the positions and the times are not among those.

## 1. What is read from the file alone

**The first bytes** (the project's "prefix"), little-endian: an 8-byte offset, a 2-byte length, the version in one byte. In versions 1 to 5 the records begin at byte 12; from version 6 the prefix is 100 bytes.

**Recognition.** The format has no signature. A file is taken for a flight record when the first eight bytes hold an offset below 4 GB that is at least the size of the first bytes (or zero from version 12: the project's reader allows for a version 13 file whose offset is zero) and the eleventh byte is a version from 1 to 31, and only after every format that has a signature has been ruled out. `--format dji` reads a file that is not recognised.

**The header** (the project's "details"), read in every version from 1 to 14:

- Versions 1 to 11: at the offset the first bytes give, after the records. Version 12: at byte 100, before the records, which begin at byte 536. Versions 13 and 14: at byte 100 inside a block (a tag byte 0, a 2-byte size, then scrambled content: one byte, a 2-byte length, and the header).
- Of the header the reader reads the start of the log (8 bytes at offset 91, milliseconds since 1970 in UTC; zero means none), the place (two 8-byte floats at 99 and 107, longitude then latitude, in degrees), the total time (4 bytes at 119, milliseconds), the greatest height (a 4-byte float at 123, metres), and the aircraft's name and serial number as the app recorded them (32 bytes at 280 and 16 bytes at 312 from version 6; 24 bytes at 278 and 10 bytes at 267 before). Everything else in the header (street and city, the camera's, controller's and battery's serial numbers, the app's version) is not read.
- The serial number is printed as the vehicle's identifier and never written as the aircraft's id, which is the operator's own. The start, total time, greatest height and place are printed for a person to compare and are written to no row: they are the app's summary, not a takeoff and a landing.

**The records**, in versions 1 to 12. Each is a type byte, a length byte, the content, and an end byte `0xFF`. From version 7 the content is a seed byte, the scrambled data and a checksum byte; a content of 256 bytes or more wraps its one-byte length, and its true length is the first of the length plus 0, 256, 512 or 768 whose checksum holds and after which another record begins, as the project's reader does. Images the app embedded between records (JPEG, sometimes after the four bytes `39 30 00 00`) are stepped over by their own structure. Of the record types the reader reads two, and counts every other type in the reading as not read:

- Type 1, the aircraft's state (the project's "OSD"): longitude and latitude (8-byte floats at 0 and 8, radians), the height (a 2-byte integer at 16, tenths of a metre), and one byte at 32 whose bits 1 and 2 say on the ground (0 or 1) or in the air (2 or 3) and whose bit 3 says the motors are on.
- Type 5, the app's own record (the project's "Custom"): a time (8 bytes at 10, milliseconds since 1970, seconds in versions 1 and 2). The layout's documentation does not say which clock it is (the phone's or controller's, or the GPS receiver's), so a person compares it with the time the app shows for the flight.

A sample is one type 1 record with the latest time written before the next type 1 record, which is how the project forms its frames. A type 1 record before any time is counted and left out. A position outside the range of latitude and longitude, or exactly 0, 0, is not a position.

**Stopping.** At a record that is not closed by its end byte, or that runs past the end of the records, the reader stops, says the byte, and keeps what it read before; it does not search forward for the next record, as the autopilot readers do not. The project's reader does search forward; a real file with stray bytes between records would therefore stop this reader early, and it says where.

**The whole file is read at once**, up to 128 MB. The header of versions 1 to 11 lies after the records, and telling a wrapped length needs the bytes after a record, so the file is not read as a stream as the autopilot logs are. A flight record is bounded by the length of one flight.

## 2. A version that needs a key

A reader in Ledger never calls a service by itself. Two options were weighed.

**(a), chosen.** For a file of version 13 or later the reader reads the header, writes no flight, and stops with:

> This file is version N of the DJI flight record format. From version 13 on its records are encrypted, and reading them needs a key from the maker's service, which Ledger does not call; only the header was read. The open-source tool dji-log-parser fetches that key with a developer key of your own and writes the flight as a CSV, which records read-log reads by the same rule; examples/dji-flight-record shows the steps.

`read-log` then ends as it does for any log with no whole flight: it writes no file. This keeps the rule that reading a log sends nothing anywhere, needs no account, and leaves the operator's dealings with the maker to the operator.

**(b), possible later, not built.** `read-log` would take the operator's own developer key as an option and make the one call the format needs. As the project's `keychain/api.rs` and `lib.rs` show it, that call is an HTTPS POST to the maker's developer service (`dev.dji.com/openapi/v1/flight-records/keychains`) carrying the developer key in a header and, in the body, two small numbers from the file (a version and the app family that wrote it) and the encrypted keys the file itself stores (its type 56 records). The positions, times and serial numbers are in the encrypted records, which are not sent; the answer is the AES keys for this one file. If it is built: the call is made by the command-line client on the operator's computer, never by the API or a worker; the command prints what it will send and to whom before it sends; the developer key is read from the environment or an option and is never stored; the keys that come back are kept only for the run unless the operator asks for them to be saved beside the log. Getting a developer key means making an account with the maker and accepting its terms, which is the operator's decision.

## 3. What a flight is

One file is one flight, from motor start to stop as the app saw it. Within the file the reader takes the takeoff and the landing from what each sample says, by one rule, said with the flight:

- **Takeoff** is the first sample that says the aircraft is in the air: its time is `takeoffAt`, and its position is the takeoff place (the last position before it if it has none, or the first after it).
- **Landing** is the last time a sample says the aircraft is on the ground after saying it was in the air: its time is `landingAt`. Each such return to the ground is a landing place, the last one where it landed; a touch-and-go is one flight with two landing places.
- A file whose last sample still says in the air does not hold the landing. The flight is reported as not whole and is not written, as for every other log. A file in which no sample says in the air holds no flight.
- The motors-on bit is not part of the rule. If the motors ran and no sample says in the air, the reading says so, for a person with a real file to report.
- **Times** are the app's (type 5), in UTC, rounded to the second.
- **Height.** The app records height from the takeoff point. The greatest height while in the air goes to `heightNotes` as "above the takeoff point" and never to `maxHeightFlownAboveGroundMeters`, which stays empty for a person. The project's frame documentation calls the same figure "height above ground level" in one place, and in another gives the altitude above sea level as "the height plus the altitude of the home point"; the second says what it is counted from: the home point, which is where the aircraft took off unless it was moved. No altitude above sea level is written: it would add the home point's barometric altitude, from a record this reader does not read.

Cutting a file into several flights by the motors-on bit was considered and refused: the file is the app's own unit, and a second flight in one file is not something the layout's documentation describes. Writing a flight from the header alone (its start, total time and greatest height) was refused too: it would give version 13 files a row, but the header's start is when recording began, not a takeoff, and it holds no landing place.

The rule is one piece of code, `dji-flight.ts`, fed by both readers: the reader of the file gives it a sample for each type 1 record, the reader of the tool's CSV one for each row.

## 4. A file the reader refuses: the open tool's CSV

The project's command-line tool, `dji-log`, reads any version (fetching the key for version 13 and later with the operator's developer key) and writes a CSV with `--csv`. The operator runs it on their own computer; Ledger never runs it. `examples/dji-flight-record` shows the steps on an invented CSV.

**What the CSV is.** One row for every frame, about ten a second, with the header's values (`DETAILS.startTime`, `DETAILS.aircraftSerial` and the rest) repeated on every row. The tool's page says only that `--csv` writes "a CSV file of frames". The column names are the header strings in its source, `dji-log-cli/src/exporters/csv.rs`, each with a comment saying what the column is; the source does not say how a value is written.

**`read-log` reads it** (`dji-frames-csv.ts`, format `dji-frames-csv`), by the rule of section 3 and with the same tracker as the reader of the file (`dji-flight.ts`), so a flight read from the tool's CSV and from the flight record itself is the same flight. What was decided:

- *Columns.* Only names seen in the tool's source are read: `CUSTOM.dateTime`, `OSD.latitude`, `OSD.longitude`, `OSD.height` and `OSD.isOnGround`, which are needed, and `OSD.isMotorOn`, `DETAILS.aircraftName`, `DETAILS.aircraftSerial`, `DETAILS.startTime`, `DETAILS.totalTime` and `DETAILS.maxHeight` when the file has them. A file without a needed column is refused with the five names. The file is recognised by a header row that begins with `CUSTOM.dateTime`, the tool's first column, and names `OSD.latitude`.
- *Times.* `CUSTOM.dateTime` is the column the source gives as "date and time of the frame", and its type there is a time in UTC. How it is written is not stated (the type's usual form is `2026-11-10T16:05:06.000Z`). So a cell is read as a time of day only when it states its own zone, a `Z`, `UTC` or an offset; a cell with no zone gives the flight's duration and no takeoff or landing time, and the reading says why. Taking a cell with no zone for UTC on the strength of the type alone was refused.
- *On the ground or not.* `OSD.isOnGround` is read as `true` or `false`, which is how the source's type is usually written and is not stated either. At a cell that is neither the reader stops and says the row, rather than guess that `1` means yes.
- *Height.* `OSD.height` is written above the takeoff point, as in section 3, whatever the tool's own words for the column.
- *The summary columns* are printed from the first row as the file writes them, and written to no column. The serial number is never an id.
- *A stream of rows.* A CSV of a long flight is tens of megabytes, so the file is read a row at a time and never held; rows are cut at line feeds outside quotes (RFC 4180), and a row longer than 1 MB stops the reader, as an unclosed quote would otherwise swallow the file. Ledger still keeps a file of at most 10 MB as an original: for a larger CSV the reading and the command say so, `--original` is left out of the commands it prints, and the rows import without it.
- *The original.* What Ledger keeps as the records' original is the tool's CSV, the file that was read, not the flight record, which Ledger did not read. The reading tells the person to keep the flight record too.

**The column mapping** in the same folder is the second way, for someone who wants the start and the end of the log or cannot use the reader. A mapping reads one row as one record and holds no arithmetic, so it reads a file of the tool's header row and last row with the operator's two ids put in front: `DETAILS.startTime` as `takeoffAt` and the last row's `CUSTOM.dateTime` as `landingAt`, and nothing else. Those times include the motors running on the ground, so the two ways do not give the same times; each says which it gives.

## How far it has been checked

- The reader's tests build files of versions 2, 3, 6, 8, 11, 12, 13, 14 and 15 from the layout above, with invented positions near the repository's fictional sites, and the test encoder computes the scrambling key on its own, bit by bit, rather than with the reader's code. The checksum is tested against the value the `crc64` crate's documentation gives for the text `123456789`.
- The tests of the CSV reader build their files with an encoder that writes the tool's column names and the values as the source's types are usually written; a real CSV may write them otherwise, which the reader reports and does not guess.
- Nothing has been run against a real flight record, a CSV the `dji-log` tool wrote, the tool itself or the maker's service. The column names come from the tool's source, not from a file it wrote.
- Every reading says so, and the reader's header comment, the command's usage text, the README, both guides and the example's page say it too.
