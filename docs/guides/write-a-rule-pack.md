# Write a rule pack

A rule pack is how you teach Ledger a set of rules. There are two ways to write one:

- **Your own waiver or procedure: a pack file.** You keep the text as it was issued, list its provisions and the words each one says, and one command builds a pack file. Ledger loads it at startup. You write no TypeScript and rebuild nothing. Part 1 of this guide.
- **A pack that ships with Ledger: a TypeScript package.** The packs under `packages/pack-*` are written this way, with tests, and every deployment has them. Part 2.

Both end the same way: a person adopts the pack, in shadow and then in active mode (Part 3).

If you are setting Ledger up for your own organization, start with [Set up Ledger for your organization](set-up-your-organization.md): its step 6 is the short form of Part 1, with a table of which check answers which question. This guide is the reference behind it.

## Terms

- **Rule** (in code, a *leaf*): one requirement, the text it quotes, the records it reads and the check that runs on them.
- **Rule pack**: an immutable, versioned set of rules. Each version has a digest: the SHA-256 of its canonical JSON.
- **Observation**: one fact Ledger accepted from a source, such as a battery reading or a wind measurement. Rules read observations, never a source's own field names. See [observation-vocabulary.md](../design/observation-vocabulary.md).
- **Check kind**: a reusable, versioned piece of deterministic code that answers one question, such as "is this value within a limit". A rule names a check kind and gives it parameters. Rules contain no code of their own.
- **Adoption**: a person's decision that an organization uses an exact pack version over a date range, in a mode. A pack does nothing until it is adopted.

# Part 1. Your own waiver or procedure, as a pack file

The worked example is an invented waiver in `packages/standard-packs/examples/invented-waiver`: `source.txt` holds its text and `pack.yaml` describes its five provisions. `packages/standard-packs/tests/pack-files.integration.test.ts` builds it with the command below, loads it, adopts it and checks that each evaluation quotes its provision, and `pnpm test:integration` runs that test. If the test and this guide ever disagree, the test is right. [pack-files.md](../design/pack-files.md) describes the file format and every check the loader makes.

Run the commands from the repository after `pnpm build`. A relative folder is read from where you typed the command.

## 1. Start a folder

```sh
pnpm pack:new my-waiver --kind waiver        # or --kind procedure
```

It writes two files. `source.txt` holds an invented placeholder. `pack.yaml` describes the pack; its comments list what this Ledger has to check with: for a waiver, every obligation type and its parameters; for a procedure, every check kind, observation type and operator record type. Both templates build as they are, so you can try the next steps before changing anything.

The procedure template is a small invented operations manual with six rules, one of each common shape: a date in a pilot's training record within 12 calendar months, an aircraft inspection that has not passed its next due time or its next due hours in service, a flight's planned height within a limit set on adoption, the wind at takeoff and the battery at landing within a limit, read from what a source reported or else from the operator's own flight record, and a crew briefing a person confirms. Every one reads records imported on the Records screen. `packages/standard-packs/tests/procedure-template.integration.test.ts` adopts it as built, imports records for three pilots, two aircraft and two flights, and checks each count the coverage view shows.

## 2. Keep the text as issued

Replace `source.txt` with the exact text of your waiver or procedure, saved as UTF-8. Do not tidy it: each rule quotes it word for word, and the pack file keeps the whole text with its SHA-256.

## 3. Describe the pack

`pack.yaml` names the pack and the source:

```yaml
pack:
  id: alpha-dispatch.waiver-exw-0042
  version: 1
  title: Waiver EXW-0042 for Alpha Dispatch (invented)

source:
  file: source.txt
  kind: waiver
  reference: Certificate of Waiver EXW-0042 (invented)
```

Give the pack id your own prefix, in lowercase words joined by dots or hyphens. `ledger.` is kept for packs that ship with Ledger. `kind` is `waiver` for a waiver or exemption you hold and `procedure` for your own procedure; only a waiver's provision may relieve a rule of another pack.

### What the waiver states, and which flights its conditions cover

A waiver description has a `waiver` section. It has no default: the builder refuses a waiver without one.

```yaml
waiver:
  certificateNumber: EXW-0042
  effective:
    from: 2026-10-01
    through: 2028-09-30
  conditionsCover: every flight
```

- **`certificateNumber`** is the number exactly as your flight plans write it under operating authority reference.
- **`effective`** is the first and last day the certificate states, written year-month-day. The adopt form starts an adoption from them, and the Rules screen says, for an adopted waiver, "The certificate states it is effective through …" with the days remaining, or that the date has passed. Ledger shows what the certificate states; it does not decide whether the waiver is in effect.
- **`conditionsCover`** is one of two phrases:
  - `flights whose plan cites the certificate`: for a waiver you fly under on some flights only, such as one for flights beyond visual line of sight. A flight whose latest plan cites `certificateNumber` under operating authority reference is checked against every condition. For any other flight, each condition about the flight records **does not apply**, with the sentence "The latest flight plan does not cite EXW-0042 as its operating authority, so the waiver’s conditions do not cover this flight.", opens no finding and is counted under **Does not apply**. A flight with no plan on file is reported as "No flight plan on file", not passed over. For example, an ordinary flight within visual line of sight, planned at 300 feet without citing the certificate, gets "does not apply" under a 200-foot limit, and its pilot and aircraft are not checked against the waiver's lists.
  - `every flight`: for a waiver whose conditions hold for every flight you make, whatever its plan cites. The same ordinary flight is checked against the 200-foot limit and needs attention.

Either way, a condition about people covers the people a covered flight assigns in the role it names (a course for the remote pilot in command is asked of each flight's remote pilots in command, and nobody else), a condition about aircraft covers the aircraft a covered flight's plan names, and a condition about the organization, such as a procedure on file, is evaluated once, for the organization. `pnpm pack:build` prints the waiver's stated dates and what its conditions cover, and for each rule who it covers.

`examples/first-operator/` is a waiver whose conditions cover only the flights citing it, with invented records to import; `packages/standard-packs/examples/invented-waiver/` covers every flight.

**A provision that grants relief.** When a provision lets you do what a rule of another pack otherwise asks you not to, say which rule under `relieves`:

```yaml
  - number: 1
    title: Beyond visual line of sight
    quote: >-
      For a flight whose flight plan cites certificate EXW-0042 as its operating authority, the remote pilot in
      command need not keep the aircraft within visual line of sight.
    obligation: authority.flight-cites-certificate
    parameters:
      certificateNumber: EXW-0042
      effectiveFrom: 2026-06-01
      effectiveThrough: 2028-05-31
    relieves:
      - packId: ledger.part107
        ruleIds: [ledger.part107.107.31.a]
```

`pnpm pack:list` prints the packs built into Ledger, and `pnpm pack:list ledger.part107` prints that pack's rules with their ids. While your organization has the waiver adopted in active mode, the relieved rule's result for a subject is recorded as relieved, naming the provision, instead of opening a finding. [Relief](#8-relief-a-waiver-or-exemption-that-covers-another-packs-rule) below says exactly what is recorded.

### Provisions

For a waiver, list its provisions. Each one quotes the provision and names the obligation it carries, with that obligation's parameters:

```yaml
provisions:
  - number: 1
    title: Listed aircraft
    quote: Only the aircraft registered as FICT-0301 may be operated under this waiver.
    obligation: eligibility.listed-aircraft
    parameters:
      registrationNumbers: [FICT-0301]

  - number: 3
    title: Training
    quote: >-
      Each remote pilot completes the Bridge inspection operations course within the 12 calendar months before the
      operation.
    obligation: qualification.named-training-current
    parameters:
      courseTitle: Bridge inspection operations
      months: 12

  - number: 5
    title: Certificate at hand
    quote: A copy of this certificate is kept at the control station during operations.
    obligation: authority.certificate-at-hand
    waitingFor: Confirm that a copy of this certificate was at the control station throughout the operation.
```

- **`quote`** is the provision's exact words. Line breaks and runs of spaces may differ from the source (provision 3 above wraps differently from `source.txt`); every other character, capitals and punctuation included, must match. If the words appear more than once in the source, quote more of them, or add `occurrence: 2` (counting from 1) to say which.
- **`obligation`** is one of the obligation types the template lists, from `packages/pack-example-waiver/src/obligations.ts`. Each one says what it reads and asks: a listed aircraft compares the recorded registration number of the aircraft a flight's plan names with the list, a training obligation looks for the named course in the training records of each remote pilot in command a flight assigns. The builder turns the provision into that rule, with id `<pack id>.provision-<number>`. Two common provisions have their own types: `report.occurrence-within` (each occurrence of the kinds you list, recorded for a flight, reported to a named party within a whole number of hours; it reads the record's "Reported to the authority at", and leaves out an occurrence the operator recorded as not reportable, saying so and who decided) and `record.maintenance-complete` (every maintenance entry for the aircraft a flight's plan names holds the fields its record requires).
- **A parameter that is a quantity** may be written with its unit, as the provision states it: `maxFeetAboveGround: 400 ft` or `122 m`, `maxMetersPerSecond: 22 kt`, `minStatuteMiles: 3 sm`, `leadHours: 24 h`, `minPercent: 25 %`. The builder keeps it in the parameter's own unit (the one its name says), converted by the same factors as an import, and the build's printout shows what you wrote beside what it is kept as (`maxFeetAboveGround written as 122 m, kept as 400.262467 ft`). A number written alone keeps its meaning, in the parameter's own unit. A unit of another quantity is refused. The template lists, under each such parameter, the units it takes.
- Every provision becomes a rule in the pack, whether or not a check can run it. Some obligations no record can show, such as a certificate kept at the control station: the provision becomes a rule **checked by a person**, carried with its quoted words and `waitingFor`, the sentence saying what that person confirms (left out, the obligation type's own sentence is used). An obligation Ledger cannot check yet becomes a rule **not supported yet**, with the reason. Either kind is listed in every adoption of the pack and counted in the coverage read; neither is evaluated or opens a finding.
- A provision no obligation type fits can give `coverage: manual` (or `unsupported`) and `waitingFor` in place of `obligation`.
- **A procedure may carry provisions too**, written exactly as a waiver's: a paragraph of your own manual that one of the obligation types fits, such as a dock inspected within 30 days before each flight, goes under `provisions` with its `number`, `title`, `quote`, `obligation` and `parameters`, beside the procedure's `rules`. Its rule id is `<pack id>.provision-<number>`. An obligation written under `rules` is refused: "Rule dock-inspection names obligation maintenance.dock-inspected-within-days, but a rule under rules is written by check kind. An obligation goes in a provision under provisions, in a procedure exactly as in a waiver: number, title, quote, obligation and its parameters." The waiver template (`pnpm pack:new <folder> --kind waiver`) lists every obligation type and its parameters.
- A provision that asks for two things carries two obligations: give it two entries, each quoting the words of its part, with numbers that keep them apart (`6` and `6b`). Each becomes its own rule.
- An obligation about a flight reads the records as of that flight, never as of today: the record in effect at its takeoff, the count in the days before it, the flights that overlap it ([record-check-kinds.md](../design/record-check-kinds.md), "Evaluated as of each flight").

### Sections

The Rules screen, `pnpm ledger coverage` and `pnpm pack:list` list a pack's rules under its sections, each rule beside the paragraph it reads. A waiver with no sections is listed in provision number order (provision 2 before provision 10), under one heading. To group a long waiver or a manual by its own headings, list the sections and give each provision or rule one:

```yaml
sections:
  - id: aircraft
    title: Aircraft and equipment
  - id: people
    title: People and training

provisions:
  - number: 1
    section: aircraft
    title: Listed aircraft
    ...
```

Once a description lists sections, every provision and rule names one of them, and the build says which does not. A provision's paragraph is `Provision <number>`; a rule by check kind may give its own, as `paragraph: 4.2`.

### Rules by check kind

A provision that no obligation type fits, and any procedure, is written as a rule by check kind. The invented waiver's provision 4 leaves the ground speed limit to the holder, so the holder sets it when it adopts the pack:

```yaml
rules:
  - id: provision-4
    title: Planned ground speed within the holder's limit
    reference: 'Certificate of Waiver EXW-0042 (invented), provision 4: Ground speed'
    quote: The planned ground speed of the aircraft does not exceed the limit the holder sets
    target:
      subjectKind: flight
    population:
      of: in_adoption_dates
    reads:
      - name: quantity
        type: operator.record
        versions: [1]
        about: target
        required: true
        onFile: flight plan
        plans: true
        select: latest
        where:
          - field: values.recordType
            oneOf: [flight.plan]
          - field: values.recordVersion
            oneOf: [1]
    check:
      kind: value.within-limit
      version: 2
      params:
        field: values.record.plannedMaxGroundSpeedMetersPerSecond
        comparison: at_most
    adoptionParameters:
      - name: limit
        title: Ground speed limit (metres per second)
        valueType: number
        minimum: 1
        maximum: 50
```

The fields are those of a rule in Part 2, written as data: `target`, `population`, `reads`, `check` with the kind's id, version and parameters, and `adoptionParameters`. The builder prefixes the pack id to `id`. Leave out `reference` to cite the source's reference and the rule's title.

**What a check kind takes.** `pnpm pack:kinds` prints every check kind this Ledger has, and `pnpm pack:kinds duty.within-limits` one of them, from its registered definition: what it asks, its inputs (name each read of the rule after the input it fills: `value.within-limit` reads `quantity`, `value.one-of` reads `subject`, `duty.within-limits` reads `periods` and, optionally, `window`), and every parameter with whether it is required, which go together, and its unit:

```text
duty.within-limits version 1: Duty and rest within limits
  What it asks: Arithmetic over recorded duty and rest periods of one person. ...
  Inputs (name each read of the rule after the input it fills):
    periods (required): Recorded duty and rest periods of the person, read in full.
    window (optional): An observation or operator record stating the window being staffed.
  Parameters (under check params; a rule may leave one to adoptionParameters, set when the pack is adopted):
    dutySelect (required): a selection of the records that count: ...
    restSelect (required): a selection of the records that count: ...
    ...
    maxDutyHours (optional): a duration in hours, or written with its unit, such as 12 h
    ...
  Give at least one of maxDutyHours, minRestHours, maxRollingDutyHours.
  minRestHours is given together with restWithinHours.
  maxRollingDutyHours is given together with rollingHours.
```

A check kind added to Ledger is printed the same way, with nothing to change here.

**How a rule reads each record type.** `pnpm ledger records columns <type>` ends with the read a rule writes for that record type and the path of each of its columns. Two forms exist:

- **Most record types are stored inside `operator.record`.** A read takes `type: operator.record`, `versions: [1]`, and one record type with `where: [{ field: values.recordType, oneOf: [<type>] }]`; a field is `values.record.<field name>`.
- **Duty or rest periods (`crew.duty-period`) are stored as observations of their own type**, the same as periods from a crew roster. A read takes `type: crew.duty-period`, `versions: [1]`, with no condition on `values.recordType`; the kind of period is `values.period`, the role `values.role`, the start and end `interval.start` and `interval.end`, and the period id `sourceEventId`. `pnpm ledger records columns <type>` says which form a type takes, and the procedure template lists it for every record type.

A column that names another subject (a site, a person, an aircraft) is a reference, kept as its id and scope: compare it by its id, `values.record.siteId.id`. `pnpm pack:build` checks every read and path: a read that selects `crew.duty-period` inside `operator.record` (it would find nothing) is refused with the read to write instead; a field the record type does not have, a reference compared without `.id`, or a record type this Ledger does not have is refused, with the fields the record type does have. Ledger refuses such a pack file when it loads it, too.

**Limits with their unit.** Write a limit as the source states it, with its unit: `limit: 3 sm`, `limit: 22 kt`, `limit: 400 ft`, `maxDutyHours: 10 h`. The unit names are the ones an import heading takes (`m`, `ft`, `mi` or `sm`, `nm`; `m/s`, `kn`, `kt` or `kts`, `mph`; `h`; `%`). The builder keeps the number in the unit Ledger stores (metres, metres per second, hours, percent), converted exactly as an import converts it, and keeps what you wrote beside it; never convert by hand. The quantity must match the field it is compared with: a speed limit written in miles is refused. When the check kind can state its sentence in another unit, the builder sets it to the unit you wrote, so a result reads "at least 3 mi (4828.03 m)". A number without a unit is taken as already in the stored unit.

### A rule by check kind, start to finish

The invented Example Ridge Survey operations manual has this paragraph (the file `source.txt`):

```text
4.2 Visibility. No flight is launched unless the visibility from the
control station, as recorded in the preflight assessment, is at least
3 statute miles.
```

1. **The subject.** The sentence is about each flight, so `target: { subjectKind: flight }`, and `population: { of: in_adoption_dates }` covers every flight inside the adoption's dates.
2. **The record that holds the value.** The paragraph names the preflight assessment. `pnpm ledger records columns flight.preflight-assessment` lists `visibilityMeters`, a number stored in metres. The read takes that record type, the latest one about the flight, and says what a flight without one lacks (`onFile`).
3. **The question.** "Is at least 3 statute miles" is a recorded value against a fixed limit: `value.within-limit` version 2, with `comparison: at_least`. The table below has the other common questions.
4. **The limit**, as the manual writes it: `limit: 3 sm`.

```yaml
pack:
  id: example-ridge.operations-manual
  version: 1
  title: Example Ridge Survey Operations Manual (invented)

source:
  file: source.txt
  kind: procedure
  reference: Example Ridge Survey Operations Manual, revision 3

rules:
  - id: visibility
    paragraph: '4.2'
    title: Visibility at least 3 statute miles before launch
    quote: >-
      No flight is launched unless the visibility from the control station, as recorded in the preflight
      assessment, is at least 3 statute miles.
    target:
      subjectKind: flight
    population:
      of: in_adoption_dates
    reads:
      - name: quantity
        type: operator.record
        versions: [1]
        about: target
        required: true
        onFile: preflight assessment
        select: latest
        where:
          - field: values.recordType
            oneOf: [flight.preflight-assessment]
    check:
      kind: value.within-limit
      version: 2
      params:
        field: values.record.visibilityMeters
        comparison: at_least
        limit: 3 sm
```

The read is named `quantity` because that is the input `value.within-limit` reads (`pnpm pack:kinds value.within-limit` lists it). `pnpm pack:build` prints the rule as Ledger will run it, naming every record and field by the label the Records screen shows:

```text
example-ridge.operations-manual.visibility version 1: Visibility at least 3 statute miles before launch
  Quotes source.txt line 5:
    No flight is launched unless the visibility from the
    control station, as recorded in the preflight assessment, is at least
    3 statute miles.
  Checked automatically by value.within-limit version 2 (Value within a limit) about each flight
    covers each flight with records in the adoption's dates
    reads preflight assessment records about the flight (latest, required; without one: "No preflight assessment on file")
    fields read: the preflight assessment’s Visibility from the control station (check parameter field)
    fixed parameters: field the preflight assessment’s Visibility from the control station; comparison "at_least"; limit 4828.032; unit "m"; textUnit "mi"
    limit written as 3 sm, kept as 4828.032 m
```

Once adopted, a flight whose assessment records 8000 m reads "The preflight assessment’s Visibility from the control station is 4.97 mi (8000 m); the limit is at least 3 mi (4828.03 m); the margin is 1.97 mi (3171.97 m)." and is supported by the record; one that records 3200 m needs attention; one whose assessment holds no visibility reads "No value is reported for the preflight assessment’s Visibility from the control station."; a flight with no assessment at all is reported as "No preflight assessment on file". Had the rule read `values.record.visibility`, or written `3 kt`, the build would have refused it and said why. `tests/unit/guides/rule-by-check-kind.test.ts` builds and runs this rule; if it and this guide disagree, the test is right.

**The provision says … → use …** The common cases. `pnpm pack:kinds <kind>` gives each kind's inputs and parameters.

| The provision says | Use |
| --- | --- |
| A value recorded is at most, or at least, a limit ("visibility at least 3 SM", "wind at launch not above 22 kt") | `value.within-limit` version 2, the limit with its unit |
| A height or distance flown is at most a limit, read from what was flown, else the operator's record, else the plan | `value.flown-or-planned` version 1 |
| A recorded value is one of a list ("only aircraft N-123", "only from the listed sites") | `value.one-of` version 1; a reference by its `.id` |
| A value must be recorded before something happens ("returned to service before the next flight") | `value.recorded-as` version 1 |
| Something was done within the previous N calendar months ("recurrent training every 12 months") | `date.within-months` version 2 |
| A record of this kind is held and complete | `record.complete` version 2 |
| Duty no longer than N hours, rest at least N hours before it | `duty.within-limits` version 1, hours written `12 h`: [the worked rule below](#a-rule-over-duty-and-rest-periods) |
| Notice given at least N hours before the flight | `record.made-before` version 1 |
| A report or follow-up within a time after each event | `occurrence.in-window` version 1 |
| A role is assigned throughout | `interval.covers-window` version 2 |
| A document such as a manual or a policy is in force | `record.in-force` version 1 |
| Something no record shows ("one aircraft per pilot", "brief the crew") | no check: `coverage: manual` and a `waitingFor` sentence, so a person confirms it |

A rule by check kind about each flight covers every flight. In a waiver, one line limits it to the flights whose plan cites the certificate, exactly as `conditionsCover` limits the provisions:

```yaml
    covers: flights whose plan cites the certificate
```

The builder then adds a read of the flight's latest plan (named `authority`, so do not name a read that) and the condition that it cites `certificateNumber`.

### A rule over duty and rest periods

The same manual's paragraph on duty and rest (in `source.txt`):

```text
3.2 Duty and rest. The remote pilot in command of a flight is on a
recorded duty period of no more than 12 hours, and has had at least 10
hours of continuous rest within the 24 hours before that duty period
started.
```

1. **The subject.** The paragraph is about each flight's pilot in command, so the rule is about each flight and reads, for the person each pilot in command assignment names, that person's duty and rest periods: `related` names the person from the assignment, and a read `about: { related: pilot }` takes their periods.
2. **The records.** The assignment is a role assignment, read inside `operator.record`. The duty sheet's periods are duty or rest periods, which `pnpm ledger records columns crew.duty-period` shows are their own observation type: `type: crew.duty-period`, no `where` on the record type, and the kind of period at `values.period`.
3. **The question.** `pnpm pack:kinds duty.within-limits`: the input `periods` takes the periods, the optional input `window` the assignment whose time the duty period must overlap; `dutySelect` and `restSelect` say which periods are duty and which are rest; `maxDutyHours`, and `minRestHours` with `restWithinHours`, are the limits.

```yaml
pack:
  id: example-ridge.operations-manual
  version: 1
  title: Example Ridge Survey Operations Manual (invented)

source:
  file: source.txt
  kind: procedure
  reference: Example Ridge Survey Operations Manual, revision 3

rules:
  - id: duty-and-rest
    paragraph: '3.2'
    title: Pilot in command's duty period at most 12 hours, with 10 hours of rest before it
    quote: >-
      The remote pilot in command of a flight is on a recorded duty period of no more than 12 hours, and has had at
      least 10 hours of continuous rest within the 24 hours before that duty period started.
    target:
      subjectKind: flight
    population:
      of: in_adoption_dates
    related:
      - name: pilot
        subjectKind: person
        fanOut: true
        whenNone: insufficient
        from:
          read: window
          field: values.record.personId
    reads:
      - name: window
        type: operator.record
        versions: [1]
        about: target
        required: true
        onFile: pilot in command assignment
        select: all
        where:
          - field: values.recordType
            oneOf: [operation.role-assignment]
          - field: values.record.role
            oneOf: [pilot_in_command]
      - name: periods
        type: crew.duty-period
        versions: [1]
        about:
          related: pilot
        required: true
        onFile: duty or rest period of the pilot in command
        select: all
    check:
      kind: duty.within-limits
      version: 1
      params:
        dutySelect:
          where:
            - field: values.period
              oneOf: [duty, flight_duty]
        restSelect:
          where:
            - field: values.period
              oneOf: [rest]
        maxDutyHours: 12 h
        minRestHours: 10 h
        restWithinHours: 24 h
```

The build prints it as `reads role assignment records about the flight (all, required; without one: "No pilot in command assignment on file"); duty or rest period records about each person named by its pilot in command assignment (all, required; without one: "No duty or rest period of the pilot in command on file")`. Once adopted, each flight gets one result for its pilot in command: a duty period of 13 h reads "The duty period lasts 13 h against at most 12 h; …" and needs attention; a flight whose pilot has periods on file but none overlapping the assignment reads "No recorded duty period overlaps the window." and needs attention; a pilot with no period on file at all is reported as "No duty or rest period of the pilot in command on file". Only recorded rest counts; to count the time between two recorded duty periods as rest, add `dutyRecordComplete: true` to the parameters (or under `adoptionParameters`, for the person adopting the pack to state). Had the read been written as `type: operator.record` with `oneOf: [crew.duty-period]`, it would find no period for anyone, and the build refuses it, saying the read to write.

`tests/unit/guides/write-a-rule-pack-rules.test.ts` builds every complete description in this guide with the source text before it, and runs this rule; if it and this guide disagree, the test is right.

### Who a rule covers, and what is not on file

Without more, a rule is evaluated for a subject only when a record it reads arrives about that subject, so a pilot with no training record at all is passed over in silence. Two lines make a rule report what is missing:

```yaml
    target:
      subjectKind: person
    population:
      of: on_record
    reads:
      - name: subject
        type: operator.record
        versions: [1]
        about: target
        required: true
        onFile: recurrent training record
        select: latest
        where:
          - field: values.recordType
            oneOf: [person.training]
```

- **`population`** says who the rule covers. `of: on_record` is every subject of the target kind your records name, in any record: a pilot known only from a certificate is covered by a rule about training. `of: in_adoption_dates` is the subjects with records inside the adoption's dates; use it for flights. Each member is evaluated when the pack is adopted and when it first appears in a record.
- **`onFile`** on a read names its record as a person would. The read must be `required: true`. A member without the record gets the result "No recurrent training record on file." and is counted under **No record on file**.

`pnpm pack:build` prints both for each rule (`covers every person on record`, and the sentence a missing record gives), and says so when a rule has no population. The obligation types a waiver's provisions name carry their own population. [rule-coverage.md](../design/rule-coverage.md) has the third form, `designated`, for the subjects a named record points at, such as the people assigned as pilot in command.

## 4. Build the pack file

```sh
pnpm pack:build packages/standard-packs/examples/invented-waiver
```

The command finds every quotation in the source, builds every rule exactly as a built-in pack's rule is built and checked, and computes the digests. It writes `alpha-dispatch.waiver-exw-0042-v1.pack.json` beside `pack.yaml` (or into `--out <folder>`) and prints each rule, so you can check it says what you meant:

```text
alpha-dispatch.waiver-exw-0042.provision-1 version 1: Registration recorded for the planned aircraft is a listed one
  Quotes source.txt line 11:
    Only the aircraft registered as FICT-0301 may be operated
    under this waiver.
  Checked automatically by value.one-of version 1 (Recorded value is one of the expected values) about each flight
    covers each flight with records in the adoption's dates, and the aircraft named by its flight plan
    reads flight plan records about the flight (latest, required; without one: "No flight plan on file"); aircraft identity and registration records about the aircraft named by its flight plan (latest, required; without one: "No aircraft identity record on file")
    fields read: the aircraft identity and registration’s Registration number (check parameter field)
    fixed parameters: field the aircraft identity and registration’s Registration number; expected ["FICT-0301"]

alpha-dispatch.waiver-exw-0042.provision-5 version 1: Certificate available at the control station
  Quotes source.txt line 23:
    A copy of this certificate is kept at the control
    station during operations.
  Checked by a person: Confirm that a copy of this certificate was at the control station throughout the operation.
```

The printout names every record and field by the label the Records screen shows, never by a type id or a field path; the pack file holds the paths. Its first lines count the rules by how they are covered, `5 rules (4 checked automatically, 1 checked by a person)`, then give the certificate number, the dates it states and what its conditions cover. In a waiver whose conditions cover the flights citing it, each rule about a flight prints `covers each flight whose latest plan cites EXW-0417; for any other flight it does not apply, and a flight with no plan on file is reported as "No flight plan on file"`, and a procedure on file prints `covers the organization, once`.

It refuses, naming the provision or rule and what it expected, when:

| Refusal | What to do |
| --- | --- |
| The quotation is not in the source | The message says how many of its first words match and what the source reads after them. Copy the words exactly. |
| The quotation appears more than once | The message lists the lines. Quote more, or add `occurrence`. |
| An obligation or check kind this Ledger does not have | Use one the template lists. A pack file never carries code. |
| A parameter the obligation or check kind refuses | The message names the parameter and what it must be. |
| A field a rule does not have | Check its spelling against Part 2. |
| A field path a record type does not have, or a reference compared without `.id` | The message lists the record type's fields; reference fields say to read `.id`. `pnpm ledger records columns <type>` lists them too. |
| A read that selects by `values.recordType` a record type stored as its own observation type, such as `crew.duty-period` | Write the read the message gives: that observation type, no condition on the record type, and the paths it lists. |
| An obligation written under `rules` | Move it to a provision under `provisions`, which a procedure may carry as a waiver does. |
| A parameter a check kind requires and the rule does not give | `pnpm pack:kinds <kind>` lists its parameters, which are required and which go together. |
| A limit whose unit is of another quantity than the field it is compared with, or a unit Ledger does not know | Write it in one of the units the message names. |
| A provision with neither an obligation nor `coverage`, or a rule no check runs without `waitingFor` | Name the obligation, or say who checks it and what they confirm. |
| A waiver without a `waiver` section, or with `conditionsCover` other than the two phrases | Add the section; write `flights whose plan cites the certificate` or `every flight`. |
| A rule that `defineCheckedRule` refuses | The message is the one a built-in pack's author sees, for example a read the check needs that the rule does not make. |

## 5. Load it

Copy the pack file into the folder `LEDGER_PACKS_DIR` names, and restart the API and the workers. Give both processes the same absolute path: each reads the folder only at startup, and both must hold the same packs. `pnpm pack:check <file>` verifies a file the way startup will and prints its rules.

At startup a file is refused, and Ledger does not start, when its rules no longer make the digest it states (it was edited after it was built; build it again instead), when its source text changed, when it names a check kind this Ledger does not have, when a rule reads a field path its record type does not have or a limit no longer matches the unit it was written with, or when another file or a built-in pack has the same pack id and version with different content. The message names the file and the reason. The same file twice is not an error.

The pack is then offered for adoption under **Rules**. The catalogue read (`GET /v1/rule-packs`) gives each pack an `origin`, `built_in` or `organization_file` with the file's name, and the coverage read (`GET /v1/organization/coverage`) does the same for each adopted pack version in `packOrigins`.

## 6. Change it

A pack version never changes once adopted: an adoption pins its digest. To change a provision, raise `version` in `pack.yaml`, build again and add the new file beside the old one, and restart.

**Rule versions.** Build the new version with `--out` into the folder that holds the earlier file (or into the description's own folder, when the earlier file is there). The build reads the latest earlier version of the pack it finds there and numbers each rule from it: a rule whose definition changed (what it quotes, reads, checks or asks for) gets the next rule version, an unchanged rule keeps its version, and a new rule starts at 1. The printout says so under its first lines:

```text
  Rule versions follow version 1 (organization/packs/example-ridge.operations-manual-v1.pack.json): 1 changed, 0 added, 0 no longer in this version, 5 unchanged and keeping their versions
    changed: example-ridge.operations-manual.duty-and-rest version 1 becomes version 2
```

A result recorded under either version then names the rule version it ran. When no earlier file is beside it, every rule takes the version the description writes (`version` on a rule, `ruleVersion` on a provision, 1 when left out): keep the earlier file where you build, or write the versions yourself. Then adopt the new version in place of the old: on **Rules**, **Adopt version N** on the adoption; from the command line, the same `pnpm ledger packs adopt <pack>` as before. When an earlier version is adopted over the dates, the client prints that the new version replaces it, which adoption that is, and exactly when the earlier one ends and the new one starts in your organization's time zone: from `--from`, or from now. With `--from` at or before the earlier adoption's first day, the new version replaces it for its whole period: the earlier one is in effect at no time and stays on the record as replaced, the new one covers every day it covered (so an `--until` given with it is at or after the earlier end), and every subject the earlier one covered is evaluated again under the new version. Results recorded under the earlier version keep it. A finding the earlier version opened stays open: where the new version keeps the rule, its result becomes the finding's latest, and when that result is supported by the record the finding shows as cleared, for its owner to close. Keep the old file until no adoption needs it.

To change only the mode, the dates or the values of an adoption, run `pnpm ledger packs adopt <pack>` for the version already adopted with the new `--mode`, `--from`, `--until` or `--set`: the client prints a revision that keeps everything else, and replaces the adoption with it. A version that replaced an earlier one keeps its start, where the earlier one ends. Both are sent only with `--reason` and a person's credential, like any adoption.

# Part 2. A pack that ships with Ledger, in TypeScript

This part walks through a small pack with one rule: the latest wind reported at an aircraft must stay at or below a limit the organization sets. You will define the rule, pin its source text, assemble and register the pack.

The example is real code. It lives in `tests/unit/guides/rule-pack-example.test.ts`, and `pnpm verify` runs it. If that test and this guide ever disagree, the test is right.

## Which pack to copy

The shipped packs are the best reference. Start from the smallest one that looks like yours:

| Pack | Package | Copy it when |
| --- | --- | --- |
| `ledger.example-operations` | `packages/pack-example-operations` | Your rule is an operator procedure written inline, one check kind, one adoption parameter. Version 1 is 60 lines. |
| `ledger.example-airspace` | `packages/pack-example-airspace` | Your rule reads positions and an area. |
| `ledger.example-crew` | `packages/pack-example-crew` | Your rule reads duty and rest periods, or fans out from a flight to the people on it. |
| `ledger.example-weather` | `packages/pack-example-weather` | Your rule reads values during a window, such as a flight from takeoff to landing. |
| `ledger.example-waiver` | `packages/pack-example-waiver` | Your source is a document kept as a file, quoted provision by provision. |
| `ledger.example-bvlos-waiver` | `packages/pack-example-bvlos-waiver` | Your source is a waiver or exemption that relieves another pack's rule (see section 8). |
| `ledger.part107` | `packages/pack-part107` | Your source is regulatory text kept as an original document, quoted paragraph by paragraph. |

The Part 108 pack (`packages/pack-part108-nprm`) quotes a proposed rule. Proposed text is never presented as current law, and such a pack can only be adopted in shadow.

## 1. Lay out the package

A pack is a workspace package under `packages/`. `packages/pack-example-operations` has:

```text
package.json        name @ledger/pack-example-operations; depends on @ledger/contracts, @ledger/domain, @ledger/integrity
tsconfig.json       extends ../../tsconfig.base.json, builds src/ into dist/
src/index.ts        exports the pack's builder and its rule ids
src/example-operations-v1.ts, -v2.ts, -v3.ts   one file per pack version
src/indicators.ts   indicators over the pack's rules (see write-an-indicator.md)
tests/              unit tests, and integration tests named *.integration.test.ts
```

Copy that package, rename it, and change the ids. Pack and rule ids are lowercase and dotted, and start with your pack's own prefix. Never name a real organization or person; the seeded tenants are fictional for this reason.

## 2. Write the rule

A rule is built with `defineCheckedRule` from `@ledger/domain`. Here is the example's rule:

```ts
/** Invented for the guide. It is not a regulation and not a manufacturer limit. */
const PROCEDURE =
  'Example procedure 7.1, wind. Crews read the wind at the aircraft before takeoff. The reported wind speed stays at or below the limit this organization sets when it adopts the procedure.';
const QUOTED = 'The reported wind speed stays at or below the limit';

function takeoffWindLeaf(): CheckedRuleLeaf {
  const start = PROCEDURE.indexOf(QUOTED);
  return defineCheckedRule({
    id: LEAF_ID,
    version: 1,
    title: 'Wind above adopted limit',
    source: {
      kind: 'operator_procedure',
      reference: 'Example procedure 7.1 (invented for this guide)',
      text: PROCEDURE,
      span: { start, end: PROCEDURE.length },
    },
    target: { subjectKind: 'aircraft' },
    reads: [
      { name: 'subject', type: 'weather.wind', versions: [1], about: 'target', required: true, select: 'latest' },
    ],
    check: {
      kind: valueWithinLimitV1,
      params: { field: 'values.speedMetersPerSecond', comparison: 'at_most' },
    },
    adoptionParameters: [
      { name: 'limit', title: 'Wind limit (metres per second)', valueType: 'number', minimum: 1, maximum: 30 },
    ],
  });
}
```

What each part does:

- **`source`** is the text the rule quotes, exactly. `defineCheckedRule` stores the SHA-256 of the text's UTF-8 bytes and turns `span` into byte offsets (`textSpan`), so a reader sees exactly which words the rule serves. Leave `span` out to quote the whole text. Do not paraphrase a source into a rule.
- **`target`** is the kind of subject the rule gives a result about: `flight`, `aircraft`, `person`, `site`, `organization` or `component`.
- **`reads`** name the observations the rule reads. Here it is the latest `weather.wind` version 1 observation about the target aircraft. `required: true` makes a missing reading `insufficient`, never a pass.
- **`check`** names a check kind and its fixed parameters.
- **`adoptionParameters`** are the values the organization sets when it adopts the pack. They are merged into the check's parameters. Here the organization sets `limit`.

`defineCheckedRule` refuses a rule whose parameters its check kind does not accept, or that reads something it cannot.

### Who the rule is for, and what is not on file

Without more, a rule is evaluated for a subject only when a record it reads arrives about that subject, so a missing record says nothing. Declare the rule's population, and name the record it requires, with `withPopulation` from `@ledger/domain`:

```ts
withPopulation(spec, { of: 'on_record' }, { subject: 'remote pilot certificate' });
```

- **`population`** says who the rule is meant for: every subject of its target kind on record (`on_record`), the subjects a named record designates (`designated`, such as the people role records name as remote pilot), or the subjects with records in the adoption's dates (`in_adoption_dates`). Each member is evaluated when the pack is adopted and when it joins. See [rule-coverage.md](../design/rule-coverage.md).
- **`onFile`** names, for each read it lists, what a person calls its record. The read becomes required; a member without the record gets `insufficient`, reason `record_not_on_file`, "No remote pilot certificate on file.", and is counted under **No record on file** on the Rules screen.

### Asking whether a document is on file

A rule that asks whether the organization has a document in effect (a safety policy, a training program) reads the `organization.record-in-force` observations Ledger records when a controlled document is issued, superseded, withdrawn or retired. Declare on the pack version the purposes it looks for (`purposes`: an id, a title a person understands, and the paragraph it quotes); a person ticks them on the document's revision. Name the document types that serve a purpose by being what they are (`documentTypes`). Read the observations with `plans: true` and a condition on `values.recordKind`, and check with `record.in-force@1` and `serves: { purpose, documentTypes }`. Its result names the document; say in the rule's wording that what the document says is for a person. `documentServing` in `packages/pack-part108-nprm/src/checks.ts` is the model. A pack description (`pack.yaml`) declares purposes too, under `purposes:` (each with `id`, `title` and the `quote` it serves); a provision whose obligation looks for a document, such as `procedure.on-file`, adds its own. See [on-file-checks.md](../design/on-file-checks.md).

A rule that asks how many safety assurance records (audits, reviews, investigations) are on file reads the same observations with `values.recordKind` `assurance` and checks with `records.counted@1`: it counts the signed records performed within the adoption's dates, by type, and the actions they set that are open and past their due date. `safetyAssuranceCounted` in `packages/pack-part108-nprm/src/checks.ts` is the model. See [assurance-records.md](../design/assurance-records.md).

### Pinning text kept in a document

When the source is a document you keep as a file (a regulation, a waiver), quote it by byte span into the original bytes instead. `packages/pack-part107/src/retained-document.ts` does this for each paragraph:

```ts
/** The quoted paragraph as an in-force rule source, read from the retained document; throws if its bytes changed. */
export function quotedSource(documentBytes: Buffer, paragraph: QuotedParagraph): RetainedDocumentSource {
  const { reference, start, end } = paragraph;
  const bytes = documentBytes.subarray(start, end);
  if (sha256(bytes) !== paragraph.sha256)
    throw new Error(`Retained paragraph ${reference} does not match its pinned source span`);
```

The registration then lists the document under `sources`, and the registry checks every quoted span against those bytes. A source of kind `proposed_regulation` marks proposed text.

## 3. Choose a check kind and the observations it reads

Check kinds live in `packages/domain/src/check-kind-library*.ts`. `pnpm pack:kinds` prints every registered kind with its inputs, parameters and the question it answers; [record-check-kinds.md](../design/record-check-kinds.md) has the design behind them. The common ones:

| Check kind | Question |
| --- | --- |
| `value.within-limit@1`, `@2` | Is the latest value within a fixed or recorded limit? |
| `record.complete@2` | Is the latest record of this type held and complete? |
| `date.within-months@2` | Is a recorded date within the last N calendar months? |
| `duty.within-limits@1` | Do duty and rest periods stay within limits? |
| `position.in-area@2` | Do positions keep inside, or out of, an area? |
| `window.values-within-limit@1` | Is every value in a window, such as a flight, within the limit? |
| `events.answered-within@1` | Does each recorded event have its answer, such as a report, within a period after it? |
| `periods.each-recorded@1` | Does each period of calendar months hold a record, such as a monthly report? |
| `value.flown-or-planned@1` | Is the worst flown value, or else the planned value, within the limit? |
| `authorization.covers-flight@1` | Does an airspace authorization on record cover the flight's time, place and height? |

A rule about a deadline uses one of two kinds over deadlines. `events.answered-within@1` asks whether every recorded event inside the adoption's dates has its answer within a period after it: so many hours, so many days after its local date (optionally skipping weekends and listed holidays), or by a given day of the following month. The answer is a time on the event record, such as when it was reported, or a later record that covers the event's date; each event late or still without one is named. `periods.each-recorded@1` asks whether each period of calendar months inside the adoption's dates holds a record, such as a monthly report or a yearly review, in fixed periods (each calendar month) or rolling ones (no more than N months after the last); each period that ended without one is named. Both read the adoption's dates, which the engine gives only to a kind that declares it reads them, and take the time zone as a parameter the organization sets. The Part 108 pack's reporting clocks use them (`packages/pack-part108-nprm/src/checks.ts`).

A read with `plans: true` also reads records about a time that has not come, such as a flight plan for next week and the role assignments for its window. Give it to every read of a rule whose question is about a plan, so a planned flight is checked as soon as its records are on file; leave it off a rule about what happened.

Every check returns one of `pass`, `attention`, `pending` or `not_applicable`, with an evidence state (`supported`, `insufficient`, `conflicting`, `not_applicable`). A missing value is `insufficient`, never a pass. `attention` opens a finding.

The observation types are registered in `packages/contracts/src/observations/`: `link.status`, `battery.state`, `position.fix`, `weather.wind`, `airspace.authorization`, `flight.report`, `traffic.alert`, `aircraft.fault`, `crew.duty-period` and `operator.record`. Operator records (training, maintenance and the others) arrive as `operator.record`; narrow such a read with `where` on `values.recordType`. A record type registered with `observed` is the exception: each record is stored as its own observation type, as duty or rest periods are stored as `crew.duty-period` (`recordRuleRead` in `packages/contracts` says how each type is read). If your problem needs a fact none of these carries, register a new observation type and write an adapter that produces it (see [write-an-adapter.md](write-an-adapter.md)).

### Reading what was flown, and what was planned

A rule about height, speed, place or airspace authorization reads what the aircraft and the airspace service reported when it is on record, and the plan otherwise. [observed-values.md](../design/observed-values.md) lists what each adapter reports and against what datum. To write one:

- Read the plan with `plans: true`, so a planned flight is checked as soon as its plan is recorded. Do this for every read of a plan or of a record made for the planned window (an assignment, a notice, a preflight item); never for a read of what happened.
- Name the plan's aircraft as a related subject with `whenNone: empty`, and read its `position.fix` observations `within` the plan's window: these are the flight's flown values. With no aircraft named, the reads are empty and the rule rests on the plan. Give the relation `requeue` on the window end so a position reported after the flight still re-evaluates it.
- Use `value.flown-or-planned@1` for a value and a limit, `authorization.covers-flight@1` for airspace authorizations, or `position.in-area@2` with `coverage: optional` for an area. Say in the parameters what each value measures (`plannedDescribes`, each measure's `describes`); a measure the limit cannot be compared with, such as a height above the WGS84 ellipsoid against a limit above ground level, is named with `compared: false` and never compared.
- Every result says which it read: in its summary, and in the details `basis` (`flown` or `planned`) and `measured`. A rule's wording can quote the whole sentence as `{reading}` and add what is left to a person.

`heightWithinLimit` in `packages/pack-part107/src/checks.ts` is the model; the waiver library's `condition.max-height` is the same rule for a pack file.

## 4. Assemble the pack and pin its digest

Each pack version is built from its rules and checked against a digest written in code:

```ts
const VERSION_ONE_DIGEST = 'd03bbdfc131ea44049fc61d5f284abcaa9c6c03aac13f0300dcc43bc23f46874';

function guideWindVersionOne(): RulePackVersion {
  const content: Omit<RulePackVersion, 'digest'> = {
    packId: PACK_ID,
    version: 1,
    title: 'Example wind procedure (guide)',
    status: 'draft',
    review: 'ai_drafted',
    adopted: false,
    bindings: [],
    leaves: [takeoffWindLeaf()],
  };
  const pack = { ...content, digest: canonicalDigest(content) };
  if (pack.digest !== VERSION_ONE_DIGEST)
    throw new Error(`Rule pack ${PACK_ID} version 1 changed without a new version`);
  return pack;
}
```

To get the digest the first time, run the pack's test with a placeholder digest and copy the value it reports. After that, any change to the text, a read, the check or its parameters changes the digest and the pack refuses to load. Publish the change as version 2 beside version 1. The registry refuses any other `status` and `review` labels; `review: 'ai_drafted'` says the rule text has not been attested by a person, and the pack stays unadopted until a person adopts it.

## 5. Register it

The registry is `registerRulePack` in `packages/domain/src/rule-pack-registry.ts`. It refuses a version whose digest does not recompute, a rule whose digest is stale, and a quoted span that does not match its document. The example test registers its pack directly:

```ts
registerRulePack({ packId: PACK_ID, versions: [guideWindVersionOne()] });
const pack = getRulePackVersion(PACK_ID, 1)!;
expect(pack.digest).toBe(VERSION_ONE_DIGEST);
```

In the product, the API and the workers register every shipped pack at startup through `registerStandardPacks` in `packages/standard-packs/src/index.ts`. To ship your pack, add your package to that package's dependencies and its builder to `standardRulePacks()`. Every process then has the same packs; the unit tests load them the same way through `tests/register-standard-packs.ts`.

# Part 3. Adopt it

## Adopt it in shadow, then in active

Run the stack from the [README quickstart](../../README.md#from-a-source-checkout), sign in as a fictional person who can adopt packs (the Alpha Dispatch dispatcher can), and open **Rules**.

1. Under **Adopted rule packs**, use **Adopt a rule pack**. Pick the pack and version, set the date range, fill in the values its rules ask for (the wind limit in Part 2, the ground speed limit in Part 1), choose **shadow**, and write a note. For a waiver, the form says what dates the certificate states and starts from them: from their first day (or now, once it has passed) to the end of their last day, in your organization's time zone. Clear "In effect for the certificate’s stated dates" to give a number of days instead.
2. In shadow, every rule is evaluated and its findings are recorded and labelled "Proposed rule: recorded, not counted". They are never counted in what a person attests to.
3. When you trust the results, use **Change to active** on the adoption. From then on its findings are counted and shown in a flight's release basis. Changing mode is a new revision of the adoption; earlier evaluations keep the mode they were recorded under.

The same command is `rule-pack.adopt` on the public API (`PackAdoptionCommandSchema` in `packages/contracts/src/adoptions.ts`), with `mode: 'shadow'` or `'active'`. A pack that quotes proposed text can only be adopted in shadow. From the command line, `pnpm ledger packs adopt <pack> --mode active` on a pack adopted in shadow prints the revision that changes its mode, and sends it with `--reason`.

## Where its findings show

- **Rules → Adopted rule packs** shows, for each adopted pack, how each rule is checked and its subjects counted by latest result: supported by the record, needs attention, no record on file. Each count opens the subjects behind it.
- **Rules → Findings by subject** lists findings for a subject picked by name.
- A flight's findings appear on its screens; active findings enter the release basis a person reviews before release.
- Each finding links to the evaluation that opened it: the rule version and digest, the input digest and the observations it read.
- A finding can be packaged with its evidence and checked offline; see [verify-an-export.md](verify-an-export.md).
- To count findings over time, write an indicator; see [write-an-indicator.md](write-an-indicator.md).

## 8. Relief: a waiver or exemption that covers another pack's rule

A waiver lets its holder do what a rule otherwise asks them not to, under conditions. When a waiver pack quotes a provision that grants such relief, its rule declares it as data: `relieves`, a list of the other pack's id and the ids of its rules. [waiver-relief.md](../design/waiver-relief.md) has the design.

```ts
{
  number: '1',
  title: 'Relief from visual line of sight',
  start: 641,
  end: 928,
  sha256: 'e37a7744…',
  obligation: 'authority.flight-cites-certificate',
  parameters: { certificateNumber: 'BVW-0001', effectiveFrom: '2026-09-01', effectiveThrough: '2028-08-31' },
  relieves: [{ packId: 'ledger.part107', ruleIds: ['ledger.part107.107.31.a'] }],
}
```

In a pack file the same declaration is `relieves` on a provision of a description whose source `kind` is `waiver` (Part 1, step 3). In TypeScript, the above is provision 1 of the invented `ledger.example-bvlos-waiver`. The waiver builder (`waiverRulePack` in `packages/pack-example-waiver`) passes `relieves` to `defineCheckedRule` and names the rule after the provision, here "Special provision 1: Relief from visual line of sight". With `defineCheckedRule` directly, give the rule `relieves` and a source of kind `waiver_or_exemption`.

- **Only a waiver or exemption relieves.** `defineCheckedRule` refuses `relieves` on a rule whose source is not `waiver_or_exemption`. The registry refuses a pack whose relief names its own pack, a pack not registered, or a rule id no registered version of that pack holds, so register the relieved pack first (`standardRulePacks` lists Part 107 before the waivers).
- **Only what the provision covers.** When the provision and the relieved rule are about the same kind of subject (both about a flight, say), the relief applies to a subject only while the provision's own latest result for that subject, under the waiver adoption, is supported (`pass`). For provision 1 that means a flight whose plan cites the certificate. A flight whose plan cites nothing keeps the relieved rule's own result, which counts as any result does; its record carries `relief.coverage.covered: false` and says that the waiver relieves the rule but its provision does not cover this subject, with what the provision's check last recorded. When the provision's result for a subject changes, the relieved rule is evaluated again for that subject, so the order in which the two are evaluated does not matter. When the two rules are about different kinds of subject, the relief applies to every subject while the waiver is adopted.
- **Active.** While an adoption of the waiver in active mode is in effect, every evaluation of the relieved rule for a subject the provision covers is recorded with the result `relieved`. The rule is still evaluated: its evidence and details stay on the record, and what it would otherwise have reported is kept under `relief.otherwise`. The record names the waiver adoption (id, pack, version, digest, who adopted it) and the provision with its quoted text. Its summary reads "Relieved by <provision title>, <waiver pack title>, adopted by <person>." A relieved result opens no finding and is not counted in a flight's or a release's open findings; screens list it in a category of its own.
- **Shadow.** In shadow the relieved rule's own answer stands and counts; the record notes what the waiver would relieve, by the same test of what the provision covers.
- **Starts, changes, ends.** Adopting, revising or succeeding the waiver evaluates the relieved rules again for the subjects they have evaluated. A relieved evaluation is due again when the waiver's adoption ends, and from that instant the rule counts as before.
- **Conditions.** The waiver's other provisions are ordinary rules: when a condition is not met, its own finding counts. A waiver states which flights its conditions cover (Part 1, step 3); for a flight they do not cover, they do not apply. Relief depends only on the provision that declares it; write what a subject must show to be covered (a citation, a listed aircraft) into that provision's own check.

## Check your work

For a pack file, `pnpm pack:check <file>` is the check startup makes. To test one end to end, copy `packages/standard-packs/tests/pack-files.integration.test.ts`. For a TypeScript pack:

1. Copy `tests/unit/guides/rule-pack-example.test.ts` into your pack's `tests/` folder, or start from `packages/pack-example-operations/tests/example-operations.test.ts`. Keep the three things it proves: the source is pinned, the pack registers with its digest, and one evaluation gives the result you expect.
2. Run `pnpm verify`. It checks formatting, builds, type-checks and runs every unit test, including `tests/unit/shipped-pack-digests.test.ts` and the guard in `tests/unit/generalisation-guard.test.ts`, which fails if core code names your rule.
3. For the database path, copy an integration test such as `packages/adapters/tests/battery-reserve-rule.integration.test.ts` and run it with `LEDGER_TEST_DATABASE=ledger_test_mine pnpm test:integration`.
4. In the running app, adopt the pack in shadow, submit an observation that breaks the rule, and look for the proposed finding under **Rules → Findings by subject**.
