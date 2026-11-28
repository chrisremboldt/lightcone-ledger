# Lightcone Ledger

Ledger is an operational record and rule checker for drone programs. It keeps what an operation knew, decided and did, and checks that record against the rules the organization has adopted. It is also built to be used as infrastructure for an organization's safety management system (SMS): see [Using Ledger for a safety management system](#using-ledger-for-a-safety-management-system).

See it run: https://demo.lightconesystems.com · What it does: https://lightconesystems.com/ledger/open-source/ · Get started: https://lightconesystems.com/ledger/get-started/

It is built to answer four questions an operator, an accountable executive or a regulator will ask:

1. What needs attention now, and who owns it?
2. What did we know when we decided, who decided, and under what authority?
3. Are our controls in place, and are they working?
4. What changed since, and what does the record show about it?

This is early software. Read [Status and limits](#status-and-limits) before relying on it.

## What it does

- **Records.** Every input and command is appended to a per-tenant, hash-chained journal. Original bytes are kept beside the normalized values. Corrections are new events, never edits.
- **Rule checks.** Rule packs are immutable, versioned sets of rules. Each rule carries its retained source text, pinned by byte span and SHA-256. An organization adopts an exact pack version for a date range, and Ledger reports, rule by rule, what is checked automatically, what needs a person, and what is not supported. Each adoption has a mode. In shadow, rules are evaluated and their findings recorded and labelled, but never counted in what a person attests to; in active, they are. A pack that cites proposed text can only be adopted in shadow. A provision of a waiver the organization holds can relieve a named rule of another pack: the result is recorded as relieved, with the provision, and not counted. For each adopted pack Ledger shows coverage by rule, grouped by the pack's sections with the paragraph each rule reads: who the rule covers, the latest result for each, and which records are not on file. It opens with the pack's rules counted by result, each count a filter, and folds the sections with nothing to do. Changing mode is a new adoption revision; evaluations keep the mode they were recorded under.
- **Safety management.** Reports, hazards, risk acceptance, controls and controlled documents on the same record as the flights. The list is under [Using Ledger for a safety management system](#using-ledger-for-a-safety-management-system).
- **Decisions and signatures.** A decision records the view the person saw and the basis validated at commit. A signature binds a re-authenticated person, their authority at that moment and the digest of the exact content.
- **Findings a person works.** A finding about a flight, a pilot, an aircraft or the organization can be taken or assigned, given an action with a due date, and closed by a person with a reason. A record a person keeps closes it by itself when it answers the finding; a measurement that returns inside its limit does not. One list shows every open finding with its age and owner.
- **Notices.** A person is told by email when a finding or an action is assigned to them, when an action of theirs is due within three days or overdue, and when a document waits for their acknowledgement, and gets a daily or weekly digest if they ask. An organization can have the same posted to its own signed webhook. Both are off until configured; every notice and every attempt to send it is on record. A safety report or a restricted record is named by its reference and link only.
- **Records for an inspector.** Each pilot, aircraft and flight has a file of everything on record about it. Records are produced on request, by subject, type and date, as one .zip with a readable index, a CSV per record type and a manifest that verifies offline. An inspector can look for themselves: signed in as a reader, who opens records, coverage, findings and controlled documents and changes nothing, or through a link to one produced set that needs no sign-in, expires, is revoked at once and keeps each time it was opened. Each adopted pack lists the records its text requires with the retention the text states, and a recordkeeping plan is drafted from that list as a controlled document.
- **A program owner's view.** An operator grants an organization that contracts it a read of named things for a period: the coverage of named packs by rule and result, open findings by rule with the oldest one's age, and links to named produced sets. The program owner's Ledger reads each operator it follows over the network, keeps every answer and failure, and shows them side by side in alphabetical order. Counts only, never a subject, a person or a safety report; a grant is revoked at once, and both sides keep their record of it.
- **Reports to print or save.** A summary of a period: flights and flight time from the flight records on file, findings by rule (opened, closed, open at the end), actions open and overdue, and hazards by level, each number linked to the list it counts. Findings opened and closed per month by rule, an indicator's recorded results over time with the limit its definition sets, and one flight's file as a page. For a calendar month, to prepare a report you send yourself: flight time by aircraft from the flight records on file, with each aircraft's registration and serial number and each flight with no landing time listed, and the occurrences recorded, by type; both download as CSV, both are read from the command line (`pnpm ledger reports`) and by an agent, and each leads to the form that records that a report was provided. Ledger sends nothing. Charts are drawn in the theme and told in a sentence, with their numbers in a table; a part a person may not read is named as not theirs, never shown as zero. No score and no rating.
- **Record types your own pack declares.** A record no built-in type holds is declared in the organization's pack file, as data: its fields, units, options and what it is about. Once the pack is adopted it has an import file, an entry form, browse, production and checks, as a built-in type does, and other organizations do not see it. [examples/declared-record-type](examples/declared-record-type) is one to copy. [examples/preflight-checklist](examples/preflight-checklist) is a paper checklist as such a type: a dozen items in sections, each answered done, not applicable or defect found, with rules that ask that one is on file before each takeoff, that every item is answered, and that none is answered defect found. [examples/flight-risk-assessment](examples/flight-risk-assessment) declares a scored preflight assessment: its rules add up the points the operator's own procedure gives each answer and compare the total with the level the procedure states.
- **Records entered in the field.** The web app installs on a phone and opens without a connection. A record entered in its form, such as a preflight assessment or a flight record, and a safety report sent while signed in, are kept on the device until Ledger has them, then sent under the same person's sign-in, once each, with the time the device wrote them beside the time Ledger received them. Their content is deleted from the device as soon as Ledger has it. [docs/design/offline-entry.md](docs/design/offline-entry.md) says how.
- **A command line, and a guide for a coding agent.** `pnpm ledger` adds people, imports records, reads coverage and findings, prepares an adoption for a person, drafts safety records from files, produces records and drafts the plan, over the public API, and reads one finding with the evaluations, the records and what is not on file behind it. `pnpm ledger mcp` offers the same reading commands, checks and imports as tools to an agent that speaks the Model Context Protocol; a person's decision is prepared there, never sent. [Set up Ledger with a coding agent](docs/guides/set-up-with-a-coding-agent.md) is written to the agent an operator asks to do the setup.
- **Evidence.** Exports can be verified offline with `tools/verifier`, which needs only Node and imports no Ledger packages.
- **For a deployment.** Metrics in the Prometheus text format from the API, the workers and the adapter process, each on a listener of its own and off unless configured; no label names an organization, a person or a record. A request limit per credential. A [changelog](CHANGELOG.md) with an upgrade note for each release, and [a rule for what a release may change](docs/upgrading.md). See [Deploy Ledger](docs/guides/deploy.md#8-health-checks-and-metrics).

## Using Ledger for a safety management system

An SMS is an organization's own: its safety policy, its accountable people, its procedures and its practice. Ledger is built to be used as infrastructure for an organization's SMS, on the same journal as its flights. It does not supply a policy or a program, and it does not make an organization conform to 14 CFR Part 5. The safety policy and risk matrix in the seed are fictional examples. What it provides:

- **Confidential safety reports.** Anyone signed in can submit a safety report from any screen, with their name on it only if they choose. A person who configures safety records can issue reporting links: a link opens a page where anyone can send a report without signing in, and can be revoked at once. Every submitted report is stored as sent by the organization's safety reporting channel, not by a person, so nothing Ledger keeps (the record, the journal, the reporter's receipt, its request log, any export) names a person who sent a report without their name, and nothing keeps the address or browser of anyone using a link. The reporter is shown a receipt code once, with which they can see only whether the report is received or closed. A person cleared to handle reports also records reports received in person, by phone, by email, on paper or through an app. A report's title, narrative and reporter are stored apart from ordinary records, can be read only with a specific permission, and are left out of every export. Each read of a restricted attachment is recorded. What a reverse proxy in front of Ledger logs, and what a database administrator can read, are set out in [What submitting a safety report keeps](docs/design/report-submission.md).
- **A hazard register.** A hazard is opened by hand, from a report, from a finding on a flight, or from a finding or action of a safety assurance record, and keeps its origin.
- **Risk assessment and acceptance.** Each hazard is assessed on the risk matrix the organization has adopted, with its own two to six levels. A risk is accepted by a person whose authority covers its level, with a signature; a level the matrix says nobody may accept cannot be accepted by anyone.
- **Controls.** A control is recorded against a hazard with an owner and the dates it is in effect. An accepted control is checked against flights like any other rule.
- **Safety assurance.** Findings from the rules the organization has adopted, indicators measured against flights or flight hours, and reviews of whether each control is working.
- **Safety assurance records.** Audits, evaluations of the safety program, investigations of an incident or accident or of a report of possible non-compliance, the accountable executive's reviews of safety performance, assessments of a new or changed system, and hazard notices sent to or received from another organization. Each records what it covered, what it looked at, what it found and the actions it set, each action with an owner and a due date and closed by a person who records what was done. A record is drafted, revised and signed by a person with the authority to adopt safety documentation, and never deleted. An investigation can start from a safety report, linked without copying anything from it.
- **Safety training.** A training record can be marked as safety training.
- **Controlled documents.** A safety policy, an accountable executive designation, roles and risk authority, an emergency response plan, an SMS manual, procedures and safety notices: drafted, reviewed, signed, issued, reviewed again on a schedule and withdrawn, with every revision kept and any two comparable. Documents received from outside, such as a manufacturer's manual or a service bulletin, are kept the same way.
- **Distribution and acknowledgement.** A document is issued to named readers, and each acknowledges one exact revision. A briefing goes to named people. The record shows who has acknowledged and who has not.
- **A safety home.** What needs attention now, and who owns it, including the safety assurance actions due in the next 30 days and those overdue, by owner.
- **Records and retention.** Every record is append-only and is labelled with its class: safety risk management output, safety assurance output, training record, safety communication.
- **Evidence.** A safety record and what it rests on can be exported and verified offline.

## Extend Ledger

A new kind of problem is added through four extension points, with no change to core code. Each guide is a worked example you can follow in your own checkout:

- [Write a rule pack](docs/guides/write-a-rule-pack.md): rules that quote their source text and check retained records.
- [Write an adapter](docs/guides/write-an-adapter.md): turn a source's bytes into observations, keeping the original bytes.
- [Write a control type](docs/guides/write-a-control-type.md): a kind of control a hazard's risk acceptance can bind, and when it applies to a flight.
- [Write an indicator](docs/guides/write-an-indicator.md): a rate over findings or issues, measured against flight hours, flights or other exposure.
- [Verify an export](docs/guides/verify-an-export.md): check a finding or decision packet, or records produced for an inspector, offline with Node alone.

[docs/README.md](docs/README.md) indexes the guides and the design notes. The packs and adapters Ledger ships are listed under [Shipped packs and adapters](#shipped-packs-and-adapters).

## Two doctrines

**People attest; Ledger records.** Ledger never issues a compliance verdict. It does not say "compliant", "authorized" or "go". A check reports what the evidence supports and what needs attention. Every judgment (a release, a risk acceptance, a finding treatment, an adoption) is made by a named person with the authority to make it, and is stored with the basis they saw. A rule pack does nothing until a person adopts it.

**Deterministic, not generative.** Rule checks are ordinary code over retained records. The same inputs give the same result, and each recorded evaluation names the rule version and the input digest it used. No language model produces a finding, an evaluation result or a decision, and none is called anywhere in this codebase. Where rule text was drafted with AI assistance, the pack says so (`review: 'ai_drafted'`) and it stays unadopted until a person adopts it.

An assistant is the operator's own, outside Ledger: a coding agent reads and checks through the command-line client or its MCP server and never sends a decision. [docs/design/assistants.md](docs/design/assistants.md) says why.

## Architecture

```text
people (browser, phone)    ─┬─▶ public API ─▶ receipts + append-only journal + outbox
imports / adapters         ─┘                          │
                                      leased, fenced workers ◀┘
                                                │
                          projections (SMS records, flights, timelines)
                                                │
                          query API + SSE ─▶ web app
                                                │
                               exports ─▶ offline verifier
```

One TypeScript codebase. PostgreSQL 17, with no extension, holds the journal, projections, work queue and outbox. Object storage, or a folder on disk, holds original bytes. A deployment runs the API and the workers as two processes of one container, or as separate containers; [Ledger Lite](#ledger-lite) runs them in one process.

| Path                                                                                      | Responsibility                                               |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `apps/api`                                                                                | Fastify public API: inputs, uploads, commands, queries, SSE  |
| `apps/workers`                                                                            | Leased, fenced work: projections, evaluations and deadlines  |
| `apps/web`, `packages/ui`                                                                 | Safety home, SMS registers and records, flight monitor       |
| `packages/contracts`                                                                      | JSON schemas, OpenAPI, typed client                          |
| `packages/persistence`                                                                    | Transactions, migrations, row-level security, object store   |
| `packages/domain`, `packages/projections`                                                 | Commands, decisions, rules, current-state derivation         |
| `packages/integrity`, `packages/evidence`, `tools/verifier`                               | Hash chains, exports, offline verification                   |
| `packages/adapters`                                                                       | Source mappings into Ledger inputs                           |
| `packages/flight-logs`                                                                    | Readers for aircraft logs, into flight records               |
| `packages/metrics`                                                                        | Metrics registry and listener, in the Prometheus text format |
| `apps/simulator`, `apps/emulators`, `packages/simulation-models`                          | A simulated flight operation used for development and demos  |
| `infra`                                                                                   | Local Compose stack, the container image, deployment files   |

Invariants every change keeps:

- **Tenant isolation.** Tenant and principal come from authentication, never the request body. The API and workers run as non-owner database roles under row-level security.
- **Append-only history.** Inputs, receipts, journal events, decisions and signatures are immutable.
- **Durable, idempotent intake.** A receipt means the bytes are stored and work is queued. The same idempotency key with different content conflicts.
- **Decisions pin their basis.** If the basis changed between display and commit, the command conflicts instead of silently accepting.
- **One front door.** The browser, imports, adapters and scripts all use the public API. Nothing writes Ledger tables directly.
- **Workers are fenced.** A worker that lost its lease cannot commit effects.
- **Protected reporting.** A safety report's title, narrative and reporter are stored apart from ordinary records and are readable only with a specific capability. Restricted attachments are never included in an export, and each read of one is retained.

## Quickstart

### Try it with Docker

You need Docker and nothing else (Docker Desktop, or Docker Engine with the Compose plugin 2.24 or later), and a copy of this repository: `git clone`, or the zip from its GitHub page. This starts Ledger and PostgreSQL on your computer, with no fictional organizations, and Ledger on `127.0.0.1` only:

```sh
git clone https://github.com/chrisremboldt/lightcone-ledger.git
cd lightcone-ledger
docker compose -f infra/compose.try.yaml up -d --wait
```

It runs the published image (`ghcr.io/chrisremboldt/lightcone-ledger`, for amd64 and arm64) and the migrations, then waits until Ledger answers. If the image cannot be pulled, the same command builds it from the checkout instead, which takes several minutes; `--build` builds it again after you change the checkout. Then create your own organization, with its name, its [time zone](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones) and your name:

```sh
docker compose -f infra/compose.try.yaml run --rm setup apps/api/dist/create-organization.js \
  --name "Example Aerial Survey" --time-zone America/Denver --admin "Avery Example"
```

It prints your development token once. Open [127.0.0.1:4000](http://127.0.0.1:4000), choose **Use a development token** and paste it. From there, [Your own organization](#your-own-organization) below says what comes next; the commands it names with `pnpm` run against this start as [Try Ledger on one computer](docs/guides/deploy.md#try-ledger-on-one-computer) shows.

This start is for one computer and is plainly not a server: it accepts development tokens, says "Local development" on its sign-in screen and in its log, and keeps uploaded files in a Docker volume. `docker compose -f infra/compose.try.yaml down` stops it and keeps your records; `down -v` deletes them. For a server other people use, follow [Deploy Ledger](docs/guides/deploy.md).

### Ledger Lite

For a small operation on one server, `infra/compose.lite.yaml` is the smallest deployment: one Ledger container that runs the API, the web app and the workers in one process, beside plain PostgreSQL 17, with the original files on a volume. No object store, no broker. It is the same image as any deployment, and unlike the start above it is one: people sign in through your identity provider and development tokens are refused.

```sh
docker compose --env-file ledger.env --env-file ledger-owner.env -f infra/compose.lite.yaml up -d --wait
```

[Ledger Lite](docs/guides/deploy.md#ledger-lite) in the deployment guide says what goes in the two files, how to create your organization, and how the backup covers the database and the files together.

### From a source checkout

To change Ledger, or to watch the simulated operation with its fictional organizations, run it from the checkout. You need Node 24, pnpm 11.19.0 and Docker. Everything runs locally; no account or external service is required. Node 24 ships with Corepack, which provides the pinned pnpm: run `corepack enable` once. Where `corepack enable` is not allowed (it writes to a system folder), type `corepack pnpm` wherever this guide says `pnpm`, or put a one-line `pnpm` in a folder on your `PATH` that runs it for you:

```sh
mkdir -p ~/.local/bin && printf '#!/bin/sh\nexec corepack pnpm "$@"\n' > ~/.local/bin/pnpm && chmod +x ~/.local/bin/pnpm
```

and, if `~/.local/bin` is not on your `PATH` yet, `export PATH="$HOME/.local/bin:$PATH"` in each terminal.

```sh
git clone https://github.com/chrisremboldt/lightcone-ledger.git
cd lightcone-ledger
cp .env.example .env
pnpm install --frozen-lockfile
pnpm vendor:airspace
docker compose -f infra/compose.yaml up -d --wait
pnpm build && pnpm db:migrate && pnpm db:seed
pnpm broker:files:dev && docker compose -f infra/compose.yaml restart mqtt
pnpm dev
```

`pnpm broker:files:dev` writes the local MQTT broker's accounts from the seeded sources (into `infra/mqtt/accounts`, which git ignores); only the telemetry scenarios use the broker.

The stack uses fixed ports unless you change them (the API 4000, the web app 5173, PostgreSQL 54329 and the others `infra/compose.yaml` lists). When another stack on the computer holds them, run yours on other ports with settings only, as [AGENTS.md, "Running a second stack"](AGENTS.md#running-a-second-stack) describes, and check with `pnpm ledger me` that the API you reach is yours.

To run Ledger for your own organization rather than the fictional ones, follow [Set up Ledger for your organization](docs/guides/set-up-your-organization.md): it goes from an empty database to your own aircraft, pilots, flights and rules, and says for each step whether it is done in the browser, in a text file or on a command line. [Deploy Ledger](docs/guides/deploy.md) covers a server. If a coding agent is setting Ledger up for you, point it at [Set up Ledger with a coding agent](docs/guides/set-up-with-a-coding-agent.md): it does the same from the command line with `pnpm ledger`, and leaves each decision to a person.

Open [localhost:5173](http://localhost:5173) and pick an organization and a person. All of them are fictional:

- **Fictional Valley Power** is a seeded utility drone program for the safety management features.
- **Alpha** and **Beta** are two operators that run the simulated flight operation.

Actions come from the chosen person's current authority. Picking a person grants no permissions.

To see Ledger in use without clicking through it yourself, pick an organization on the sign-in screen and choose a scene under **Watch a simulated person use Ledger**. A visible cursor signs in as fictional people and works through the real screens, with captions explaining each step. It makes real records in your local database, and you can pause it or take over at any point.

| Scene | Organization | What happens | Start directly |
| --- | --- | --- | --- |
| A hazard is identified, assessed and accepted | Fictional Valley Power | The safety manager records a hazard; the risk is above their authority, so the executive signs. | `/?autopilot=hazard` |
| A procedure is written, signed, issued and acknowledged | Fictional Valley Power | A document goes from draft to a pilot's personal acknowledgement of one exact revision. | `/?autopilot=documents` |
| A landing report goes missing | Alpha Dispatch | An adopted rule opens a finding by itself; the dispatcher owns it, late evidence arrives, and it is resolved. | `/?autopilot=landing` |
| A lost control link becomes a hazard | Alpha Dispatch | A link monitor reports a lost control link; the finding is promoted to a hazard tied to the flight and assessed. | `/?autopilot=lostlink` |
| New evidence arrives mid-decision | Beta Inspection | A decision is refused because the record changed underneath it, then recorded after a fresh look. | `/?autopilot=decision` |
| Wind at a dock rises above the adopted limit | Alpha Dispatch | A wind limit is adopted, the dock measures wind above it in flight, and the finding becomes a limit the next flight lists. | `/?autopilot=wind` |
| One flight checked against today's rules and proposed ones | Alpha Dispatch | Part 107 and a waiver are adopted as active and proposed Part 108 in shadow; one flight shows both, kept apart. | `/?autopilot=rules` |

Scenes live in `apps/web/src/autopilot/scenes.ts`, written as short scripts.

`pnpm vendor:airspace` downloads the Airspace Link OpenAPI schemas that the local emulator validates against. Only the emulators, the simulated scenarios and `pnpm verify` need them: building and running Ledger for your own organization does not, and without them the Airspace Link emulator answers 503 while the rest runs. They are not kept in this repository. The download checks each schema against its pin in `apps/emulators/vendor/airspace-link/provenance.json` and fails if a schema has changed.

The values in `.env.example`, and the broker passwords `pnpm broker:files:dev` writes, are fixtures for the local stack. They are not secrets and must not be used anywhere else.

Other entry points:

```sh
pnpm demo:documents       # after db:seed: prepare the fictional controlled-document example
pnpm demo                 # reset, then run a continuous simulated operation until Ctrl-C
pnpm scenario             # ten overlapping flights through the order and Airspace Link emulators
pnpm scenario:telemetry   # one DJI flight over MQTT; open it and choose "Telemetry map"
```

### Your own organization

`pnpm org:create` creates an organization with its name and time zone, and its first administrator, on a migrated database. It seeds nothing fictional, and running it again changes nothing.

```sh
pnpm build && pnpm db:migrate
pnpm org:create --name "Example Aerial Survey" --time-zone America/Denver --admin "Avery Example"
```

On a local database the administrator gets a development token, printed once: with `pnpm dev` running, choose **Use a development token** on the sign-in screen and paste it. In a deployment the administrator is tied to their account at the deployment's OpenID Connect provider instead (`--sign-in-issuer` and `--sign-in-subject`); see [Deploy Ledger](docs/guides/deploy.md). To try that sign-in locally, run `pnpm test-issuer` and follow [Try it locally with the test issuer](docs/guides/deploy.md#try-it-locally-with-the-test-issuer). The administrator then adds people and sets what each may do on the **People** screen, and on a local database issues each a development token there so that several people can try Ledger on one computer; adopts rule packs on **Rules** and imports records on **Records**. A source or service that reports to Ledger gets its credential under **Sources and services** on the People screen, or with `pnpm credential:issue` before anyone has signed in. Every screen shows times in the organization's time zone. The web app follows the computer's light or dark setting unless a person chooses a theme in the bar, which this browser keeps. A screen printed from the browser comes out light, without the bar, the navigation or the forms, and with the organization, the screen's title and the time of printing at its top. On a phone the bar is one row, with the sections, the account and the theme in its menu.

From there, the path to seeing where your own operation stands. There are two ways to walk it, and none of it needs code:

- **With a coding agent.** [Set up Ledger with a coding agent](docs/guides/set-up-with-a-coding-agent.md) is written to the agent: every command, what it may do alone, and what only a person does. An agent that speaks the Model Context Protocol can call the same commands as tools through `pnpm ledger mcp`. [examples/first-operator](examples/first-operator) is the whole path for an invented operator, from its waiver and its spreadsheets to coverage, with one script.
- **By hand, in the browser.** [Set up Ledger for your organization](docs/guides/set-up-your-organization.md) walks each step in full.

The steps are the same either way:

1. **People.** Add each person and set what they may do. Every change is recorded with who made it; no one is ever deleted.
2. **Records.** Enter or import what you keep about your aircraft, pilots and flights, from a form, a CSV file or JSON, under your own ids, in your own time zone and units (`windowStartsAt [local]`, `[ft]`, `[kt]`). There is no separate step to add an aircraft or a pilot: each exists once a record names it. A flight that has flown gets a flight record with its takeoff and landing times; duty and rest periods, operating areas and time in service are records too. An export with its own headings, date style and words is read as it is through a column mapping, a small YAML file kept beside it, from the command line; Ledger keeps the export and the mapping with the records. An aircraft's own log (PX4 `.ulg`, ArduPilot `.bin`, a MAVLink `.tlog`), or a GUTMA flight log a fleet or dock product exported (the Global UTM Association's Flight Logging Protocol, a JSON file), is read into flight records by `pnpm ledger records read-log`, which writes only what the log holds and says what it could not read; Ledger keeps the log as the records' original. A file is checked first, and each refused row says why.
3. **Your waiver or procedure, as a rule pack.** Keep its text as issued in a file and describe it beside it: the certificate's number, its stated dates, which flights its conditions cover, and each provision. No code and no offsets: the builder finds each quotation and pins it.

   ```sh
   pnpm pack:new my-waiver --kind waiver     # a folder with source.txt and pack.yaml to fill in
   pnpm pack:build my-waiver --out packs     # writes <id>-v1.pack.json and prints each rule it made
   pnpm pack:compare my-waiver amended.txt   # when the text changes: what each quotation did in the new text
   ```

   `--kind procedure` starts from a small invented operations manual instead. Set `LEDGER_PACKS_DIR` to the `packs` folder and restart. A provision that grants relief names the rule it relieves; while the waiver is adopted as active, that rule's result for a flight flown under the waiver is recorded as relieved, with the provision. A flight not flown under the waiver is recorded as one its conditions do not cover. When the waiver is amended or a new edition of a text is published, `pnpm pack:compare` reports, rule by rule, whether each quotation is unchanged, re-spaced, changed or not found in the new text, lists the passages no rule quotes, and with `--write-next` starts the next version for a person to settle; it works on a built-in pack by its id too. [Write a rule pack](docs/guides/write-a-rule-pack.md) has the whole format.
4. **Rules.** Adopt what you operate under as active, for example Part 107 and your waiver, and what is only proposed, such as Part 108, in shadow, each for the dates you choose. An adoption is a person's decision: the API refuses one from anything else.
5. **Coverage and findings.** Each adopted pack shows, section by section and rule by rule, who it covers and the latest result for each, including what is not on file: "No remote pilot certificate on file" for a pilot is a count you can open, not a silence. Open findings are one list, grouped by rule with the rarest first; a person takes each, records what was done and closes it, or takes and closes every finding of one rule as one decision.
6. **Records on request, and the recordkeeping plan.** Produce the records of a pilot, an aircraft or a period as one file an inspector can read and anyone can verify. **Records your rules require** lists what the adopted texts ask you to keep, with what is on file, and starts a recordkeeping plan from it for a person to complete, sign and issue.
7. **Safety.** The Safety home lists what is on file and what is not: who may adopt and accept risk, a risk matrix in force, a safety policy in force, and who receives safety reports. Anyone signed in can report a safety concern from any screen; a reporting link takes reports without sign-in. Hazards, risk acceptance, controls, audits, investigations and reviews with their actions, and controlled documents are kept on the same record. An organization that already keeps these brings them in from files under its own references with `pnpm ledger safety`; a person accepts, signs and issues each. See [Bring your safety records](docs/guides/bring-your-safety-records.md).
8. **Sources.** To bring in what an aircraft, a dock or an airspace service reports, add the source and issue its credential on the People screen, then start an adapter process for it (`pnpm adapter:run`). See [Connect a source](docs/guides/deploy.md#10-connect-a-source-run-an-adapter), and read its "How far each adapter has been checked" first.

### The avoidance demonstration

An optional demonstration shows an accepted area control preparing a held demo flight for the fictional Alpha tenant: the flight waits on the control's page for a person to revise the route, release it and brief it, then departs and is monitored. It is off unless the API is started with `LEDGER_SIMULATION_AVOIDANCE_DEMO`. To start the stack with it:

```sh
# uncomment LEDGER_SIMULATION_AVOIDANCE_DEMO in .env (its fictional value is in .env.example), then
pnpm build && pnpm db:migrate && pnpm db:seed
pnpm dev
pnpm exec playwright test tests/browser/avoidance-demo.spec.ts
```

The browser test runs the demonstration's source coordinator itself (`apps/simulator/src/operation-demo-runtime.ts`), so nothing else needs to run. Without the variable the test skips. The go-live gate sets the variable, so the test runs there.

## Hosted demonstration

The simulated session can run with no server at all, as a static site anyone can open:

```sh
pnpm demo:build     # writes a static site to apps/web/dist-demo
```

Serve that folder from any static host. Open it, pick an organization and choose a scene, or link straight to a scene (for example `/?autopilot=landing`) to start it on arrival. Every visitor sees a scene from the beginning.

The demonstration replays a recording of what a real Ledger answered when the scene was performed, kept in `apps/web/src/autopilot/tapes`. Nothing is sent anywhere and nothing a visitor does is saved; an attempted change shows a notice instead. The answers are replayed exactly as recorded, and the page’s clock is set to the time of the recording, so the dates on screen are the day the scenes were performed. (Ledger’s screens check content against what was signed, so a replay that altered the times would be refused.) An ordinary production build contains none of this.

After changing a scene or the screens it uses, record the scenes again against a freshly seeded local stack with `pnpm demo:record` (see the notes at the top of `tools/record-demo-tape.mjs`).

## Checks

```sh
pnpm verify             # format check, build, typecheck, unit tests
pnpm test:integration   # PostgreSQL tests against a separate ledger_test database
pnpm test:browser       # with the seeded pnpm dev stack running
pnpm generate:client    # regenerate docs/openapi.json and the typed client after contract changes
pnpm verify:bundle      # verify an exported bundle offline
```

## Shipped packs and adapters

The rule packs and adapters Ledger ships. To add your own, or a control type or indicator, see [Extend Ledger](#extend-ledger).

**Rule packs** register through `registerRulePack` in `packages/domain/src/rule-pack-registry.ts`, and the API and workers register the shipped packs at startup through `registerStandardPacks` in `packages/standard-packs`. These are included. Two quote a regulation's text: `ledger.part107` and `ledger.part108-nprm`, offered to every organization. Every other one is marked *example*: it is invented, names fictional organizations, and is offered only to the seeded fictional organizations of a local stack. An organization of your own (made with `pnpm org:create`) is offered the examples only when the API and the workers run with `LEDGER_EXAMPLE_PACKS=1`.

- `ledger.demo-procedures` (*example*; assembled in `packages/domain/src/rules/demo-procedures-pack.ts`): invented operating procedures with automated checks, for example a landing time reported differently by two sources, or landing evidence overdue. Its latest version, 6, has 4 rules a check runs, 0 a person checks and 0 not supported yet.
- `ledger.part108-nprm` (the `packages/pack-part108-nprm` package): paragraphs of the proposed 14 CFR Part 108, quoted by byte span from the retained Federal Register notice (FR Doc. 2025-14992). It is proposed text, not current law, and can be adopted in shadow only. Its checks read operator records: records kept, including each item of the record of each flight (proposed § 108.40(a)(3)) from the operator’s flight record or a source’s report, preflight determinations, duty and rest, flight coordinators and their recency, notice of a new operations supervisor, the reporting clocks of the proposed § 108.45(h) and a failure of a data service reported to its provider, the organization's operating areas (circles and corridors it records, each with its own id, read together for the positions flown), training, security threat assessments, physical security and cybersecurity, inspections, equipment availability and inoperative equipment, the battery monitoring program, a flight after maintenance with no return to service recorded, the flown or planned height, airspace authorizations, and what is on file for a certificate application (proposed § 108.505(b)) and a safety management system (proposed § 108.560): controlled documents in effect for each purpose, the adopted risk matrix, the accountable executive, counts of hazards, and counts of safety assurance records in the adoption's dates with their actions open and overdue. Its rules are listed by the section of the proposed part each quotes, with the paragraph beside each; [docs/design/part-108-coverage.md](docs/design/part-108-coverage.md) lists every paragraph of Subparts A, B, C and E with the rule that reads it or why none does. It reports what is on file, never whether it is adequate. Its latest version, 3, has 86 rules a check runs, 9 a person checks and 0 not supported yet.
- `ledger.example-operations` (*example*; the `packages/pack-example-operations` package): an invented operating procedure, not a regulation or a manufacturer limit, checked by the generic evaluator. Version 1 has one rule, which reports an aircraft whose latest reported remaining battery is below the reserve the organization sets when it adopts the pack; with no battery report the evidence is insufficient. Version 2 adds the same check per flight, on the reading at or before the landing. Its latest version, 3, has 3 rules a check runs, 0 a person checks and 0 not supported yet.
- `ledger.part107` (the `packages/pack-part107` package): paragraphs of 14 CFR Part 107 in force on January 1, 2026, quoted by byte span from the retained annual edition of the Code of Federal Regulations. Its rules are checked against operator records, and where they are on record against what the aircraft reported in flight and the airspace authorizations an airspace service recorded. It can be adopted in active mode. Its rules are listed by the section of Part 107 each quotes. Its latest version, 2, has 21 rules a check runs, 3 a person checks and 0 not supported yet.
- `ledger.example-waiver` (*example*; the `packages/pack-example-waiver` package): an invented certificate of waiver for the fictional Alpha Dispatch, retained as a text file and quoted provision by provision. It is not a real waiver and grants nothing. Each provision points at a shared obligation type (listed pilots and aircraft, a maximum height or distance, a visual observer, training currency and others) that states how it is evidenced; its provisions are checked against operator records, among them notification before operations. A further waiver is a data file passed to the pack's builder, with no new code. Version 2 quotes an invented amendment whose Attachment A lists Alpha Dispatch's pilots by the identifiers the sample crew records use, `ALPHA-PILOT-01` and `ALPHA-PILOT-03`; `ALPHA-PILOT-02` is left out on purpose, so the sample flights that pilot commands carry the listed-pilot finding. Version 1 stays registered as released. It states its certificate's effective dates and that its conditions cover every flight. Its latest version, 2, has 11 rules a check runs, 0 a person checks and 0 not supported yet.
- `ledger.example-airspace` (*example*; the `packages/pack-example-airspace` package): an invented operating-area procedure, not a regulation. Its one rule reports an aircraft whose reported positions leave the circle and margin the organization sets when it adopts the pack; a single position outside does not count. Its latest version, 2, has 1 rule a check runs, 0 a person checks and 0 not supported yet.
- `ledger.example-crew` (*example*; the `packages/pack-example-crew` package): an invented crew duty and rest procedure, not a regulation. Three rules per person check the latest duty period against the longest duty period, the shortest rest before duty and the most duty in 168 hours that the organization sets when it adopts the pack, and whether its duty record is complete (then the time between two recorded duty periods counts as rest); a rule per flight checks every person its role assignments name against the same limits for the duty period they are on during their assignment, so a finding belongs to the flight and names the person. Its indicator counts those per-flight findings per 100 recorded duty periods. Its latest version, 1, has 4 rules a check runs, 0 a person checks and 0 not supported yet.
- `ledger.example-bvlos-waiver` (*example*; the `packages/pack-example-bvlos-waiver` package): an invented certificate of waiver for the fictional Alpha Dispatch for flights beyond visual line of sight, retained as a text file and quoted provision by provision. It is not a real waiver, grants nothing and is modelled on none. Its first provision declares relief from the Part 107 pack's visual-line-of-sight rule: while the waiver is adopted in active mode, that rule's evaluations are recorded as relieved, naming the waiver adoption, who adopted it and the provision, and are not counted; in shadow the rule still counts. Its other provisions are ordinary rules: an operating area, detect-and-avoid equipment, a lost-link procedure on file, wind and visibility at takeoff, named pilots and notification before operations. Its conditions cover only the flights whose plan cites its certificate: for any other flight they do not apply, and the lost-link procedure is checked once, for the organization. See [docs/design/waiver-relief.md](docs/design/waiver-relief.md). Its latest version, 1, has 8 rules a check runs, 0 a person checks and 0 not supported yet.
- `ledger.example-weather` (*example*; the `packages/pack-example-weather` package): an invented wind limit procedure, not a regulation or a manufacturer limit. Two rules per flight read the wind measured at the site the flight's plan names: the latest reading at or before the takeoff, and the latest reading while the flight is reported in the air, each against the limit the organization sets when it adopts the pack. Its indicator counts flights with an in-flight wind finding per 100 flights. The wind comes from a dock's own measurement through the `dji-cloud-api-dock-wind` adapter, or from a weather station's published report through `published-metar-observations` when the station is configured to report for the site; the result names the station, and a station's report more than 90 minutes older than the takeoff is not read. Its latest version, 2, has 2 rules a check runs, 0 a person checks and 0 not supported yet.

A pack's digest is pinned in code, so changing a published pack without a new version fails at startup, and the registry refuses any version whose content does not match its digest. The demo procedures still live in the domain package because each automated rule has its own evaluator; moving them out, with one generic evaluator, is the next planned work.

**Adapters** live in `packages/adapters`. An adapter maps a source's payloads into Ledger inputs and submits them through the public API with the original bytes. Included:

- Airspace Link AirHub: operations, the LAANC authorization lifecycle and B4UFLY briefings, written from the published OpenAPI schemas. It has had no sandbox or live validation.
- DJI Cloud API telemetry over MQTT.
- Published aviation weather reports (METAR and SPECI) from the Aviation Weather Center data API (`published-metar-observations`): the wind and the prevailing visibility read from each report's text, about every site the organization configures the station to report for, each observation naming the station and its distance from the site. Built against reports fetched from the live service; its emulator serves recorded reports in the service's shape.
- Published terminal aerodrome forecasts (TAF) from the same service (`published-taf-forecasts`): each forecast as its own `weather.forecast` record of what was forecast and when, period by period with the wind and visibility it states and its change groups as given, never as a wind or visibility reading. Built against forecasts fetched from the live service; its emulator serves recorded ones.
- Published temporary flight restrictions from the FAA's public list and detail documents (`published-flight-restrictions`): each restriction area whose published boundary touches a circle the organization configures around one of its sites, with its notice id, times, daily schedule, floor and ceiling and its boundary as published (`airspace.restriction`). Built against documents fetched from the live service; its emulator serves recorded ones. NOTAMs other than flight restrictions are not read: the FAA's NOTAM service needs an account, and its response format is not published without one.
- A generic order feed.
- A crew roster export file (an invented JSON format), read into duty and rest periods. Its stand-in is the sample file `packages/contracts/fixtures/crew-roster/alpha-crew-roster.json`: a fortnight for three fictional crew members of Alpha Dispatch, one of whom works a duty period of 12.5 hours and one of whom starts duty after 8 hours of rest. The flights they are assigned to are the operator record file `packages/contracts/fixtures/operator-records/alpha-crew-assignments.csv`, imported as `operation.role-assignment` records.

`apps/emulators` provides local stand-ins that speak those interfaces, so adapters can be developed without credentials.

`apps/adapter-host` runs one adapter for one source outside the simulator (`pnpm adapter:run`): it receives the source's messages, translates them and submits them through the public API with a credential an administrator issued. Every shipped adapter but the weather report, forecast and flight restriction adapters was built from the source's documentation and run against the emulators only; none of them has read a message from a real aircraft, dock or airspace service. Those three were built against answers fetched once from the live public services; none has run against its service for long.

## Status and limits

- Pre-release. Interfaces, schemas and export formats can change, and a release may need the database recreated; its note in [CHANGELOG.md](CHANGELOG.md) says so. [docs/upgrading.md](docs/upgrading.md) states what will stay stable once Ledger leaves pre-release.
- Not certified or approved by any regulator. Ledger records what an organization did; the regulator decides what it means.
- Not a safety management system by itself, and not a route to conformity with 14 CFR Part 5. It is built to be used as infrastructure for one; the policy, the people and the practice are the organization's.
- The Part 108 material tracks a notice of proposed rulemaking. It will change when a final rule is published.
- Retention: Ledger keeps every record, correction and original file and removes none; it computes no retention period. It lists the periods the adopted rule texts state, in their own words, and drafts a recordkeeping plan from them. Keeping the deployment, its stored files and their backups for as long as those texts ask is the operator's.
- Local sign-in uses seeded development people or a development token. Outside local development people sign in through an OpenID Connect provider the deployment configures, self-hosted or not. See [Deploy Ledger](docs/guides/deploy.md#6-sign-in).
- The simulated operation and emulators exist to exercise the system. They are not flight software and control no aircraft.
- No shipped adapter has been run against real equipment, and only the weather report, forecast and flight restriction adapters have read a live service's bytes, each from one fetch. Check each against your own before you rely on what it reports; the deployment guide lists what to compare and what was checked.
- The aircraft adapter reads the height the aircraft's documentation describes, above the WGS84 ellipsoid, which is never compared with a limit above ground: a height rule rests on the height the operator's flight record states, or else the planned height, and says which, until a source reports height above ground or above the takeoff point.
- The Part 108 pack checks what a record or a document on file can show. [docs/design/part-108-coverage.md](docs/design/part-108-coverage.md) lists every paragraph of Subparts A, B, C and E with the rule that reads it or why none does. Which Ledger record holds each record the proposed § 108.40 lists is our reading, set out in [docs/design/required-records.md](docs/design/required-records.md); read it against your own operation before you rely on a recordkeeping plan drafted from it.
- Submitted safety reports: [docs/design/report-submission.md](docs/design/report-submission.md) states what each way of reporting keeps and who can read it, and what Ledger cannot make true, such as the access log of a proxy in front of it. Those are the deploying organization's to configure.
- The deployment guide marks each step that was not run. On one computer, with local names and a local certificate authority, the production Compose file was run with PostgreSQL, an S3-compatible store, Keycloak and a TLS proxy; people signed in through Keycloak and signed a document in the browser; and a backup was restored into empty containers and checked. `infra/verify-deployment` repeats it. Not run: a public server with certificates the proxy obtains itself, Google Workspace or Microsoft Entra ID as the identity provider, and Ledger Lite's backup with `--files` and its sign-in through an identity provider. `infra/compose.lite.yaml` was brought up from the published v0.2.0 image on one computer with `node infra/verify-deployment/check-lite.mjs`, and `infra/compose.try.yaml` from the same image; the image's linux/amd64 half was built and never started.

## Open work

Known gaps:

- **Real equipment.** No shipped adapter has read a message from a real aircraft, dock or airspace service. Until one has, an operation's flown values come from its own records.
- **Parts of the proposed Part 108 no record type holds yet.** Population density categories, strategic deconfliction and conformance monitoring, operations over people, package delivery, hazardous materials and agricultural operations have no record type and so no rule. The coverage note lists each paragraph.
- **The final rule.** The Part 108 pack quotes the notice of proposed rulemaking. When a final rule is published it needs a new pack version quoting the final text. `pnpm pack:compare ledger.part108-nprm <the final text>` reports what each quoted paragraph did in it; reading each rule against the new words is still a person's work.
- **Flights dated before an adoption starts.** A flight on file before an adoption is made, and dated before its first day, is not checked; the same flight imported afterwards, or still on file when a newer version replaces the adoption, is. Until that is made one rule, adopt from a day on or before your earliest record, which checks every flight either way. [docs/design/rule-coverage.md](docs/design/rule-coverage.md) has the detail.
- **Records an old log never held.** A rule about a record your log did not keep, such as when a notice was requested or the gust at takeoff, finds it missing on every flight, and a notice cannot be recorded without the time it was made. A person closes those findings by rule and dates; nothing fills them in.
- **Other flight log formats.** `records read-log` reads PX4 ULog, ArduPilot DataFlash and MAVLink telemetry logs, checked against a few public sample logs only, and GUTMA flight logs (JSON), built from the Global UTM Association's published description and checked against logs its tests built, not yet against any product's real export: test it against your own before you rely on it, and someone with one can say whether it reads. A manufacturer's own flight log in another format and a log service's export have no reader yet (an export can be read through a column mapping); each needs someone with a real file. A log larger than 10 MB cannot yet be kept as the original, so it cannot be imported this way.
- **One finding from the command line.** The client reads one finding (`findings show`), but takes and closes findings only by rule, subject kind and dates. Taking or closing a single finding is done in the browser.
- **Safety files over MCP.** The MCP server prepares a person's safety decisions, but has no tool for the safety record templates, checks and drafts; an agent runs `pnpm ledger safety` for those.
- **Visibility under § 107.51(c).** The Part 107 rule reads the visibility a preflight assessment states and not the visibility at takeoff on the flight record.
- **Replacing a version from its first day in the browser.** The command line and the API do it; the Rules screen's form replaces from a later day only.
- **An adoption sent right after another.** While the rules of one adoption are still being queued, a second adoption can be refused as a concurrent change. The command-line client waits and sends it again; the cause on the server is not yet found.
- **Operating areas as polygons.** An operating area is a circle or a corridor.
- **Attachments on a submitted safety report.** A person who submits a report cannot send a file or a photo with it.
- **One command without Docker.** Ledger Lite still needs Docker or a PostgreSQL server. Whether an embedded PostgreSQL could start Ledger for one operator with one command is looked into, not settled, in [docs/design/embedded-database.md](docs/design/embedded-database.md).
- **Rules over forecasts and flight restrictions.** Forecasts and restrictions are recorded, but no shipped rule reads them: no check kind compares a forecast period's wind or visibility with a limit, or asks whether a restriction's interval overlaps a flight's window. A restriction is matched to a circle the adapter's configuration names, not to the operating areas recorded in Ledger.
- **NOTAMs.** The FAA's NOTAM service needs an account, and its response format is not published without one, so no adapter reads NOTAMs other than temporary flight restrictions.
- **Extra fields on a built-in record type.** A pack declares whole record types of its own; it cannot yet add a field to one of Ledger's, such as `aircraft.inspection`. Declare a type of your own about the same aircraft instead. [Record types a pack declares](docs/design/declared-record-types.md) says why.
- **Packs kept per organization.** Pack files, and the record types they declare, are read from one folder for the whole deployment, and the catalogue shows each to every organization on it. An organization has a declared type, and can record one, only once it adopts the pack.
- **Notices on a record's history.** A sent notice is listed on the administrator's list of notices, not yet on the history of the record it is about.
- **Crewed operations.** Ledger's built-in record types, roles and some check kinds are written for unmanned operations. What an operation under Part 91 or Part 135 would need, which of it a pack can declare, and the core changes left (a related subject on a declared type, a unit of mass, crewed positions, crew time over calendar periods) are listed in [docs/design/crewed-operations.md](docs/design/crewed-operations.md); none is built.
- **Entering records offline, beyond the form.** An entry kept on a phone needs the person to have signed in, and opened **Records**, while there was a connection, and a reload signs them out until there is one again. Without a connection the form cannot suggest subjects on file, an import or any other form cannot be used, and nothing can be attached. The app's icon is the one SVG mark; a phone that wants a bitmap icon on its home screen shows its own.
- **Occurrences by kind.** The report of a month's occurrences groups them by record type only. No record type marks which of its fields is the occurrence's kind, such as the kind of interruption, so each occurrence lists it among its fields instead. [docs/design/reports.md](docs/design/reports.md) says what a marking would take.
- **A finding closed and opened again, in the reports.** A report counts each finding by its current state: one closed in a period and opened again later counts as open, and its earlier closing is only in its own history.
- **An indicator's limit.** A limit is drawn only where an indicator's definition sets one; no shipped indicator does yet, since setting one is a new version of the definition.
- **Flights an order source reports, in the summary.** A summary counts flights from their flight records; a flight known only from an order source's reports is not counted until its flight record is on file.
- **Aircraft-estimated wind.** The aircraft adapter does not map the aircraft's own wind estimate, because its unit is not documented.
- **Many operators followed.** A program owner's Ledger reads each operator it follows hourly, one call at a time per worker pass; the period is not a setting yet. A host name that resolves to an internal address is not refused by Ledger: the deployment's network rules keep its workers from calling one.
- **One request limit across API processes.** The limit per credential is held by each API process, so two processes allow twice as much; requests without a credential are still the proxy's to limit.

## Work with Lightcone Systems

Ledger is open source so that a team can take it and make it its own. Lightcone Systems, the company that builds it, also hosts Ledger and builds custom versions of it with operators: adapters for the systems you fly with, rule packs for your procedures and waivers, and the screens your people need. See [lightconesystems.com/ledger/open-source](https://lightconesystems.com/ledger/open-source/#work-with-us) or write to team@lightconesystems.com.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). Contributions are licensed under Apache-2.0, like the rest of Ledger.

## Licence

Copyright 2026 Lightcone Systems, Inc.

Ledger is licensed under the Apache License, Version 2.0 (`Apache-2.0`). You may use it, change it and build on it, including in a commercial product, under the terms of that licence. It is distributed without warranties or conditions of any kind. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

A contribution you submit is licensed under the same terms, as section 5 of the licence says. You keep your copyright.
