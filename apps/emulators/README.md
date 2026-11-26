# Vendor emulators

Fictional versions of external systems that speak their real interfaces, so Ledger's production adapters can later point at the real endpoint instead. Listens on `127.0.0.1:4002`.

- **Partner orders:** `GET /partner/orders`, `/partner/orders/{id}`, `/partner/orders.csv` (header `x-partner-key`), plus webhook delivery.
- **Airspace Link AirHub:** operations, LAANC candidates and authorization lifecycle from the official OpenAPI schemas pinned in `vendor/airspace-link/provenance.json` and downloaded by `pnpm vendor:airspace`; OAuth client credentials and a PKCE user grant. The schemas are read on first use: without them the emulators still start, `/healthz` reports 0 schemas and the Airspace Link surface answers 503 saying what to run.
- **DJI Cloud API:** OSD telemetry published to the local MQTT broker (`src/dji.ts`).
- **Published weather reports:** `GET /api/data/metar?ids=<stations>&format=json[&hours=<n>]`, answered as the Aviation Weather Center data API answers it: the latest report of each station at or before the source clock (or every report in the hours before it), newest first, as one JSON array, or 204 with no body when none matches; other parameters and formats are refused. It serves `recordings/published-metar-2026-11-25.jsonl` (`src/metar.ts`): 68 reports of nine large public airports fetched from the live service on 2026-11-25 between 19:16 and 19:18 UTC, each report object exactly as the service sent it. They are published government weather observations, kept as reference data; they are not fictional. `PUT /_simulation/metar/reports` with `{ "reports": [<report object>, ...] }` replaces them for a demonstration; `/_simulation/reset` restores the recording.
- **Published weather forecasts:** `GET /api/data/taf?ids=<stations>&format=json`, answered as the same service answers it: the latest forecast of each station issued at or before the source clock, as one JSON array, or 204 with no body; other parameters and formats are refused. It serves `recordings/published-taf-2026-11-26.jsonl` (`src/taf.ts`): 24 forecasts of large public airports fetched from the live service on 2026-11-26 at 04:33 UTC, each forecast object exactly as sent. Published government forecasts, kept as reference data. `PUT /_simulation/taf/forecasts` with `{ "forecasts": [<forecast object>, ...] }` replaces them; `/_simulation/reset` restores the recording.
- **Published temporary flight restrictions:** `GET /tfrapi/exportTfrList` and `GET /download/detail_<year>_<number>.xml`, as the FAA TFR service serves them. It serves `recordings/published-tfr-2026-11-26/` (`src/tfr.ts`): six of nine detail documents fetched from the live service on 2026-11-26 between 04:34 and 04:35 UTC, and the list's entries for them; the live list held 50 entries. Contact names, organizations, telephone numbers and radio frequencies, and the names of agencies and of a company's venue, were replaced before they were committed (`recordings/published-tfr-2026-11-26/README.md`); everything the adapter reads is as published. A document that was not recorded answers 404. Published government airspace notices, kept as reference data.

The simulator drives them through `/_simulation/*` routes (header `x-emulator-admin`): reset, source clock, order delivery, authorization status changes, and a control lease so a scenario and the background generator don't overwrite each other. On a non-loopback bind, real secrets (`EMULATOR_ADMIN_KEY`, `PARTNER_API_KEY`, `AIRSPACE_*`) are required.

## DJI scripted flights and faults

`src/dji-fault-script.ts` describes a flight as data: a straight route, a battery that declines at a set rate, and timed steps. Each step has `atSeconds` (from the start) and one `action`:

| action | effect |
| --- | --- |
| `battery` | set `percent` (total), `packPercents` (one per pack) and/or `declinePercentPerMinute` |
| `below_forced_landing` | drop the total and every pack `marginPercent` (default 1) below the forced-landing level |
| `omit_battery` / `restore_battery` | leave every battery field out of the messages (lost data, never zeros), then put them back |
| `wind` | set `speed` and `direction` (the documented 1 to 8 sectors) |
| `stop_publishing` / `resume_publishing` | publish nothing in between: a link gap |
| `offset` (`eastMeters`, `northMeters`) | report the aircraft this far east and north of its route; zero returns it to the route |

`planScriptedFlight(script, { start, deviceId, gatewayId, runId })` returns the exact messages (bytes, topic, source time, offset) with no broker and no timers; tests use it directly. Named scripts are in `djiFaultScripts`: `normal-flight`, `battery-sag-on-approach`, `below-forced-landing`, `battery-data-lost`, `drift-outside-area`, `link-drop-40s`.

Controls, with the same `x-emulator-admin` header and control lease as the others (a non-GET call needs `x-simulator-lease` while a lease is held):

- `GET /_simulation/dji/scripts`: the named scripts.
- `POST /_simulation/dji/flights` with `{ "script": "<name>" | <script object>, "start"?: "<source time>", "speed"?: 1 }`: starts publishing; `start` defaults to the source clock. `speed` divides the waits only, never the source timestamps. One flight at a time.
- `GET /_simulation/dji/flights/current`: progress (`status`, `published`, `total`, `elapsedSeconds`, `inLinkGap`, `linkGaps`).
- `DELETE /_simulation/dji/flights/current`: stops it. `/_simulation/reset` also stops it.

Scripted flights publish over MQTT only when `DJI_EMULATOR_MQTT_URL`, `DJI_EMULATOR_MQTT_USERNAME`, `DJI_EMULATOR_MQTT_PASSWORD`, `DJI_EMULATOR_DEVICE_ID` and `DJI_EMULATOR_GATEWAY_ID` are all set; otherwise the start route answers 503. The emulator emits vendor messages only; the adapters turn them into observations.
