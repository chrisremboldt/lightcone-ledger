# Set up Ledger for your organization

This guide takes one organization from nothing to seeing where its own operation stands against its own rules: its people, its aircraft, its flights, the regulations it works under, and its own waiver and procedures.

It says for every step where the work is done and what kind of person can do it. Nothing here asks you to write code. The last section lists what does.

If a coding agent is doing the setup for you from the command line, give it [Set up Ledger with a coding agent](set-up-with-a-coding-agent.md) instead. It takes the same steps with `pnpm ledger`, a client over the public API: importing records, preparing each adoption for the person who decides, and reading coverage and open findings. An agent that speaks the Model Context Protocol can use the same commands as tools through `pnpm ledger mcp` ([AGENTS.md](../../AGENTS.md) says how to start it). Ledger itself calls no language model; the agent is yours. The guide says what the agent may do alone and what stays with a person, and where your own files are kept so they are never committed. `examples/first-operator` is that path run for an invented operator.

## Who does what

| Step | Where it is done | Who can do it |
| --- | --- | --- |
| 1. Start Ledger | A command line, once | Someone comfortable with a terminal and Docker |
| 2. Create the organization | One command, once | The same person |
| 3. Add the people who sign in | The **People** screen | An administrator |
| 4. Add aircraft, pilots and flights | The **Records** screen: a form, or a CSV file from a spreadsheet | Whoever keeps your records |
| 5. Adopt the regulations you work under | The **Rules** screen | A person allowed to adopt rule packs |
| 6. Bring your own waiver and procedures | A text file, a short description file and two commands; then the **Rules** screen | Someone comfortable editing a text file. No programming |
| 7. Read where you stand | The **Rules** screen | Anyone allowed to see records |
| 8. Start your safety records | The **Safety** screens | A safety manager and the people who sign |
| 9. Connect aircraft, docks and airspace services | A command line, per source | Someone comfortable with a terminal |

Steps 1, 2 and 9 are the installer's. Steps 3 to 8 are the organization's own, in a browser, with one exception: your own rules (step 6) are written in a text file and loaded by whoever runs the server, because a rule pack is fixed once built and Ledger reads the pack folder only when it starts.

The bar at the top of every screen lists the sections each person may open: **Flights** (for an organization that records flights), **Safety**, **Records**, **Rules** and **People**, with the one open marked, then **Report a safety concern**. An organization that records no flights opens on its safety home.

**Your first screen: Setup.** Until your organization adopts its first rule pack, Ledger opens on **Setup** for whoever may add people, keep your records or adopt rule packs and can see flights and records. It lists what steps 3 to 9 of this guide set up, as seven steps: (1) the people who sign in; (2) an aircraft, a pilot and a flight on record; (3) your own waiver or procedure offered as a rule pack; (4) a rule pack adopted; (5) what coverage says, in one line per adopted pack (how many rules have a subject needing attention and how many a record not on file); (6) the safety items the Safety home lists; (7) records produced for someone who asks, which is optional. Each step says, with your own names and ids, what is on file and what is not, the one action that starts it and who may take it. A step you may take links to the exact screen; a step done on a command line, such as building a pack file, shows the command and the section of this guide instead. Nothing is ticked by hand: each step reads what is on record. A pilot, or anyone else who may take none of the steps, opens where they did before. Once a pack is adopted Ledger opens as described below, and **Setup** stays in the bar until steps 1 to 4 and 6 are on file. Its address is `/setup`. Every screen, and each thing opened on it (a flight, a finding, a hazard, a document revision, a pilot's or an aircraft's file, a pack's coverage), has its own address: copy it from the browser to send a colleague a link, and back, forward and refresh keep the place. A link opened by someone who may not read what it points at says so. An address holds ids, never a safety report's content or anything typed into a search.

## 1. Start Ledger

To try all of this on one computer first, you need Node 24, pnpm 11.19.0 and Docker:

```sh
git clone https://github.com/chrisremboldt/lightcone-ledger.git
cd lightcone-ledger
corepack enable
cp .env.example .env
pnpm install --frozen-lockfile
docker compose -f infra/compose.yaml up -d --wait
pnpm build && pnpm db:migrate
```

Leave out `pnpm db:seed`: it adds the fictional organizations the demonstration uses, which you do not need, and `pnpm vendor:airspace`, which the demonstration's emulators need and your own records do not. Delete the last block of `.env`, headed "The seeded fictional organizations", which configures them; Ledger starts without it. Start Ledger with `pnpm dev` after step 2. The local sign-in screen then offers no fictional organization and asks for the development token `pnpm org:create` printed.

If another Ledger stack already runs on this computer, its ports are taken (the API's 4000, the web app's 5173, the emulators' 4002 and 4003, PostgreSQL's 54329, object storage's 9090, the broker's 1883 and 1884): `docker compose` or `pnpm dev` stops with "port is already allocated" or `EADDRINUSE`, and the API that answers on 4000 is the other stack's. Run yours on other ports by changing settings only: start the services with `docker compose -p <a project name of your own> -f infra/compose.yaml -f infra/compose.other-ports.yaml up -d --wait`, and set `PORT`, `LEDGER_WEB_PORT`, `CORS_ORIGINS`, the database URLs and the other ports in `.env` as [AGENTS.md, "Running a second stack"](../../AGENTS.md#running-a-second-stack) lists them. Either way, `pnpm ledger me` names the organization the API you reach belongs to; check it is yours before you rely on anything it says.

For a server other people will use, follow [Deploy Ledger](deploy.md) instead. It covers the container image, the database, sign-in through your identity provider, backups, and which of its steps were run and which were not.

## 2. Create your organization

```sh
pnpm org:create --name "Example Ridge Survey" --time-zone America/Denver --admin "Avery Example"
```

This makes the organization, with its time zone, and its first administrator. Every screen then shows times in that zone. Running it again changes nothing.

On your own computer the command prints a development token once. Run `pnpm dev`, open [localhost:5173](http://localhost:5173), choose **Use a development token** and paste it. On a server the administrator signs in with their account at your identity provider instead; [Deploy Ledger, section 7](deploy.md#7-create-your-organization) has the two extra options.

## 3. Add the people who sign in

Open **People** and choose **Add a person**. Give the name, start from a role (Dispatcher, Pilot, Safety manager, Administrator or Reader) and tick or untick what that person may do. Tick **Import and enter operator records** for whoever keeps your records. On a server, also give the person's account at your identity provider. The same roles, with exactly what each grants, are printed by `pnpm ledger people presets`, and `pnpm ledger people add` adds a person from the command line: it prints the addition and sends it only with your own token and `--reason`. `pnpm ledger people set "<name>" --capability <capability>` changes what someone already added may do (`--preset` and `--capability` add, `--remove-capability` takes away) the same way, printing what they may do now and after, and keeps your reason with the change.

Every change to what someone may do is recorded with who made it. A person who leaves is deactivated, never deleted.

**Several people on one computer.** On your own computer each person signs in with their own development token. Choose the person on the People screen and **Issue a development token**, or run `pnpm ledger people token "<their name>" --reason "<why>"` with your own token, and give them the token: it is shown once, and issuing another replaces the earlier one at once. They choose **Use a development token** on the sign-in screen and paste it, so what they sign, acknowledge or close is recorded as theirs. If your own token is lost, `pnpm development-token:issue --organization <organization id> --for "<your name>"` replaces it. Development tokens are for a trial on a computer that faces no network. Real use by several people needs each of them to sign in through your identity provider: [Deploy Ledger, section 6](deploy.md#6-sign-in).

**Notices.** A person with an email address on file is told when a finding or an action is assigned to them, when one of theirs is due or overdue, and when a document waits for their acknowledgement, if your Ledger has a mail server ([Deploy Ledger, Notices](deploy.md#notices-by-email-and-webhook)). Each person sets their address and chooses which notices they get under their name in the bar; you can set an address when you choose the person on the People screen, which shows who has none and so gets no email. **Notices sent** on the People screen lists every notice and whether it was sent, and holds your organization's webhook.

**These are the people who use Ledger, not your crew list.** A pilot who never signs in needs no entry here. The records about your pilots are step 4.

## 4. Add your aircraft, pilots and flights

There is no separate "add an aircraft" or "add a pilot" step. In Ledger an aircraft, a pilot, a flight or a site exists once a record names it, under **your own id for it**: the tail number or fleet number you already use, your pilot or employee number, your flight or job number.

Use the same id every time. The aircraft `AC-1` in your aircraft file is the aircraft `AC-1` a flight plan names; a pilot's certificate, training and assignments meet under one pilot id. Ids are matched exactly, so `AC-1` and `ac1` are two aircraft.

Open **Records** and pick a record type. For each type you can:

- **Enter a record** in a form, one at a time. As you type a subject id, or the id of a related flight, aircraft, person, site or component, the form lists the ones already on file by id and by the name their records give them. A new id is still taken: the form says, before anything is recorded, that no record names it yet and that recording makes it a new aircraft, person or flight. **Browse records** offers the same list for its subject id, and **More records** reads the next page.
- **Import a file**: a CSV file, as a spreadsheet saves it, or a JSON file. **Download CSV template** gives the header row, and **Columns** lists every column with its meaning and the values it accepts. The file is checked first and nothing is recorded until you confirm. A row that cannot be recorded says why in plain words, for example `"No defects" is not one of serviceable, unserviceable, serviceable_with_deferred_items`, and never stops the other rows. An export from a log service or a spreadsheet with its own headings, dates, units and words need not be rewritten by hand: from the command line, a column mapping kept beside it reads it as it is (`pnpm ledger records mapping`, then `records check` and `records import` with `--mapping`), and Ledger keeps the export and the mapping with the records; [Set up Ledger with a coding agent, step 5](set-up-with-a-coding-agent.md#5-turn-the-spreadsheets-into-import-files) shows how. An aircraft's own log (PX4 `.ulg`, ArduPilot `.bin`, a MAVLink `.tlog`) is read into flight records with `pnpm ledger records read-log`, which fills in only what the log holds and keeps the log as the records' original; [From an autopilot's log](set-up-with-a-coding-agent.md#from-an-autopilots-log) says what it reads and how far each reader has been checked. The Import screen does not take a mapping or a log yet.
- **Correct this record** on a record you opened. The correction is a new record; the earlier one stays, marked as replaced.

Start with these:

| You keep | Record type | The id it is about |
| --- | --- | --- |
| Your fleet: make and model, serial number, registration | Aircraft identity | Your id for the aircraft |
| Inspections and when the next is due | Aircraft inspection | The aircraft |
| Maintenance done | Maintenance action | The aircraft |
| Pilot certificates | Person certificate | Your id for the pilot |
| Training completed; mark `safetyTraining` yes for training that is part of your safety program | Person training | The pilot |
| Each flight you plan: window, place, planned height, the aircraft | Flight plan | Your id for the flight; the aircraft goes in `secondarySubjectId` |
| Who is pilot in command, visual observer and so on for a flight | Role assignment | The flight; the pilot's id goes in `personId` |
| What was flown: takeoff and landing times, places, highest height above ground, the aircraft | Flight record | Your id for the flight; the aircraft goes in `secondarySubjectId` |
| Procedures you hold: lost link, emergency, training program | Organization procedure | Your organization; no id is asked for |

There are 35 record types; [operator-records.md](../design/operator-records.md) lists each with its fields. Heights, distances and speeds are stored in metres and metres per second. To enter feet, miles or knots, name the unit in the column heading, such as `plannedMaxHeightAboveGround [ft]`: the value is converted and the conversion is kept with the record.

A flight plan can be imported before the flight. Rules about a plan read it as soon as it is on file.

**Docks, ground stations and sensors.** A dock, a ground station, a battery or a sensor you keep apart from an aircraft is a component, under your own id for it, such as `D-03`. Record its inspections as **Dock, ground station or component inspection** (`component.inspection`) about it, and work done on it as a **Maintenance action** with subject kind `component`. Name the dock or ground station a flight uses in the flight plan's `dockId`. A waiver condition such as "each dock is inspected every 30 days" is the obligation `maintenance.dock-inspected-within-days`: it reads the inspections of the dock each flight's plan names and says, for example, that the latest inspection of D-03 was made 45 days before takeoff and the rule allows at most 30; a plan that names no dock says so. The aircraft's own inspection obligation never reads a dock's inspection, so do not record a dock's inspection as the aircraft's. A dock's and a sensor's availability are fields of **Aircraft and associated elements availability**.

**Your pilots, fleet and flights.** **Records** opens on **People, aircraft and flights**: a list for each kind, each subject shown by the name its records give it beside your id. A pilot is named by the latest personnel file, an aircraft by its latest identity record (make and model, registration), a flight by its plan (its window in your organization's time zone and its route). A subject no such record names yet is shown by its id. Open one to see its file: every record about it by type, including the role assignments that name a pilot and the flight plans that name an aircraft, what replaced what, the rules that cover it with the latest result of each, and its open findings.

**Handing records to an inspector.** On a subject's file choose **Produce these records**, or open **Produce records** and choose subjects, record types and dates. Say why and who asked; both are printed in the file and kept with the record that you produced it. You get one .zip: a CSV per record type in the import template's columns, with when and by whom each record was recorded and what replaced it; an `index.html` that opens in any browser and prints; and a `manifest.json` with the SHA-256 of every file. Beside each number and time the CSV shows it as it was entered, such as `200 ft` or `2026-10-05 (date only)`. The file for a pilot lists the flights the pilot was assigned to, with ids and times; ask for their flights' records too with `--with-flights` on the command line. Tick **Include the original files** to add the files the records came from; they are always listed with their digests, and the file says when an original also holds rows about other subjects, and how many, since it is included whole. Safety reports and restricted attachments are never included. **Produced records** lists every file produced, with who, when, why and the selection, and downloads it again. Copy the manifest SHA-256 it shows somewhere apart from the file: [Verify an export](verify-an-export.md#records-produced-on-request) shows how the inspector checks the file with it. A produced CSV also imports into another Ledger organization as the same records.

A flight record is your own logbook entry for a flight once it has flown: `takeoffAt` and `landingAt` are needed (in UTC, with an offset, or in your organization's time zone under a heading such as `takeoffAt [local]`), and a record whose landing is not after its takeoff is refused with a sentence saying so. Without a connected aircraft, it is what the rules read for the flight's times and flown height: the Part 108 items of the record of each flight, the height rules, the aircraft's total time in service and flight hours. Where a source also reports a flight's times or heights, the reported values are read first and the result names your record's figure beside them.

### In the field

The record form and **Report a safety concern** work on a phone, and keep working where the signal drops. Open Ledger and sign in while you have a connection, open **Records** once so the form knows your record types, and keep the page open. A preflight assessment, a flight record or any other record you enter, and a safety report you send, are then kept on the phone until Ledger has them:

- With a connection, the entry is sent at once, as before.
- Without one, the form says **Kept on this device**, and sends it under your sign-in when the connection returns. Where you save a form it says how many of your entries wait; **Show what is kept on this device** lists them, with **Send now** and **Discard**.
- If Ledger refuses an entry, for example because the flight meanwhile has a record of its own, it stays with Ledger's own words: **Correct** it, or discard it.
- Each record says when it was written, by the phone's clock, and when Ledger received it. Ledger does not check the phone's clock.
- Once Ledger has an entry, its content is deleted from the phone. A receipt stays until you remove it: the record's Ledger id, or a safety report's receipt code.
- An installed app, or the page, opens without a connection, but reloading it signs you out, as it always has: you cannot write new entries until you sign in again, and what waits is sent then. Someone else who signs in on the phone is told only that another person's entries wait; they are never sent under that person's name.
- What waits is kept in the browser's own storage on the phone. Ledger does not encrypt it: anyone who can open that browser on the phone can read it. Give each person a browser profile of their own on a shared phone.

The public report page, opened by a reporting link without signing in, keeps nothing on the phone and needs a connection to send. [Entering records without a connection](../design/offline-entry.md) gives the details.

## 5. Adopt the regulations you work under

Open **Rules** and use **Adopt a rule pack**. Ledger ships two regulatory packs:

- **14 CFR Part 107.** Adopt it as **active**: its findings count.
- **The Part 108 proposed rule.** It can only be adopted in **shadow**: its results are recorded and labelled as proposed, and never counted in what a person attests to.

Before you adopt, the form lists every rule in the pack with how it is checked: automatically, by a person, or not supported yet. Some rules ask for a value when you adopt, such as your time zone for a reporting deadline. Write a reason; it is kept with the adoption.

## 6. Bring your own waiver and procedures

Your own rules are a **rule pack** you build from two files:

- `source.txt`: the text of your waiver or procedure, exactly as issued.
- `pack.yaml`: a short description of each provision: the words it quotes and how it is checked.

You edit both in any text editor. One command checks them and builds the pack file. You write no code, no byte offsets and no hashes. Build pack files on any computer that has this repository; the server needs only the file that comes out.

### A waiver or exemption

```sh
pnpm pack:new my-waiver --kind waiver
```

Replace `source.txt` with your waiver's text. In `pack.yaml`, fill in the `waiver` section first: the certificate number as your flight plans cite it, the first and last day the certificate states, and which flights its conditions cover. That last line has no default; write one of:

- `conditionsCover: flights whose plan cites the certificate` when you fly under the waiver on some flights only, such as one for flights beyond visual line of sight. A flight whose latest plan cites the certificate number as its operating authority is checked against every condition. Every other flight gets "does not apply" under each condition, saying its plan does not cite the certificate, and opens no finding. A flight with no plan on file is reported as "No flight plan on file".
- `conditionsCover: every flight` when the waiver's conditions hold for every flight you make.

Then list each provision: quote its words and name what it asks for, from a list of 29 obligation types the file itself carries in its comments. A check about a flight reads the records as of that flight: the record in effect at its takeoff, the days before it, the flights that overlap it. Examples:

| A provision that says | Obligation type | You give |
| --- | --- | --- |
| Only these aircraft may be used | `eligibility.listed-aircraft` | The registration numbers |
| Only these pilots | `eligibility.listed-pilot` | The pilot ids |
| No higher than a stated height | `condition.max-height` | The height in feet |
| A visual observer is assigned | `condition.visual-observer-assigned` | Nothing |
| Pilots completed a named course within so many months | `qualification.named-training-current` | The course title and the months |
| A named party is told so long before operations | `notification.before-operations` | The party and the hours |
| A named party is told not more than so long before operations | `notification.not-more-than-before-operations` | The party and the hours |
| Operations only at the listed sites | `condition.site-listed` | The site ids your flight plans use |
| Detect-and-avoid equipment checked before each flight | `equipment.detect-and-avoid` | Nothing: it reads the aircraft's check made since its previous flight and before takeoff |
| The aircraft inspected within so many days before each flight | `maintenance.inspected-within-days` | The days and the kinds of inspection that count |
| The dock or ground station a flight's plan names inspected within so many days before the flight | `maintenance.dock-inspected-within-days` | The days and the kinds of inspection that count |
| No pilot flies more than so many aircraft at once | `operation.aircraft-per-pilot` | The number; it is counted from the pilots' assignments |
| Pilots flew so many flights in so many days before | `qualification.recent-flights` | The flights and the days |
| An occurrence is reported to a named office within so many hours | `report.occurrence-within` | The kinds of occurrence record, the office and the hours |
| Maintenance is documented | `record.maintenance-complete` | Nothing |
| The operator has a stated procedure | `procedure.on-file` | The kind of procedure |
| A copy of the certificate is at the control station | `authority.certificate-at-hand` | Nothing: a person confirms it |

Every provision is checked for the flights its conditions cover. A provision about pilots, such as the training one, covers each person a covered flight assigns as remote pilot in command, and nobody else; a covered flight with no such assignment says "No remote pilot in command assignment on file". A provision about aircraft covers the aircraft a covered flight's plan names. A procedure on file is checked once, for your organization. `examples/first-operator/` is a complete invented example, with records to import.

**Relief.** A provision that lets you do what a regulation otherwise forbids names the rule it relieves:

```yaml
    obligation: authority.flight-cites-certificate
    parameters:
      certificateNumber: EX-0000
      effectiveFrom: 2026-01-01
      effectiveThrough: 2027-12-31
    relieves:
      - packId: ledger.part107
        ruleIds: [ledger.part107.107.31.a]
```

`pnpm pack:list ledger.part107` prints every Part 107 rule with its id. While the waiver is adopted as active, a flight whose plan cites the certificate, within the dates the certificate states, has that rule's result recorded as relieved, naming the provision, instead of opening a finding. A flight that does not cite it keeps the rule's own result. A flight that cites it on a day outside those dates is listed under the provision as needing attention, with the certificate's dates and the flight's own, and keeps the rule's own result too.

A provision that asks for two things, such as listed pilots who have also completed a recurrent course, carries two obligations: write it as two entries, each quoting its part, numbered apart (`6` and `6b`). Each becomes its own rule. The template shows one.

### Your own procedures

```sh
pnpm pack:new my-manual --kind procedure
```

The folder starts as a small invented operations manual with four rules, one of each common shape. It builds as it is, so you can load it and see it work before changing a word:

| The manual says | What the rule reads | What it reports |
| --- | --- | --- |
| Each pilot completes the recurrent course within 12 calendar months | Each person's latest recurrent training record | Whether its date is within 12 months; "No recurrent training record on file" for a person without one |
| An aircraft is flown only while its inspection is not overdue | Each aircraft's inspection records, its time in service and its flight records | Whether the latest inspection's next due time and next due hours in service are still ahead, naming the aircraft's hours: "RIDGE-AC-1 had 120.2 h in service now; the inspection recorded on 2026-09-01 was due at 120 h"; "No inspection record on file" otherwise |
| No flight is planned above the limit the operations manager sets | Each flight's plan | Whether the planned height is within the limit you set when you adopt the pack |
| The pilot briefs the crew on site hazards | Nothing: no record shows it | Listed as a rule a person checks, with what that person confirms |

To write your own, copy the rule closest to yours and change four things: the `quote`, the record type it reads, the field, and the check's parameters. The comments in `pack.yaml` say what each line means. The questions a rule can ask, and the check kind for each:

| You want to check that | Check kind |
| --- | --- |
| A date in a record is within the last N calendar months (training, a test, a review) | `date.within-months` |
| A record that runs from one time to another covers now, or covers a flight's window (an inspection, an assignment) | `interval.covers-window` |
| Something is next due at a time or at hours in service (an inspection), now or at each flight's takeoff | `due.time-or-total` |
| A value of each flight within a limit, from what a source reported or else the operator's flight record (wind at takeoff, battery at landing) | `window.values-within-limit` with its `recorded` read |
| A number is within a limit, fixed or set on adoption (height, speed, distance, hours) | `value.within-limit` |
| A field holds one of the values you accept (a status, a method) | `value.one-of` |
| A record exists and has every field filled in | `record.complete` |
| A record was made a stated time before a flight starts (a notice) | `record.made-before` |
| Each event was followed by its report within a period | `events.answered-within` |
| A record was made in every month, quarter or year | `periods.each-recorded` |
| A total over a day or week stays within a limit (flights per day, duty hours) | `local-days.total` |
| A total from an opening balance plus later entries stays within a limit (time in service against a life limit) | `total.from-opening` |

[Write a rule pack](write-a-rule-pack.md) explains every field of a rule, and [record-check-kinds.md](../design/record-check-kinds.md) every check kind with its parameters.

Two lines decide whether a missing record is reported or passed over in silence. Keep both on every rule:

- `population` says who the rule covers: every person, aircraft or site your records name (`on_record`), or the flights with records in the adoption's dates (`in_adoption_dates`).
- `onFile` on a read names the record in your own words. A covered subject without it is counted as "No … on file".

### Build, load and adopt

```sh
pnpm pack:build my-manual --out packs
```

The command prints each rule it made: the words it quotes, who it covers, what it reads and what is set on adoption. Read that printout; it is the rule as Ledger will run it. When something is wrong it names the provision and what it expected: for a quotation that is not in the source, it says how many words matched and what the source reads after them.

Then load the pack:

1. Set `LEDGER_PACKS_DIR` to the full path of the `packs` folder, in `.env` on your own computer or in the server's environment ([Deploy Ledger, section 4](deploy.md#4-environment-variables)).
2. Restart Ledger. It reads the folder only when it starts, and refuses to start if a file was edited after it was built, naming the file and the reason. `pnpm pack:check packs/<file>` makes the same check beforehand.
3. Open **Rules**. The pack is offered under **Your organization’s files**. Adopt it as active, or in shadow first to watch its results before they count. The form offers the latest version of each pack, with earlier versions under **Earlier versions**, and asks for the first and last day of the adoption in your time zone: the rules cover flights and records inside those days, so start them early enough to take in records already on file. For a waiver, the days start as the dates the certificate states, and once it is adopted the Rules screen says "The certificate states it is effective through …" with the days remaining, or that the date has passed. Adopt a new version before then if the certificate is renewed.

**Changing a rule.** A pack version never changes once built: an adoption pins it. Raise `version` in `pack.yaml`, build again, put the new file beside the old one, restart and adopt the new version in place of the old: **Adopt version N** on the adoption under **Rules**, or `pnpm ledger packs adopt <pack>`, which prints which adoption the new version replaces and when each is in effect. If Ledger refuses a pack file after an upgrade because a check kind changed, build it again from its folder as a new version.

## 7. Read where you stand

On **Rules**, each adopted pack shows **Coverage by rule**: every rule, how it is checked, who it covers and the latest result for each, under a heading for each section of the pack (for the proposed Part 108, "§ 108.165 Area of operations" and the like), with the paragraph each rule reads beside its title. A pack without sections, such as a waiver described without them, lists its provisions in number order.

Coverage opens with a line counting the pack's rules, not its findings: how many have a subject needing attention, a record not on file, a subject supported by the record, one relieved by a waiver, how many a person reviews, how many have a subject the rule does not apply to, and how many count nothing yet. A rule with subjects in several results is in each count. Each count is a button that shows only those rules; **Everything** shows them all again. A pack adopted in shadow carries the same "recorded, not counted" label on this line as on its heading. Sections fold: a section with a rule needing attention or a record not on file opens, the others stay closed with their one-line tally, and what you open or close stays so while you are on the screen. Rules that cover no one yet are listed together at the end, under **Nothing counted yet**, each saying which record would make it count, by the record type's name under **Records**.

| Count | Meaning |
| --- | --- |
| Supported by the record | The records on file support what the rule asks |
| Needs attention | A record shows otherwise; a finding is open |
| No record on file | The rule covers this pilot, aircraft or flight, and the record it reads is missing |
| Relieved by a waiver | A waiver you adopted as active covers this subject for this rule |

**No record on file is not a finding.** A result that says a record is missing (no detect-and-avoid check before a flight, no initial training for a pilot) opens no finding, so it never appears under **Open findings**. Two kinds of rule are different, because the absence is what they are about: a rule about a deadline (a notice not made in time before operations, a report not sent within its period after an event) and a limit on a value the rule says must be reported during a flight (the gust, say) need attention and open a finding when nothing was recorded by the time it was due. Read these counts on **Coverage by rule** as well; some are the gaps that matter most. From the command line, `pnpm ledger findings list` ends with each adopted pack's count of them and the command that lists each one, `pnpm ledger coverage --pack <pack> --result no_record`.

Each count opens the pilots, aircraft or flights behind it, by the names their records give them beside your own ids, with the sentence that explains the result. **Findings by subject** lists the findings for one of them, picked by name.

**Open findings** on **Rules** lists every open finding about your people, aircraft, flights and organization in one place. It opens **by rule**: each rule with open findings, the paragraph it checks, how many are open, about how many subjects, how many are owned and the days they are about, the rules with the fewest findings first so the rare ones lead (choose **Most findings first** to turn it round). **Every finding, oldest first** lists them one by one: the subject by name and your id, the rule and the paragraph it checks, the day it is about, how long it has been open, who owns it and any action with its due day. Findings from a pack adopted in shadow are on their own tab, labelled as proposed and never counted. Filter by kind of subject, pack and owner, or by findings nobody owns, and by the days the findings are about: a finding is about the day of the earliest current record about its subject, such as a flight plan's window.

**After you import history**, expect many findings, most of them a few rules repeated for every flight: a rule that reads a record your old log never held finds it missing on each one. The rules with the fewest findings lead; read those first. To work a repeated rule down, open it and use **Take responsibility for all of them**, then **Close all of them** with a reason and a note: each is one decision about every counted open finding of that rule, as narrowed by subject and by days, and each finding shows it. One decision covers at most 500 findings; narrow a larger set by its days. If the set changed after you opened the form, as when a new flight was evaluated, Ledger refuses the decision and you open it again. Closing many findings says what closing one says, finding by finding; nothing is hidden, and a later flight the rule finds the same about opens a new finding. If you do not want a rule to count, adopt differently: in shadow, or a pack version without it. From the command line, a person does the same with `pnpm ledger findings take --rule <rule> --reason "…"` and `pnpm ledger findings close --rule <rule> --as accepted --reason "…"`.

Open one finding to work it:

- **Take responsibility**, or **Assign to a person** who may record decisions.
- The owner records **an action** with the day it is due, and later **what was done**. An action past its due day with nothing done is shown as overdue.
- A finding closes **by itself** when a record your organization keeps answers it, such as the training record or certificate that was missing, and says which record. When the result clears because something reported about the world changed (the wind dropped, the aircraft came back inside its area, a late report arrived), what the finding reported still happened: it stays open, says "The latest result is supported by the record; a person closes this finding", and the **Latest result** filter finds these.
- The owner **closes it** with a reason: corrected by a new record, accepted with the reason stated, the condition ended (what it reported still happened), or recorded in error, and a note. A later result that needs attention opens it again.
- **Open a hazard from this finding** starts a hazard in Safety that keeps the finding as its origin.

Each of these is a decision of the person signed in, kept with their name. Ledger refuses them, and adoptions, from a credential issued to a service or a source.

**Your home screen.** Once a rule pack is adopted, and if no source sends Ledger your orders or flights, Ledger opens on **Flights on record**: the flights your flight plans give, upcoming first, then recent, each with its window, the aircraft its plan names, the pilot in command your role assignments name, and its open findings. Each opens the flight's file. Beside them, **Needs attention** counts the open findings nobody owns and the actions that are overdue, and opens them. Once a source that creates flights is on record, Ledger opens on the live operation instead.

Ledger reports what the records support. It never says an operation is compliant or may fly: a named person with the authority decides, and the decision keeps what they saw.

## 8. Start your safety records

Open **Safety**. Its home lists what is on file and what is not: who may adopt and accept risk, a risk matrix in force, a safety policy in force, and who receives safety reports. Each item not on file names the action that starts it. [Deploy Ledger, "Your first day"](deploy.md#your-first-day) walks each one.

Record your audits, evaluations of the safety program, investigations, the accountable executive's reviews of safety performance, assessments of new or changed systems, and hazard notices under **Safety assurance**. Each records what it covered, what it looked at, what it found and the actions it sets, each with an owner and a due date. A person who may adopt your safety documentation signs it; signing sets its actions. The action's owner closes it by recording what was done, and a finding or an action can open a hazard. The Safety home lists the actions due in the next 30 days and those overdue, by owner. With the proposed Part 108 pack adopted, a rule counts the signed records by type since the adoption's start and the actions open and overdue.

Anyone signed in can send a safety report from any screen with **Report a safety concern**, with their name on it only if they choose. For people who should not need to sign in, a person who configures safety records issues a **reporting link** under **Safety reports** and posts it where your crews will find it. [What submitting a safety report keeps](../design/report-submission.md) says what Ledger keeps about each report and its sender, and what your proxy's logs may keep.

## 9. Keep and produce your records

Under **Records**, **Records your rules require** lists each record the packs you have adopted say you must keep: the words that list it, who the text says keeps it, the record types that hold it in Ledger, how many are on file with the earliest and latest dates they are about, and how long the text says to keep it, in its own words. The proposed Part 108 pack lists the records of proposed § 108.40 with the timeframes of its paragraph (f); the Part 107 pack lists the remote pilot certificate and the report of an emergency deviation, which are presented or sent on request and for which it states no period. A waiver's `pack.yaml` can list its own under `records:` (the template shows how). The list counts what is on file; it never says a record is kept long enough or a requirement is met.

**Start a recordkeeping plan** opens a draft controlled document of the type *Recordkeeping plan*, written from that list as it stands: each record, the Ledger records that hold it, what was on file, the retention as the text states it, how Ledger keeps records and how it produces them. It leaves four blanks, each written `[To be filled in: …]`, that only you can fill: who is responsible for the records, where your Ledger deployment runs, how it and its stored files are backed up, and for how long you undertake to keep them. Find it under **Safety**, **Documents**, record a new revision with the blanks filled, then review it, have it signed and issue it like any document. Reviewing or issuing it is refused while a blank remains, naming the first. Once issued it is the document the proposed Part 108 rule on the recordkeeping plan (§ 108.505(b)(7)) names; whether its content is what the authority accepts is for a person.

What Ledger does and does not do about retention: it keeps every record, every correction and every original file, and removes none, ever. It does not keep itself running. Keeping the deployment, its database and its stored files, and their backups ([Deploy Ledger, section 9](deploy.md#9-backups-and-restoring)), for as long as the text asks is yours.

To produce records on request, use **Produce records** on the same screen, or `pnpm ledger records produce` from the command line. Each production is recorded with its reason and who asked, and the file it makes is checked offline as [Verify an export](verify-an-export.md#records-produced-on-request) describes.

### Show your records to an inspector

An inspector or an auditor can look at your records for themselves, in two ways.

**Add them as a reader** when they will sign in. On **People**, add them from the **Reader** role: they can open your records and each pilot's, aircraft's and flight's file, the rules you adopted and their coverage, the findings, the records you produced, and your controlled documents under **Safety**, **Documents**. They change nothing: Ledger refuses every request of theirs that is not a read, and their screens offer no button to produce, import, enter or export. Like anyone who signs in, they can still report a safety concern, and acknowledge a document you issue to them. They never see a safety report, nor the hazard register or safety assurance records, unless you tick **See safety records**, which also opens the list of safety reports (never a report's content). On a server they sign in through your identity provider like anyone else; deactivate them when the inspection is over.

**Send them a link to one produced set** when they will not sign in. Produce the records, then open the set under **Records**, **Produced records** (or **Open this set, to make a link to it** right after producing it). Under **Links to this set**, say who the link is for and for how many days it opens the set: seven unless you choose otherwise, ninety at most. Choose **Make a link** and copy the link Ledger shows: it is shown once, and Ledger keeps only a hash of it. Send it to them as you would any private document.

The link opens a page that needs no sign-in: your organization's name, why the records were produced and who asked, when and by whom, both digests, each file to read or download, and the whole .zip. It opens that set and nothing else, and changes nothing. A link that has expired, was revoked or was never made gives the same plain answer, so it tells nobody whether your organization or a set exists. **Revoke this link**, with the reason, stops it at once.

Each opening is kept on the set's screen beside its link: when, and whether it was the page, one file or the .zip. Ledger keeps nothing about who opened it, no address and no browser, since it keeps as little about a person as the record needs. A proxy or load balancer in front of Ledger logs every request's address on its own; whether and how long it keeps those lines is your deployment's to configure. The link itself is after `#` in its address, which a browser never sends to a server, so it is in no such log. Making and revoking a link are recorded with who did it and why.

A produced set never holds a safety report or a restricted attachment, so any set can be shared this way.

### Show a program owner how you stand

An organization that contracts you, a utility with inspection crews for example, may want to see how you stand without reading your records. Give it a grant. On **Reports**, **Shown to program owners** (a person who manages authority sees it), name the program owner, choose for how many days the grant answers (ninety unless you choose, a year at most) and tick what it shows, from this list only:

- the coverage of packs you adopted: for each rule, its name and citation and how many subjects are in each result;
- your open findings: how many are open for each rule, and when the oldest opened;
- produced sets: each with a link of the kind above, made with the grant and ending with it.

Choose **Make the grant**. Ledger shows this Ledger's address and the grant's secret once; give both to the program owner as you would any private document. Ledger keeps only a hash of the secret.

The program owner's Ledger reads the grant over the network, about once an hour. What it gets is counts of recorded things: never a subject's id or name, a record or a value, a person's name, or anything of a safety report. Each read is listed under the grant with its time and what was read; Ledger keeps nothing about who read it. **Revoke this grant**, with the reason, stops it at once, and the links made with it with it. A grant that has expired, was revoked or never existed gets the same plain answer, so it tells nobody whether your organization exists.

### Reports to print or save

**Reports**, in the bar, and linked from the Safety home and from **Records**, holds pages to read, print or save as a PDF. Each counts recorded things only, says when it was made in your organization's time zone, says what it does not count, and has an address of its own: a link to a summary opens the same period for whoever may read it.

- **Summary of a period**: for the days you choose (this month, last month, this year, last year, or any two days up to two years apart), the flights with a flight record taking off in the period and their recorded time from takeoff to landing; the counted findings of each rule, opened and closed in the period and open at its end; the actions on findings and of safety assurance records open at its end and how many of them are overdue; and the hazards open at its end by the level of their latest assessment. A flight that has only a plan, a finding of a rule adopted to propose only, and a finding a waiver relieves are counted apart. Each number opens the list it counts.
- **Findings by month**: how many counted findings opened and how many closed in each month, for every rule or one rule, the last twelve months unless you choose others. The chart is told in a sentence, and its numbers are in a table under it, which prints unfolded.
- **Indicators over time**: each indicator with recorded results, one point per result over the window it covers, the level its definition sets drawn and named when it sets one, and a stretch with no recorded result shown as a gap. Each point leads to its row in the table under the chart.
- **One flight's file**: the flight's own records, the records that name it, each rule's latest result with what it read, and its findings, on one page. Open it from **Reports** or from the flight's file under **Records**.

A person sees the parts they may read. A reader sees the flights and findings and is told the hazards and safety assurance actions are not theirs to read; a person who reads only safety records sees the opposite. No report shows the content of a safety report.

### Follow the operators you contract

When you contract operators that run Ledger, each can give you a grant (see [Show a program owner how you stand](#show-a-program-owner-how-you-stand)): its Ledger's address and a secret. On **Reports**, **Operators you follow**, a person who manages authority fills in **Follow an operator** with your own name for the operator, its address and the secret. Ledger keeps the secret for its workers and never shows it again. The address starts with `https://`; only a local Ledger reads an `http://` address, or one on this computer or a private network.

Ledger's workers read each operator within the hour and hourly after, and **Ask for a fresh read** reads it now; **Show the latest reads** shows what has arrived without reloading the page, which would sign you out. Every answer is kept with when it was read and its digest, and every failure with its reason, under **Every read**. The page lists the operators side by side in alphabetical order: when each was last read, until when its grant answers, each pack's rules with how many subjects are in each result, the open findings by rule with the oldest one's age, and links to the produced sets it shared. There is no score and no ranking. A row whose last read failed, whose grant ended, or that has not been read for two hours says so, and shows the last answer with its date, never as current.

**Stop following** an operator, with the reason, when the contract ends: its answers are kept, its secret is erased, and it is read no more. Anyone who reads records, a reader too, can open the page.

## 10. Connect aircraft, docks and airspace services

Everything above works from records people enter and import. To also check what an aircraft or an airspace service reported, add the source on the **People** screen, issue its credential there, and start an adapter process for it with `pnpm adapter:run`. [Deploy Ledger, section 10](deploy.md#10-connect-a-source-run-an-adapter) has the steps, and says how far each shipped adapter has been checked: none has been run against real equipment yet.

## What does need code

Ledger is built so that these are additions beside the core, each with a guide, but they are TypeScript:

| You need | Why it is code | Guide |
| --- | --- | --- |
| A question none of the check kinds answers | A check kind is deterministic code, versioned and tested | [Write a rule pack](write-a-rule-pack.md), Part 2 |
| A system no shipped adapter reads | An adapter turns one system's messages into Ledger's observations | [Write an adapter](write-an-adapter.md) |
| A new kind of control or indicator for your safety records | Each is a small definition with its own tests | [Write a control type](write-a-control-type.md), [Write an indicator](write-an-indicator.md) |

Before deciding you need one, check the record types and check kinds that exist: a rule you write in a pack file can combine any record type with any check kind. A record Ledger has no type for, such as a battery cycle log, needs no code: your pack declares it, with its fields, units and options, and once the pack is adopted it has an import file, a form on the Records screen, production and checks like any other ([Write a rule pack, "Declare a record type"](write-a-rule-pack.md#declare-a-record-type)). Only a new kind of subject, beyond people, aircraft, flights, sites, components and the organization, is core work.

## What was run for this guide

Steps 2 to 7 were run on an empty database as written: the organization created, the procedure template built and loaded from a pack folder, adopted as active, records imported from CSV and JSON, and coverage read on the Rules screen. `packages/standard-packs/tests/procedure-template.integration.test.ts` builds the same template, adopts it, imports records for three pilots, two aircraft and two flights, and checks every count. Step 9 is run by `tests/integration/recordkeeping-plan.integration.test.ts` through the API and the command line: the required records read, the plan started, refused for review while a blank remains, filled, signed and issued, and records produced and verified offline; its screens are in `tests/browser/recordkeeping-plan.spec.ts`, which was not run for this guide. `tests/integration/organization-setup.integration.test.ts` covers creating the organization and adding people. If a test and this guide ever disagree, the test is right.
