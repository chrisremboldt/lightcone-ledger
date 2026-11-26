# Published weather, forecasts and flight restrictions

Status: built. Adapters: `packages/adapters/src/published-metar.ts`, `published-taf.ts`, `published-tfr.ts`. Check kind: `window.values-within-limit@1` in `packages/domain/src/check-kind-library-windows.ts`. What was checked against the live services is in [the deployment guide](../guides/deploy.md#how-far-each-adapter-has-been-checked).

## How old a report a rule reads

A rule that reads the wind at takeoff reads the latest observation at or before the takeoff (`latestAtOrBefore`). Before this change it read that observation however old: a station report from the night before stood in for the wind at a morning takeoff.

Decided: the greatest age belongs to the check kind that carries a value to an instant, `window.values-within-limit@1` with `includeValueAtStart`, as two parameters the rule states.

- `maxAgeSeconds`: the greatest age, at the window start, of the value carried to it, for every value.
- `stationField`: the field that names the station that reported a value, when a station apart from the subject reported it (`values.stationId` on `weather.wind` and `weather.visibility`). A value whose observation names a station is a station's report. With no `maxAgeSeconds`, a station's report older than 90 minutes is not read. Stations report about once an hour, so 90 minutes allows one missed report.
- A value that names no station was measured at the subject, such as by the dock at the site. It keeps no greatest age unless the rule states one, because the demonstration data and the simulated day read such values exactly as before.

A value too old to read is not compared with the limit and is cited as evidence. The result (`value_too_old` when nothing else is read) says when it was reported, how long before the start, by which station, and that none within the greatest age is on file. When the operator's own flight record states the value, that record is read and the summary still says which report was too old.

Considered: putting the age on the read (`latestAtOrBefore` with a greatest age). The read would then drop the old report, and the check could not say that a report exists, how old it is or which station made it. The check kind sees the observation, so it can say all three.

Consequence: the check kind's definition changed in place, so the pinned digest of every pack whose rules use it moved, not only those of the rules that name a station: `ledger.example-operations` 2 and 3, `ledger.example-weather` 2 and `ledger.example-bvlos-waiver` 1. The takeoff wind rules of the example weather pack, the waiver library (used by the BVLOS waiver) and the procedure template now set `stationField`. Version 1 of the example weather pack uses `value.within-limit@1`, which does not know the takeoff time; it keeps reading the latest report however old and is superseded by version 2.

## Forecasts are their own type

A forecast (TAF) is a record of what was forecast, and when. It is `weather.forecast@1`, never `weather.wind` or `weather.visibility` with `method: forecast`, so a rule that reads measured wind cannot read a forecast by accident, whatever its `where` says. Its interval is the time it covers and `occurredAt` its issue time. Each period is kept as the forecast gives it: the base conditions, then `from`, `becoming`, `temporary`, `probability` and `probability_temporary` groups with their own start and end, the group's text, and the wind and visibility it states. Nothing is merged into "the conditions at an instant": that would be Ledger's forecast, not the forecaster's. The service's decoded fields treat a becoming group as lasting to the next change; the adapter does not.

## Flight restrictions

The FAA publishes temporary flight restrictions without an account: a list, and for each restriction a detail document with its times, each area's altitudes and schedule, and each area's boundary as corners. `airspace.restriction@1` records one area that touches a region the organization configures, about that region's site.

- **Which areas.** The adapter cannot read the operating areas recorded in Ledger: it reads only the source and its configuration. Its configuration names regions as circles around the organization's sites, and the adapter computes in code whether each published boundary touches each circle. A restriction that touches none is not recorded, and its document is not kept.
- **What is recorded.** The notice id, the issue time, the interval and daily schedule, the floor and ceiling with their datum, the boundary as published, and the region it touches. What it restricts and allows stays in the retained document: Ledger records that a restriction is on file, not whether a flight may be made.
- **Polling.** The list holds no times or areas, so `ServicePoll` gained `follow`: each poll reads the list, then the document of each entry that is new or changed, on the same host only.

## Which rules read them

No shipped rule reads a forecast or a restriction, and no check kind was added. As they stand:

- `values.on-file@1`, `records.counted@1` and `occurrence.in-window@1` can say that a forecast or a restriction is on file, counted, or issued in a window.
- No kind compares a forecast period's wind or visibility with a limit: the periods are a list, and the limit kinds read one field.
- No kind asks whether a recorded interval overlaps a flight's window, which "a restriction touching the operating area during the flight is on file" needs: `occurrence.in-window@1` places a record at its span start, so a restriction in effect from before the takeoff is not in the window; `interval.covers-window@2` asks whether intervals cover a window, not whether one overlaps it; `intervals.at-once@1` counts subjects a holder holds at once. A kind for interval overlap is the work a rule over restrictions needs.

## NOTAMs

The FAA's NOTAM service issues credentials to a registered account, and no description of its response format was found without one. No adapter or emulator was built from memory. Temporary flight restrictions, which are NOTAMs, are read from the public restriction service.
