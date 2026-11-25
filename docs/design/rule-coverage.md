# Rule coverage: populations and missing records

Status: built. Contracts: `RulePopulationSchema` and a read's `onFile` in `packages/contracts/src/checked-rules.ts`; the coverage shapes in `packages/contracts/src/rule-coverage.ts`. Code: `packages/domain/src/rule-populations.ts` (who is in a population), `adoption-queueing.ts` (the population step), `rule-evaluations.ts` (a subject that joins), `rule-coverage.ts` (the reads). Builds on the generic evaluator, `fan-out-and-related-reads.md` and `lock-order.md`.

## The problem

A rule is evaluated for a subject only when a record it reads arrives about that subject, or when an adoption finds such a record. A person with training records and no certificate is never evaluated by the certificate rule, so nothing says the certificate is missing. An operator reads that silence as "nearly there". Nothing shows, per rule, how many subjects the records support, how many need attention and how many have no record at all.

## 1. A rule declares its population

A checked rule may carry `population`, data on the rule like its reads. It names the subjects the rule is meant to be evaluated for, whether or not a record it reads exists about them. Core code reads only the declaration: it names no rule, record type or regulation.

| Form | Members |
| --- | --- |
| `{ "of": "on_record" }` | Every subject of the rule's target kind the organization has on record (below). The plain form, with nothing narrowing it. |
| `{ "of": "designated", "by": { "type", "versions", "where", "field" } }` | The subjects the current observations of one type, meeting the conditions, name at `field`: `subject`, `secondarySubject`, or a reference field. For example the people role-assignment records name as remote pilot in command, or the aircraft a fleet record lists. |
| `{ "of": "in_adoption_dates" }` | The subjects of the target kind named by a current observation whose time (its interval, else its time of occurrence) overlaps the adoption's effective interval. For example the flights flown while the pack is adopted. |

A subject is **on record** when it is a Ledger subject of the kind (the `subjects` table), or when a current observation (neither replaced nor withdrawn) names it: as its subject or secondary subject, as currently resolved, or in a reference field of the kind, as written. A source's own id counts under that source, as evaluations count it.

**Without a declaration** a rule keeps today's behaviour: it is evaluated for the subjects whose records it reads, and its coverage counts the subjects it has evaluated under the adoption. Absence does not mean "everyone on record": that would change what every existing pack does (the demonstration procedures would report overdue landing evidence for every flight ever recorded), which no one asked for. Every shipped rule of the Part 107, Part 108 and example waiver packs declares one; the other packs do not.

A population's members are subjects, each once, however many records designate it or name it: a pilot assigned to forty flights is one member. Every read of a population (the coverage counts and lists, the adoption's queueing, a subject joining) takes the members from one query that returns each subject once.

A population is a declaration about who the rule is for, not about whether it applies: applicability conditions and `whenAbsent` still decide that for each member.

## 2. Joining and leaving

- **Adoption, revision and successor.** Each rule with a population gets one more adoption step after the existing ones: its members, a page of 500 per transaction in a fixed order, through the same `adoption-page` work rows. Every adoption, revision and successor runs its steps, so each re-queues its whole population.
- **A subject joins** when an observation is projected that brings it into a population: it names a subject of the kind (`on_record`), it is a designating record and names the subject at the field (`designated`), or it names a subject of the kind and its time overlaps the adoption (`in_adoption_dates`). If the subject has no evaluation of the rule under the adoption in effect, the rule is queued for it under that observation, with the same unique key as an ordinary observation trigger. One indexed lookup per rule with a population and named subject; nothing is queued for a subject the rule has already evaluated.
- **A subject leaves** when nothing designates it any more (an assignment withdrawn, a record replaced). Nothing is written: its last evaluation and any finding stay as they are, and the coverage read, which resolves the population when it reads, no longer counts it.
- A subject that becomes a member only through a correction or an alias joins at the next record about it or the next adoption revision. This is the one gap, kept because a correction names observations, not population changes.

### A successor that replaces an adoption from its first day

A corrected version of an adopted pack must be able to cover every day the version it corrects covered, or one day stays under the wrong version. A successor therefore takes one of two forms, told apart only by its start:

- **From a later instant.** Its start is after the start of the adoption it succeeds and before that adoption's end. The earlier adoption is in effect until that start and ends there, as before.
- **For the whole period.** Its start is at or before the start of the adoption it succeeds, and its end at or after that adoption's end. It replaces the earlier adoption whole: afterwards the new version covers every day the earlier one did, and the earlier one is in effect at no instant.

How the record holds it: exactly as any successor. The new adoption names the earlier one in `succeeds`; no row changes, no column or constraint is added and none is loosened. An adoption already stops being in effect at the start of the adoption that succeeds it when that comes first (`adoptionEndSql`, and the same test in `adoptionsInEffect`); with a start at or before its own, that instant is at or before its start, so the earlier adoption is in effect nowhere. The read shows it as `succeeded` ("replaced") as soon as the successor is projected, whatever the time, with `succeededBy` naming the version and its start; while the successor stands, nothing else of the pack may overlap its dates, the part before the earlier start included. A revision of the successor keeps its start, as for any successor, so the earlier version can never come back into effect for a day.

What is evaluated: the successor's queueing is the same in both forms. It queues each rule for the subjects of its kind that any version of the pack evaluated, for the subjects of the records it reads whose time falls in its dates, and for its population. Each evaluation reads the adoption in effect at its own instant, which is the successor, so every subject the earlier version covered is evaluated under the new one. Evaluations recorded under the earlier adoption keep it: they are append-only and name that adoption.

What happens to the earlier version's findings: a finding is one per subject, pack and rule (`findingIdFor`), not per version. Where the new version keeps the rule, its evaluation of the same subject becomes the finding's latest; a finding whose latest result is supported stays open and is shown as cleared until its owner closes it, as when any later evaluation clears it, and one that still needs attention stays open with the new version's sentence. A finding of a rule the new version no longer has keeps the earlier version's evaluation as its latest and is read as a rule no longer adopted. Nothing is closed or reopened by the replacement itself.

### Records dated before an adoption starts

Known gap, not yet decided. What is built depends on when a record arrives:

- When an adoption is made, it queues its rules for the subjects of the records already on file whose time overlaps its dates. A flight on file whose records are all dated before the adoption's start is not queued: it has no evaluation under the adoption and coverage does not count it.
- A record that arrives while the adoption is in effect queues the rules that read it whatever its own date, and they are evaluated. So a flight dated before the adoption's start, imported after the adoption was made, gets an evaluation and may get a finding, although `in_adoption_dates` does not count it in coverage.

The same flight is therefore evaluated or not by the order of two actions. The consistent rule would be that an adoption evaluates only what its dates cover, whichever arrived first; that was built and taken out again because many fixtures adopt from the present moment and then record earlier events (issue 127, ruling 2). Until it is decided, an organization that brings in earlier records adopts from a date on or before the earliest of them, which gives the same result in either order: every flight is inside the dates. The setup guides say so.

## 3. A missing record

A read may say what a person calls the record it takes: `onFile: "remote pilot certificate"`. Only a required read may carry it. When every required read that came back empty carries `onFile`, the evaluation is `insufficient`, `pending`, reason `record_not_on_file`, summary "No remote pilot certificate on file." (one sentence per record). Otherwise the reason stays `required_input_missing`. No new result is needed: `insufficient` with this reason says exactly what is on file.

The shipped rules mark the read that holds the record the rule is about as required and give it `onFile`. For the record checks (`record.complete`) this changes a missing record from `attention` (`record_missing`) to `pending` (`record_not_on_file`). That is deliberate:

- **Findings.** A finding is per subject and rule (`findingIdFor`); nothing groups them. With populations, a missing record would otherwise open one finding needing an owner per person per rule: thirty people and twenty rules is six hundred findings for one empty import. A missing record is now `pending` in active and shadow alike, opens no finding, and is counted in coverage as "No record on file", where it is visible per rule and per subject. In an active adoption it behaves as every `pending` insufficient result does today; in shadow it is recorded and never counted, as everything in shadow is.
- An incomplete record (held, with a field missing) still needs attention and opens a finding as before.

### A record on file for a later time

**Waiting ends.** A result that waits for a record (`pending`, for any reason but `record_not_on_file`) would otherwise wait for ever on a flight that has flown. A rule may say when the wait ends: `waitEnds` names a read, a time field in it, the hours allowed after that time and the record waited for. Once the latest such time plus the hours has passed, the result is `record_not_on_file` and says so: "No preflight assessment stating the distance below cloud on file 7 days after the flight landed at 2026-10-01T10:40:00.000Z." followed by the check's own sentence. Until then the end of the wait is the next boundary. The Part 107 rules for a flight that read a value the operator may leave out (ground speed and height, flown or planned; the visibility and cloud distances of the preflight assessment; the assigned pilot's certificate status) wait a week after the operator's flight record says the flight landed, the time a position reported after the flight still reaches it.

A read that does not declare `plans` stops at the evaluation instant. When such a required read comes back empty, the evaluator looks once more for the earliest record the read would take whose time (its interval's start, else its time of occurrence) is after the evaluation instant and within the read's own bound. If every empty required read has one, the result is `insufficient`, `pending`, reason `record_for_later_time`, and its summary says, for each, that the record is on file for a later time and from when the rule reads it: "A flight plan is on file for a later time; the rule reads it from 2026-11-22T09:00:00.000Z." The evaluation is due again at the earliest of those times (`nextBoundary`), when the record is read as any other. The input records the record and its time (`inputs[].later`), and the record is part of the evaluation's observation digest, so a later record arriving is recorded as a new evaluation. When some empty reads have a later record and others have none, the reason stays `record_not_on_file` or `required_input_missing`, and the summary says "on file for a later time" for the reads that have one instead of "No … on file". No new result value is needed. Coverage counts `record_for_later_time` under waiting (`pending`), not under no record on file.

## 4. Bounds

- At most `POPULATION_LIMIT` = 2,000 members per rule and adoption are queued. The population step stops there. The coverage read resolves at most 2,001 and says the count is incomplete (`incomplete: "population_limit"`) when there are more.
- Queueing is paged (500 per transaction); a join queues one subject per rule. No transaction covers the whole organization.
- A coverage count is also incomplete (`incomplete: "evaluating"`) while a member has no evaluation under the adoption.

## 5. The coverage read

`GET /v1/organization/coverage/adoptions/{adoptionId}`: for each rule of the adoption's pack, how it is checked (`automatic`, `person`, `not_supported`), its population form, the population size, and the members counted by their latest evaluation under the adoption:

| Count | Latest evaluation | Words |
| --- | --- | --- |
| `supported` | `pass` | Supported by the record |
| `attention` | `attention` | Needs attention |
| `no_record` | reason `record_not_on_file` | No record on file |
| `pending` | other `pending`, including reason `record_for_later_time` | Waiting for a record or a time |
| `not_applicable` | `not_applicable` | Does not apply |
| `other` | any other result | Other |
| `not_evaluated` | none yet | Not yet evaluated |

A rule that fans out (one result per related subject) counts its target by the results for its related subjects, the one needing most attention first, in the order of the table. Unknown result values are counted as `other`, so a result added later never breaks the read.

**Sections.** A pack version may list its sections in reading order (`sections: [{ id, title }]`, such as `108.165`, "§ 108.165 Area of operations"); each rule then names its section (`section`) and the paragraph it reads (`paragraph`, "§ 108.165(a)"). The registry refuses a version where a rule names a section it does not list, or where some rules name one and others none. The read returns `sections` in that order, each with its rules' ids, how many of them are checked in each way, how many have a member needing attention (`needingAttention`) and how many have a member with a record not on file (`withNoRecord`), and `rules` section by section, each with its `section` and `paragraph`. A pack that lists none is one section, `all`, its rules in the order of their paragraphs or, without one, of the numbers in their ids, so a waiver's provisions read 1, 2, …, 10. Part 107 version 2 and Part 108 version 3 place each rule in the section of the text it quotes; a pack file may declare sections (`pack-files.md`). The Rules screen, `pnpm ledger coverage` and `pnpm pack:list` show the same grouping.

**On the Rules screen.** The screen counts from this read alone (`apps/web/src/rule-coverage.ts`); it sends no other request. Each pack opens with its rules counted, not its findings: a rule is in each count it has a member in (needs attention, no record on file, supported, relieved, does not apply), in "a person reviews it" when a person reviews it, and in "nothing counted yet" when it is checked and its population is empty. Each count filters the rules. Sections fold, opening where a rule has a member needing attention or with no record on file; the rules counting nothing yet are listed after the last section, with the sentence naming the record that would bring a subject in, by the record type's title from the same definitions the Records screen lists.

`GET /v1/organization/coverage/adoptions/{adoptionId}/rules/{leafId}/subjects?result=…&cursor=…&limit=…`: the members behind one count, a page at a time in subject-key order, each with its name, its latest evaluation, the open finding if any, and the records not on file (the `onFile` of each required read the latest evaluation found empty).

`GET /v1/organization/subjects?kind=…&search=…`: the subjects of one kind on record, with names, for picking a subject instead of typing ids. At most 2,000 are read; the response says when there are more.

All three are reads: they take no row or advisory locks (`lock-order.md`, "Reads at REPEATABLE READ take no row locks").

## 6. What is recorded

Nothing new is stored. A population is part of the rule, so of the rule's and the pack's digests; an evaluation records the rule digest it ran under. Population membership is computed when queued and when read, from current observations and subjects, never stored: a stored list would be a second truth to keep current. The queueing work rows carry their step and position as before.

## 7. The shipped packs

| Rules | Population | Record named as not on file |
| --- | --- | --- |
| Part 107 rules about a remote pilot in command (§§ 107.12(b), 107.65) | the people role-assignment records name as pilot in command, for a flight or as a standing designation (`designated`) | the remote pilot certificate; the knowledge test or recurrent training |
| Part 107 rules about the crew of a flight (§§ 107.17, 107.27) | the people role-assignment records name in the roles the paragraph lists (`designated`, below) | the fitness and substance declaration |
| Part 108 rules about operations personnel | every person on record | the training, personnel file, duty and rest record each reads |
| Example waiver provisions about people and aircraft (named training, listed aircraft, remote identification) | the flights with records in the adoption's dates, read for each remote pilot in command a flight assigns or the aircraft its plan names (`waiver-relief.md`, section 8) | the assignment or flight plan, and the record of the named training or the aircraft identity record |
| Rules about an aircraft or a life-limited part | every aircraft (part) on record | the identity, condition or time-in-service record |
| Part 108 operations supervisor | the organization, which is on record as a Ledger subject | an operations supervisor role assignment |
| Part 108 aircraft per coordinator | the flights a multiple-aircraft operation record is about (`designated`) | none: the designating record is the record read |
| Part 108 reporting clocks after an event (interruption, failure, security breach, property or area event) | the subjects the event records of the reportable kinds are about (`designated`); each event inside the adoption's dates needs its report in its period | the event record, which every member has |
| Part 108 periodic duties of the organization (monthly flight hours and reliability data, yearly aircraft list, yearly cybersecurity review) | the organization; each period inside the adoption's dates that ended without its record is named | the report or review |
| Part 108 security threat assessment | the people role-assignment records name as operations supervisor or flight coordinator (`designated`) | the security threat assessment |
| Part 108 who needs a security threat assessment (§ 108.335(b)) | the organization, so an organization with no one designated is told | an operations supervisor or flight coordinator role assignment |
| Part 108 operating area rules (§ 108.165(a)-(c)) | the organization: one result naming each current area | the operating area (`organization.operating-area`) |
| Part 108 positions flown inside an operating area | the flights with records in the adoption's dates | the flight plan, and the operating area |
| Part 108 items of an application (§ 108.505(b)) and the safety management system (§ 108.560(a)) | the organization | the document serving the purpose (`on-file-checks.md`), the adopted risk matrix, the hazards, or the operations supervisor or accountable executive role assignment |
| Example waiver provision that the flight plan cites the certificate within its stated dates | every flight whose plan cites the certificate, on any date (`designated`) | the flight plan |
| Example waiver provisions about a flight's pilots across flights (aircraft at once, recent flights) | the flights with records in the adoption's dates, read for each remote pilot in command a flight assigns | the remote pilot in command assignment |
| Every other rule about a flight | the flights with records in the adoption's dates | the flight plan, preflight assessment, payload declaration or flight record each reads |

Rules whose record exists only when something happened (an accident, a release for cause, a mechanical irregularity, an emergency deviation, a maintenance action) keep `whenAbsent: not_applicable` and name no record: their absence is not a gap. Rules that fan out to related subjects (an assigned pilot's certificate, a coordinator's experience, a part's aircraft) name none either: the relation already reports a missing related subject. ### Who a rule about a person covers

A rule about a person covers the people its paragraph is about, decided from the paragraph's own words, never every person on record by default. A maintenance lead or a safety manager on record is not a remote pilot, and a rule about remote pilots that counted them reported "No record on file" for a certificate no one expects them to hold. Where the paragraph applies to every person of a kind the records cannot narrow, the population stays every person on record.

| Rule | Population | The sentence of the regulation that decides it |
| --- | --- | --- |
| Part 107 § 107.12(b), the remote pilot certificate | pilot in command | "no person may act as a remote pilot in command unless that person has a remote pilot certificate …" |
| Part 107 § 107.65, aeronautical knowledge recency | pilot in command | "A person may not exercise the privileges of a remote pilot in command with small UAS rating unless …" |
| Part 107 § 107.17, medical condition | pilot in command, person manipulating the controls, visual observer, and the other roles a person holds on an operation (payload operator, operations supervisor, flight coordinator, other) | "No person may manipulate the flight controls … or act as a remote pilot in command, visual observer, or direct participant in the operation …" |
| Part 107 § 107.27, alcohol or drugs | pilot in command, person manipulating the controls, visual observer | "A person manipulating the flight controls … or acting as a remote pilot in command or visual observer must comply with …" |
| Proposed Part 108 §§ 108.40(b), 108.40(e)(1), 108.315(d), 108.330 | every person on record, unchanged | "Operations personnel means a person who is performing a safety function employed by, or used by, an operator": a safety function is wider than any role a record names, so the records cannot narrow it |
| Proposed Part 108 § 108.335(a) | operations supervisor or flight coordinator, unchanged | its own list of covered persons |

The roles come from `operation.role-assignment`, whatever it is about: a record about a flight assigns the person to that flight, and one about the organization designates them standing. A person named by either is in the population; a person on record whom no role assignment names is not, and is not counted in coverage, though a record about them is still evaluated. "Direct participant" in § 107.17 is not a role any record names; the roles a person holds on an operation are read as taking part in it, and the two roles that are not part of an operation (person responsible for training, accountable executive) are left out. The organization's people who hold none of the listed roles are for a person to consider.

Before this, every Part 107 rule about a person covered every person on record, because an early case had training records and nothing that designated anyone. That case now designates its pilots.

Since then, Part 108 version 3 and the example BVLOS waiver moved again when they gained the rules on file (`on-file-checks.md`).

Pins that moved: Part 107 versions 1 and 2, Part 108 versions 2 and 3, and the example waiver versions 1 and 2 (`tests/unit/shipped-pack-digests.test.ts` and the packs' own tests). Version 1 of Part 108 has no checked rule and keeps its digest.
