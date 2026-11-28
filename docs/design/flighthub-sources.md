# What DJI FlightHub 2 gives Ledger, and how it is read

Status: built from documentation only. Nobody on the project has a FlightHub 2 project or a FlightHub 2 on-premises deployment. Everything here was read from the published documentation on 2026-11-28, and what was built was run against the emulator in `apps/emulators` only, never against the real product. A person with a real project should test it before operational use; [Deploy, section 10](../guides/deploy.md#10-connect-a-source-run-an-adapter) lists what to compare.

Ledger already had adapters for the DJI Cloud API's telemetry over MQTT, which an operator can use only with a Cloud API server of their own. Most dock operators use FlightHub 2 instead. This note answers three questions about it from its documentation, then records what was built and what was decided.

## What was read

- The FlightHub 2 user manual (fh.dji.com/user-manual/en), under "Custom Development": "Public Cloud V2.0", "On-Premises V2.0", "MQTT Integration", "FlightHub Sync Integration" ("Introduction" and "Event API"), "Error Codes", and, under "Open Capabilities (No Longer Updated)", "FlightHub Sync Beta" ("Introduction" and "API Services") and "OpenAPI V1.0". Also "Package Overview" and "Feature Differences Between Public Cloud and Private Cloud".
- The interface documentation those pages link to. "FlightHub 2 OpenAPI V2.0 (Public Cloud)": "Authentication Tutorial", "Common Tutorial", "Flight Task Tutorial", "Error Code", "Get Flight Task List", "Get Flight Task Track Information", "Get Flight Task Information", "Get Export History", "Get Single Flight Record Download Link". "FlightHub 2 OpenAPI V2.0 (On-Premises)": "Authentication Tutorial", "Query Flight Task List", "Get Task Flight Track (V2)". The older "NEW FlightHub 2 OpenAPI V1.0": "Obtain flight task list", "Obtain Flight task trajectory information".
- The DJI Cloud API documentation the Sync pages point to: "Topic Definition" (the osd message struct) and the aircraft "Device Property List".

The adapter's descriptor pins the two pages its mapping rests on by digest.

## 1. Is FlightHub Sync's telemetry in a shape the existing adapter reads?

By the documentation, yes: it is the Cloud API's. No second adapter was written.

- "FlightHub Sync Beta" > "Introduction", under "Configure Telemetry Data Transfer", says the data "matches the device property updates pushed via the Cloud API and device model", and links to the Cloud API's dock and aircraft property pages. That page is marked no longer updated, and says telemetry forwarding moved to the current Sync.
- The current "FlightHub Sync Integration" > "Introduction", under "Public Version Telemetry Data (MQTT Protocol Push)", says the public cloud pushes "device telemetry data to third-party servers via the MQTT protocol" to a broker the organization configures: protocol TCP, a host, a port, a user name and a password. It names no topic and describes no payload.
- For the on-premises version the same page points to "MQTT Integration", which forwards the dock's own MQTT messages to a third-party broker and verifies the bridge on `thing/product/+/osd`: the Cloud API's topic.

So the adapters for the Cloud API's periodic state (`dji-cloud-api-osd-position`, `dji-cloud-api-osd-battery`, `dji-cloud-api-dock-wind`) are the ones to run, pointed at the broker the organization names in FlightHub Sync. `packages/adapters/tests/dji-flighthub-sync-telemetry.test.ts` reads a message written by hand in the documented shape. The deploy guide says how to set it up.

What the documentation does not say, and a person with the real thing must compare: the topics the public cloud actually publishes on; whether an aircraft's message names its dock in `gateway`, which the adapter requires; whether the push covers an aircraft flown from a remote controller; whether the connection can use TLS (the page lists the protocol as TCP only).

## 2. Which path gives completed flights?

The flight task list and each task's track, from the public cloud's HTTP interface, read on a schedule.

What the documentation gives:

- "Get Flight Task List" (`GET /openapi/v2.0/flight-task/list`): for each flight task of a project its id, name, status word, the dock it took off from, the planned start and end, `run_at` ("Actual Start Execution Time"), `completed_at` ("Actual Completion Time"), both as date-times, and `flight_status` ("Completion status, 1: incomplete; 2: completed"). Filters by a pair of times in seconds, device, status and name.
- "Get Flight Task Track Information" (`GET /openapi/v2.0/flight-task/{task_uuid}/track`), which "after the flight task is completed" returns a track id, the aircraft's serial, a distance, a duration and a list of points, each a timestamp, a latitude, a longitude and a height.

What it does not give:

- **Takeoff and landing times as such.** The two times are when the task started executing and completed. Nothing says how they relate to the moments of takeoff and touchdown.
- **Units for the track.** No unit is stated for a point's timestamp, its height, the distance or the duration, and nothing says what the height is measured from or which reference the coordinates use. The page's example timestamp (`123456789`) fits neither seconds nor milliseconds. Elsewhere the same documentation states "seconds-level timestamp" for some values and "(milliseconds)" for others.
- **Paging.** The list takes no page number: it "currently returns the first 100 entries; use filter parameters to narrow the result set as needed". The order, and so which entries are the first hundred, is not stated; nor is which of a task's times the time filter applies to.
- **Rate limits**, what the track answers for a task still in progress, and whether a manual flight appears in the list.
- **A flight record's format.** "Get Export History" and "Get Single Flight Record Download Link" lead to exported files through a link valid for an hour; nothing describes what is in them. The adapter does not read them.

The on-premises interface is a different one: other paths (`/openapi/v2.0/task/api/v2/workspaces/...`), integer codes for status and type, and a list with `page` and `page_size`. Its "Get Task Flight Track (V2)" page does not describe a point at all: its schema leaves the track object empty and its example shows a list of file addresses the schema does not mention. Nothing was built for it.

## 3. What an operator needs

- **A package that includes FlightHub Sync.** "Package Overview" lists FlightHub Sync among what the free Standard version does not support. The key the interface takes is found under FlightHub Sync, so by the documentation the Business or Enterprise package is needed. The page's feature table is a picture this reading could not take in: confirm that your package includes the OpenAPI before you start. "Feature Differences Between Public Cloud and Private Cloud" calls the public cloud's OpenAPI "Limited support".
- **The organization key**, sent as `X-User-Token` with every request. "Authentication Tutorial": "FlightHub 2 -> My Organization -> Organization Settings -> Cloud Interconnect -> Organization Key" (the older page names the same place FlightHub Sync). It is a signed token naming a user; that user must have permission for the project. Regenerating the key ends the old one.
- **The project's id**, sent as `X-Project-Uuid`: `data.list.uuid` from "Get Project List Under Organization" (`GET /openapi/v2.0/project`).
- **The access point of the region** ("Common Tutorial"): `es-flight-api-us.djigate.com` outside China, `es-flight-api-cn.djigate.com` inside.
- For telemetry: a broker FlightHub 2 can reach from the internet, with an account for it to publish with.

## What was built

`dji-flighthub2-flights` (`packages/adapters/src/dji-flighthub2-flights.ts`) with its own transport (`dji-flighthub2-poll.ts`), run by `pnpm adapter:run`, and a stand-in in `apps/emulators/src/flighthub2.ts` that answers the two documented requests with invented flights.

- Each poll lists the project's flight tasks of the hours before it (`--look-back-hours`, 48 by default). The list entry of a task the source marks completed is handed over once, as the bytes the service sent, and becomes one `flight.report`: `activity: landed`, `takeoffAt` the stated start of execution, `landingAt` the stated completion. A task in progress is not reported until it is completed.
- Then the task's track is read once and becomes one `position.fix` per point, about the aircraft the track names, with the flight task as the secondary subject.
- The organization key is the process's own setting (`ADAPTER_SERVICE_TOKEN`, from the environment only). A refused key (401) or project (403) stops the process.

## Decisions

**A value whose unit the documentation does not state is left out.** So no height is carried (neither unit nor datum is stated; the existing aircraft adapter's note that its height is above the ellipsoid rests on the Cloud API's page, which says so, and cannot be carried over to this interface), and the track's distance and duration are not read.

**The time of a point is the exception a person settles.** A position without a time is nothing, and the unit of the timestamp is not stated. Considered: guessing from the number's size (a time since 1970 in seconds has ten digits today, in milliseconds thirteen), which is deterministic but is still Ledger deciding what the product means. Chosen instead: the process takes `--point-times`, and a person sets it to `seconds` or `milliseconds` after comparing one track with the product, or to `not-compared`, which leaves positions out and asks for no track. Once set, a point whose time read in that unit falls before 2020 or more than a day after the fetch is left out with its reason, so a wrong setting shows in the log instead of in the record.

**Coordinates are read as WGS84 degrees**, as the existing aircraft adapter reads the Cloud API's, and every observation says the documentation does not state the reference. Leaving coordinates out would leave nothing.

**The task's times are carried as takeoff and landing times, with the caveat in every observation.** They are the closest facts the source states, a date-time with its offset needs no guess to read, and the limitation says they may include time on the ground. A person compares them with what the product shows for one flight.

**No paging exists, so a full answer is narrowed.** When an answer holds 100 entries, the poll asks again for each half of its time range, until an answer is not full; a task listed in both halves is taken once. If a full answer cannot be narrowed (100 tasks in one second, or 64 list requests in one poll), the process says that tasks were not read rather than treating the answer as complete.

**One current report per flight task, as the flight service adapter keeps one per flight** ([flight-service-adapter.md](flight-service-adapter.md)). The source gives a completion no id of its own, so the report's source event id is the task's id and a digest of what the report states: the two times and the status word. The process sets `oneCurrentPerSubject` for `flight.report`: before a report is submitted, the sink reads what this source has on file about the task. The same event id: nothing is submitted, so an entry that changed only in fields no report is made from (the media upload status changes after landing) records nothing, in one run or after a restart. Another one: the new report replaces it. The read needs `evidence:read`, and the process does not start without it. Considered, and built first: no event id, relying on idempotency keys from the bytes. A restart then recorded a second current report for every task whose entry had changed in any field. Within a run the transport hands an entry over again only when a field a report is made from changes. Positions carry the track's id and the point's place in it, so a track read again is never recorded twice.

**The process keeps no state between starts.** Each start reads the look-back again; the read of what is on file and the idempotency keys make that harmless. A process stopped for longer than the look-back misses the flights completed before it.

**What was reused from the shared transport, and what was not.** The start notice, the look-back setting, `oneCurrentPerSubject`, the cutters that take a list's entries out of an answer as sent, and the wait a 429 asks for are the shared ones. The transport itself is the adapter's own, which a runnable adapter may now bring (`source`): the shared poll follows a list page by page, and this list has no pages, so a full answer is asked again for each half of its time range; it also sends a request id of its own with each request and reads a track only for a task marked completed.

**One adapter, two kinds of message.** The list entry and the track are told apart by the path they were read at. The track does not name its task, so the task's id comes from the path.

## Not built

- The on-premises interface, for the reasons above.
- Reading an exported flight record through the interface.
- FlightHub Sync's Event API (a webhook the product calls). Its documented events report the end of a mission only for automatic dispatch workflows, not for flight tasks in general.
- A rule that reads a `flight.report` from this source differently from any other.
