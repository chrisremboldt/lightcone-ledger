# A checklist as a record type your own pack declares

Example Ridge Survey's operations manual has a preflight checklist: twelve items in four sections, each answered done, not applicable or defect found, completed by the remote pilot in command before each takeoff. Ledger has no checklist feature and needs none for this. The pack in this folder declares the checklist as a record type of its own, one field per item, and asks three questions about it with check kinds Ledger already has. No code changes. Everything here is invented: the operator, its manual, its people and its flights.

A checklist is a record a person makes. Ledger does not hold a flight until one is made, and no screen says a flight may or may not go. The rules report what is on file and what is not; a named person decides what to do about a finding.

[Write a rule pack](../../docs/guides/write-a-rule-pack.md#a-checklist-of-your-own) is the guide, from a paper checklist to a pack. [Record types a pack declares](../../docs/design/declared-record-types.md) says what a declaration can say, headings included.

| File | What it is |
| --- | --- |
| `source.txt` | The manual's chapter 5: three paragraphs and the checklist as it is printed, in sections. |
| `pack.yaml` | The pack `example-ridge-checklist`: the record type `example-ridge-checklist.preflight-checklist` under `recordTypes`, and three rules, each quoting a paragraph. |
| `records/flight.record.csv` | Five flights, `RIDGE-F-801` to `RIDGE-F-805`. |
| `records/example-ridge-checklist.preflight-checklist.csv` | Four checklists: complete for `RIDGE-F-801`, with one item not applicable; completed after the takeoff for `RIDGE-F-802`; two items unanswered for `RIDGE-F-803`; a defect found for `RIDGE-F-804`. `RIDGE-F-805` has none. |

## The record type

- **One field per item**, a `select` with the three answers. The field's label is the item in the manual's own words ("Propellers undamaged and tight"), so the form shows the manual's checklist and a finding names an item as the manual does.
- **A heading per section** (`heading: Airframe`). The entry form starts a section where the heading changes. Import files and produced records have one column per field and no sections.
- **Every item is required**, so a checklist with an item unanswered is an incomplete record.
- **Who and when**: `completedById`, a person on file, and `completedAt`, which places the record in time.
- **A note**, free text.

## The rules

| Rule | The manual | Check kind | What it reports |
| --- | --- | --- | --- |
| `completed-before-takeoff` | 5.1 | `record.made-before` version 1 | A checklist completed at or before the takeoff in the flight record; one completed only afterwards needs attention and gives both times |
| `every-item-answered` | 5.2 | `record.complete` version 2 | The items of the latest checklist left unanswered, each by its label |
| `no-defect-found` | 5.3 | `value.one-of` version 2 | Each item of the latest checklist answered other than done or not applicable, by its label, and how many items hold each answer |

`no-defect-found` is one rule over all twelve items: `value.one-of` version 2 takes a list of fields and names each that fails. A rule per item would give twelve rules and a finding for each item; one rule gives one finding that names the items. Not applicable is an answer the manual allows, so the rule expects it: it is counted in the sentence ("10 Done, 2 Not applicable") and never found.

A flight with no checklist at all is reported by each rule as "No preflight checklist on file."

## Run it

On a local Ledger with an organization of your own (see [Set up Ledger with a coding agent](../../docs/guides/set-up-with-a-coding-agent.md)):

```sh
pnpm pack:build examples/preflight-checklist --out organization/packs
# LEDGER_PACKS_DIR names organization/packs; restart the API and the workers
pnpm ledger packs adopt example-ridge-checklist --mode active --from 2026-11-01 --until 2027-10-31 --reason "..."
pnpm ledger records import flight.record examples/preflight-checklist/records/flight.record.csv
pnpm ledger records check example-ridge-checklist.preflight-checklist \
  examples/preflight-checklist/records/example-ridge-checklist.preflight-checklist.csv
pnpm ledger records import example-ridge-checklist.preflight-checklist \
  examples/preflight-checklist/records/example-ridge-checklist.preflight-checklist.csv
pnpm ledger coverage --pack example-ridge-checklist
```

Coverage then shows, for the five flights:

| Flight | 5.1 completed before the takeoff | 5.2 every item answered | 5.3 no defect found |
| --- | --- | --- | --- |
| `RIDGE-F-801` | supported by the record | supported by the record | supported: 11 Done, 1 Not applicable |
| `RIDGE-F-802` | needs attention: completed after the takeoff | supported by the record | supported: 12 Done |
| `RIDGE-F-803` | supported by the record | needs attention: two items missing | waits: no value for two items |
| `RIDGE-F-804` | supported by the record | supported by the record | needs attention: Propellers undamaged and tight: Defect found |
| `RIDGE-F-805` | no preflight checklist on file | no preflight checklist on file | no preflight checklist on file |

## Enter one by hand

Once the pack is adopted, **Records**, then **Enter a record**, offers "Preflight checklist". The form lists the items under Airframe, Batteries, Control station and Site, each with Done, Not applicable and Defect found. It is the same form every record type has, so it works on a phone, and where there is no connection the entry is kept on the device and sent later, as any record entry is ([Entering records without a connection](../../docs/design/offline-entry.md)).

`tests/integration/preflight-checklist.integration.test.ts` builds and adopts this pack, checks these files against the record types, and reads five flights like the ones above; `packages/standard-packs/tests/example-pack-folders.test.ts` keeps the folder building; `tests/browser/preflight-checklist.spec.ts` enters a checklist in the form at 375 px wide. The commands above were not run against a running local stack for this page, and the browser spec has not been run; if a test and this page disagree, the test is right.
