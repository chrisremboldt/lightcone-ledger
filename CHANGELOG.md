# Changelog

Each release has a section here. Its **Upgrading** part says what a deployment does to move to it from the release before: whether the database must be recreated, which settings are new or changed, and what to check afterwards. [docs/upgrading.md](docs/upgrading.md) states what a release may change. What main has gained since the last release is under **Unreleased** until the next one is made; a release whose section has no Upgrading part fails the image workflow before anything is published.

## Unreleased

### Upgrading

Nothing to do: main has gained no change to Ledger itself since v0.2.0.

### Fixed

- The Ledger Lite check (`infra/verify-deployment/check-lite.mjs`) gives Ledger the pack folder the Lite file names; without it Ledger refused to start, so the check could never pass. The guides now say what was run from the published image.

## v0.2.0 (2026-11-27)

The first release published as a container image, `ghcr.io/chrisremboldt/lightcone-ledger`, for linux/amd64 and linux/arm64.

### Upgrading

- **Recreate the database.** Ledger no longer uses PostGIS: the first and fourth migrations were edited in place, so a database made with v0.1.0 no longer matches their checksums and `pnpm db:migrate` refuses it. Make a new database, run the migrations and create your organization again. Ledger is pre-release and has no converter for this.
- On a database made after that change, migrations 0090 (notices), 0091 (links to a produced set), 0092 (the queue figures for the metrics) and 0093 (grants to a program owner and the operators a program owner follows) run forward with `pnpm db:migrate`; nothing is recreated.
- PostgreSQL needs no extension any more: plain `postgres:17-alpine`, or a managed PostgreSQL 17, is enough.
- **A person who holds only reads can no longer produce records or export.** Every request of theirs that is not a read is refused, except a read sent as a POST, reporting a safety concern, their own notice settings and acknowledging what was issued to them. Give anyone who produces records the capability for it.
- **Notices are off until configured.** Email needs `LEDGER_SMTP_HOST`, `LEDGER_SMTP_FROM` and `LEDGER_PUBLIC_URL` (with `LEDGER_SMTP_PORT`, `LEDGER_SMTP_SECURE`, `LEDGER_SMTP_USER` and `LEDGER_SMTP_PASSWORD` where your server needs them), for the API and the workers both; with a mail server and no `LEDGER_PUBLIC_URL` both refuse to start. A webhook is set on People.
- **The investigation seam is gone**, with its `LEDGER_INVESTIGATOR_*` settings: remove them from your env file.
- **The example operations, weather and waiver packs have new pinned digests**: a rule that reads a station's weather report now has a greatest age for it.
- **The request limit is on** outside `LEDGER_ENV=local` and `test`: 300 requests at once and 20 a second for each person's, service's or agent's credential, 2,000 and 200 for a source's. A script that sends more with one credential is answered 429 with `Retry-After`; raise the figures with `LEDGER_REQUEST_RATE` and `LEDGER_REQUEST_BURST` (`LEDGER_SOURCE_REQUEST_*` for sources), or set `LEDGER_REQUEST_LIMIT=off`.
- Metrics are off unless `LEDGER_METRICS_LISTEN` is set. Nothing changes for a deployment that does not set it.
- After the upgrade, check as after any upgrade ([docs/upgrading.md](docs/upgrading.md#after-an-upgrade)).

### Removed

- The investigation seam, a placeholder nothing implemented, and its `LEDGER_INVESTIGATOR_*` settings.

### Added

- Records entered in the field: the web app can be installed and opens without a connection, and a flight record, a preflight assessment or a signed-in safety report written with no connection is kept on the device and sent once when the connection returns, with both the time it was written and the time Ledger received it on the record. A reload signs the person out, since no credential is kept on the device; what they wrote waits and is sent when they sign in again. The demonstration build keeps nothing.
- A program owner's view: an operator grants an organization that contracts it a read of counts (coverage of named packs, open findings by rule, links to named produced sets) for up to a year, revoked at once; the program owner's Ledger reads each operator it follows hourly through its workers, keeps every answer and failure, and shows them side by side under Reports.
- Metrics in the Prometheus text format for the API, the workers and the adapter process, each on a listener of its own (`LEDGER_METRICS_LISTEN`), and one endpoint for the one-process start: requests by route template, every queue's depth and oldest wait across organizations, how far evaluation is behind, leases held and lost, notices sent, failed and given up, observations taken in and refused, database pool use and the process's own figures. No label names an organization, a person, a credential or a record.
- A request limit per credential in each API process, with a higher limit for sources.
- [docs/upgrading.md](docs/upgrading.md), this changelog, and a check that each release carries its upgrade note.
- Record types a pack declares, with their fields, units, options and subject: a declared type gets import, the column mapping, the entry form, browse, checks, coverage and production with no change to code. An adoption pins each declaration by digest.
- Notices by email and webhook: a finding or an action assigned to a person, an action due or overdue, a document waiting for acknowledgement, and a daily or weekly digest. One append-only outbox, every attempt on record; a restricted record's notice carries its reference and a link only.
- Read-only access for an inspector (a Reader preset), and a link to one produced set of records that expires, can be revoked and records each opening without the visitor's address.
- An MCP server in the command-line client (`pnpm ledger mcp`) offering its reading commands and checks as tools; a tool that would send an adoption, a grant or a decision prepares the command for a person to run.
- Adapters for published forecasts (a type of their own, never measured weather) and for published temporary flight restrictions touching a configured region, each with an emulator; a rule that reads a station's weather report has a greatest age for it (ninety minutes unless the rule says otherwise).
- Reports with addresses of their own: a summary of a period, findings opened and closed by month and by rule, an indicator's results over time, and one flight's file as a page. Every number is a count of recorded things and links to the list it counts; a part a person may not read is named as not theirs to read. An order on browse records, People and the registers' owner; the credentials list pages past its first page.
- A design note on what core would need for crewed operations ([docs/design/crewed-operations.md](docs/design/crewed-operations.md)); nothing is built.
- Ledger Lite (`infra/compose.lite.yaml`): the API, the web app and the workers in one Node process (the image's `one-process` command), plain PostgreSQL, and the original files on a volume; keeping original files on disk (`OBJECT_STORE=disk`) is a supported choice.
- `records read-log` reads flights from an autopilot's own log (PX4 ULog, ArduPilot DataFlash, MAVLink telemetry logs) into rows of Ledger's flight record, from a new package, `packages/flight-logs`; an import can keep the log as the records' original file.
- A column mapping for an operator's own export (`records mapping`), so `records check` and `records import` read a spreadsheet as it is; Ledger keeps the export and the mapping that read it.
- An adapter for published METAR weather reports, with a new observation type, `weather.visibility@1`; `weather.wind` can state a variable direction.
- A Setup checklist a new organization opens on: what is on file and what is not, each with the action that starts it.
- An address for every screen, and one navigation bar for Flights, Safety, Records, Rules and People.
- A subject picker on record entry; paging, search and order on the registers; a native dialog for a safety report.
- Coverage opens with counts of rules by result, each a filter.
- A light and a dark theme, pages that print, a bar that fits a phone, and an account panel under the person's name.
- A Docker-only start for one computer (`infra/compose.try.yaml`), and an image published to the GitHub Container Registry for each release.

### Fixed

- One flight's file said nothing was on file for a flight Ledger holds by its own id (a flight from an order or a dock), though its records, rule results and findings were there. A flight's file under Records and under Reports, the list of flights under Records and a produced set now read a flight by whichever id names it, Ledger's or the organization's, and a finding about a flight links to its file.
- The summary of a period counts the findings open now with the open-findings list's own count, and its columns say they count findings opened in the period, closed in the period and open now. A program owner's page says its open findings are what the operator's own list showed when read, and that its coverage numbers count subjects by their latest result, not findings.
- Operators you follow: a coverage table fits its card on a wide screen and scrolls inside its own box on a phone; the reason to stop following is a styled field.
- Setup: the badge of the step that lists items sits beside its title like every other step's.
- A link to a produced set counts one opening per visit, also on `pnpm dev`.
- Mission review: a control not yet in effect says when it takes effect in the organization's time zone, and its date pill keeps to its width.
- Counts are singular for one everywhere in the web app ("1 rule", not "1 rules").
- A time field on record entry names its zone in one pair of brackets.
- An adoption or a control with no end says it has no end date instead of showing a date in the year 9999.
- The badge beside the organization's name says the same on every screen.
- On the shared-records page, the sentence after the manifest's digest has a line of its own.

## v0.1.0 (2026-11-23)

The first public release.

### Upgrading

Nothing to upgrade from: start with an empty database and run the migrations ([Deploy Ledger](docs/guides/deploy.md#5-run-the-migrations)).
