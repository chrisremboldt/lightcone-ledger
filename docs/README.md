# Ledger documentation

Start with the [README](../README.md) for what Ledger is and how to run it. This folder holds the guides for setting Ledger up, deploying it and extending it, and the design notes that record how it was built.

## Guides

Worked examples you can follow in your own checkout. Each ends with how to check your work.

- [Set up Ledger for your organization](guides/set-up-your-organization.md): one organization from nothing to seeing where its own operation stands: people, records, the regulations it works under, its own waiver and procedures, coverage, findings, records on request, the recordkeeping plan and safety records. It says for each step where the work is done and who can do it.
- [Write a rule pack](guides/write-a-rule-pack.md): rules that quote their source text, read observations and run a library check kind; registering, adopting in shadow and active, and where findings show.
- [Write an adapter](guides/write-an-adapter.md): turning a source's bytes into observations, keeping the original bytes, receipts and idempotency keys, golden files and the emulators.
- [Write a control type](guides/write-a-control-type.md): parameters, wording, `rules()`, `area()` and the applicability rule; what the type's digest covers; how an accepted control shows on a flight.
- [Write an indicator](guides/write-an-indicator.md): counting findings, issues or observations against an exposure kind, when a rate may be stated, and how results are recorded and reviewed.
- [Deploy Ledger](guides/deploy.md): the container image, PostgreSQL and its database roles, object storage or files on disk, Ledger Lite, environment variables, migrations, creating your organization with `pnpm org:create`, sign-in, backups, health checks, and what is not hardened.
- [Set up Ledger with a coding agent](guides/set-up-with-a-coding-agent.md): written to an operator's coding agent: `pnpm ledger`, a command-line client over the public API, from the organization's spreadsheets and waiver to coverage, with what stays with a person and where the organization's own files are kept. `examples/first-operator` runs it for an invented operator.
- [Bring your safety records](guides/bring-your-safety-records.md): for an organization that already keeps a safety program: its risk matrix, policy, hazard register, audits, reviews and reports brought in from files under its own references with `pnpm ledger safety`, and what stays a person's decision.
- [Verify an export](guides/verify-an-export.md): producing a finding packet and checking it offline with `tools/verifier`, which needs only Node.

## Design notes

The engineering record, in [design/](design/). The guides agree with these; where a guide is shorter, the note is the authority.

- [observation-vocabulary.md](design/observation-vocabulary.md): the observation envelope, the version 1 types and their units, what a rule may and may not infer from each, the registry and how types evolve; and how a read selects records by recorded time, by the time they are about, and as plans.
- [observation-corrections.md](design/observation-corrections.md): an accepted observation is never edited; a replacement, a withdrawal or a subject resolution is a new record, and every read decides what is current at its evidence cut.
- [operator-records.md](design/operator-records.md): the operator record types (training, duty, maintenance and others) carried in `operator.record`, defined by field metadata that generates their schema.
- [operator-record-import.md](design/operator-record-import.md): importing operator records from CSV or JSON and entering them by hand, all generated from a record type's fields, with units named in the column header.
- [record-check-kinds.md](design/record-check-kinds.md): the check kinds record-keeping rules use, their inputs and parameters, and when to narrow a read instead of selecting inside a check.
- [fan-out-and-related-reads.md](design/fan-out-and-related-reads.md): a rule may read records about a related subject, such as the people a flight's assignments name, and give one result per related subject.
- [finding-packets.md](design/finding-packets.md): the finding packet carries the original source bytes, within a bound, and is the one packet format Ledger issues; the older decision packet is retired but still verifies.
- [one-hazard-model.md](design/one-hazard-model.md): the safety-program hazard, with its adopted matrix and signatures, is the only hazard model.
- [controls-as-rules.md](design/controls-as-rules.md): accepted controls a rule can check become the organization's own pack, adopted by the signed acceptance itself; which controls are in force; and how a briefing and a departure pin the controls a person saw.
- [control-applicability.md](design/control-applicability.md): a control type may declare a pinned applicability rule; route review records, for every overlapping area control, whether it applies to the flight's route and why, and fails towards applying.
- [rule-coverage.md](design/rule-coverage.md): who a rule covers, how a missing record is reported instead of passed over, and coverage grouped by a pack's sections.
- [pack-files.md](design/pack-files.md): an organization's own waiver or procedure as a pack file built from its text and a description, with no code.
- [waiver-relief.md](design/waiver-relief.md): a waiver's provision relieves a named rule of another pack, and a waiver's conditions cover only the flights flown under it.
- [observed-values.md](design/observed-values.md): what a rule about height, speed, place or time rests on: a source's report, the operator's own flight record, or the plan, and how it says which.
- [on-file-checks.md](design/on-file-checks.md): rules that ask whether a controlled document, a risk matrix or a designation is on file and in force, and name it; never whether it is adequate.
- [part-108-coverage.md](design/part-108-coverage.md): every paragraph of Subparts A, B, C and E of the proposed Part 108, with the rule that reads it or why none does.
- [required-records.md](design/required-records.md): the records a pack's text requires, with the retention the text states, what holds each in Ledger, and the recordkeeping plan drafted from them.
- [record-productions.md](design/record-productions.md): records read by subject, a file for each pilot, aircraft and flight, and records produced on request as one file that verifies offline.
- [finding-work.md](design/finding-work.md): a finding about any subject taken, assigned, worked and closed by a person; when a record closes one by itself; the list of open findings.
- [assurance-records.md](design/assurance-records.md): audits, evaluations, investigations, reviews, change assessments and hazard notices as safety records, with actions that are owned and closed.
- [report-submission.md](design/report-submission.md): how a person submits a safety report, signed in or through a reporting link, exactly what each way keeps and who can read it, and what the deploying organization must configure.
- [decision-basis.md](design/decision-basis.md): what a person's decision pins as its basis, and what is left out so an unrelated evaluation does not refuse it.
- [lock-order.md](design/lock-order.md): the one order in which every transaction takes its locks, and the rule a new command, projection, worker job or trigger follows.
- [ledger-lite.md](design/ledger-lite.md): Ledger on plain PostgreSQL without PostGIS, original files on disk as a deployment's choice and what protects them, and the API and the workers in one process with their own roles and leases.
- [embedded-database.md](design/embedded-database.md): what Ledger asks of its database, and whether an embedded PostgreSQL could start it for one operator without Docker; looked into, not settled.

## Elsewhere

- [AGENTS.md](../AGENTS.md): the working rules for anyone taking an issue, and the definition of done.
- [CONTRIBUTING.md](../CONTRIBUTING.md): how to contribute.
- [packages/adapters/README.md](../packages/adapters/README.md): the adapter contract and conformance kit in full.
- [apps/emulators/README.md](../apps/emulators/README.md): the local stand-ins for outside systems.
- [tools/verifier/README.md](../tools/verifier/README.md): every offline verifier and what it checks.
- [openapi.json](openapi.json): the public API; each route says what it records or returns and the capability it needs.
