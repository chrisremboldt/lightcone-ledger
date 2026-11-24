# Relief granted by a waiver

Design note. Builds on checked rules as data (`checked-rules.ts`), the generic evaluator (`rule-evaluations.ts`), adoptions with modes, revisions and successors (`adoptions.ts`, `adoption-queueing.ts`) and release findings (`mission-release-findings.ts`).

A waiver or exemption lets its holder do what a rule otherwise forbids, under conditions. Ledger already reads a waiver's conditions as ordinary rules (`packages/pack-example-waiver`). What it could not say is that the waiver covers another pack's rule: a flight beyond visual line of sight flown under a waiver got a counted Part 107 finding on every flight. This note says how a waiver's provision declares relief, what an evaluation of a relieved rule records, and how relief starts and stops. Ledger records relief a person granted by adopting the waiver; it never decides that anyone may fly.

## 1. The declaration

- Relief is data on the provision's rule: an optional `relieves` on the checked rule leaf, a list of `{ packId, ruleIds }`. It is part of the leaf, so it is inside the leaf digest, the pack digest and every adoption of the pack. Leaves without it keep their digests.
- Only a waiver or exemption can relieve. A rule with `relieves` must quote its source as `waiver_or_exemption`, the source kind for the text of a waiver or exemption the organization holds, carried whole and pinned by digest.
- The registry refuses a pack at registration when a relief names its own pack, names a pack that is not registered, or names a rule id that no registered version of that pack holds as a checked rule. Packs register in an order that puts the relieved pack first (`standardRulePacks`).
- The provision that declares relief is itself an ordinary rule with its own check. In the example it asks whether the flight plan cites the certificate as its operating authority.

## 2. Finding the relief for an evaluation

When the evaluator records a result for a rule, it looks at the adoptions in effect at the evaluated instant (the same read that finds the rule's own adoption). Every adoption in effect whose pack holds a rule relieving this pack and rule is a candidate.

**Relief covers only what the provision covers.** When the provision and the relieved rule are about the same kind of subject, the provision covers a subject only while its own latest result for that subject, under that waiver adoption, is supported: outcome `pass` with evidence state `supported`. A provision that fans out to related subjects covers the subject only when its latest result for every related subject is supported. A provision with no result for the subject yet does not cover it. When the two rules are about different kinds of subject (a provision about the organization relieving a rule about a flight, say), no result of the provision is about the evaluated subject, so the provision covers every subject while the waiver is adopted, as in the first version of relief.

One candidate is chosen, deterministically: an active adoption before a shadow one, then a provision that covers the subject before one that does not, then the lowest pack id, then the provision's rule id.

The relieved rule is still evaluated. Its reads, check, evidence, details and input digest are exactly as without relief. Relief changes what the result counts for, never what was observed.

## 3. What is recorded

The evaluation record gains `relief`:

- `mode`: the waiver adoption's mode, `active` or `shadow`.
- `waiver`: the adoption by id, accepted revision and effective interval; the pack by id, version, digest and title; who adopted it (`adoptedBy`, id and name, from the adoption's actor).
- `provision`: the relieving rule's id, version and digest, its title and its quoted source (reference, text and digest).
- `coverage`, when the provision and the relieved rule are about the same kind of subject: `covered`, and `provisionResult`, the provision's latest result for the subject under the waiver adoption (evaluation id, outcome, evidence state, reason code and summary), absent when it has none yet.
- `otherwise`, for active relief of a covered subject only: what the relieved rule would otherwise have reported: its outcome, reason code, summary, and any issues and issue times.

With active relief of a covered subject the record's `outcome` is `relieved`, a result value of its own, its reason code is `relieved_by_waiver`, and its summary reads "Relieved by <provision title>, <waiver pack title>, adopted by <person>." The evidence state stays what the evidence supports. Issues move into `otherwise`, so no indicator or finding counts them.

When the provision does not cover the subject, the relieved rule's own result stands and counts, as without the waiver, and `relief` with `coverage.covered: false` says why. Its plain words (`reliefStatement`) read "<waiver pack title>, adopted by <person>, relieves this rule, but its provision <provision title> does not cover this subject, so the rule's own result stands. The provision's check last recorded: <its summary>."

The relief is part of the evaluation's observation digest (the waiver adoption, its revision and mode, the provision rule and digest, and, with coverage, whether it covers the subject and the provision result's outcome, evidence state, reason code and summary), so relief starting, stopping, changing mode or changing coverage is recorded as a new evaluation even when no observation changed.

## 4. Shadow

A shadow adoption of the waiver records on the evaluation what it would relieve, by the same test of what the provision covers: `relief` with `mode: shadow` and no `otherwise`. The outcome is the check's own and the rule counts exactly as it would without the waiver. Screens say "Would be relieved by …, shadow adoption" beside the result, or "Would not be relieved by … : the provision does not cover this subject" with what the provision's check last recorded.

## 5. What a relieved result counts for

- It opens no finding and does not reopen a resolved one.
- A finding opened before the relief stays as it is, with the relieved evaluation as its latest. It is not counted in a flight's open findings or a release's open findings while its latest evaluation is relieved.
- A release lists relieved rules for the flight and the subjects it reads beside its counted and proposed findings, as their own category, outside the pinned basis. Every screen that lists results shows relieved as its own category with the words "Relieved by <provision title>, <waiver pack title>, adopted by <person>". No screen says compliant, authorized or permitted.

## 6. When the waiver's adoption starts, ends or is revised

- **Starts, is revised (mode change) or is succeeded by a later version.** The adoption is projected through the existing path (`projectPackAdoption`). Besides the work for its own rules, it starts one adoption-page work row for each rule it relieves, under the relieved pack's id and rule id. A worker queues that rule, page by page, for every subject it has already evaluated, due when the waiver adoption starts. Each queued evaluation reads the adoptions in effect at its own instant.
- **Ends.** A relieved or shadow-relieved evaluation names the end of the waiver adoption's interval as its next boundary (or the check's own, if earlier). At that instant the rule is evaluated again, finds no relief in effect and records what the rule reports.
- An adoption of the relieved pack itself changes nothing here: its own queueing evaluates its rules, which look for relief as usual.
- **The provision's result changes.** When the evaluator records a provision's result for a subject that differs from the provision's latest result for that subject under the same adoption (outcome, evidence state, reason code or summary), or is its first under that adoption, it queues each rule the provision relieves for that subject, with the provision's evaluation event as the trigger (kind `state`). Whichever of the two is evaluated first, the relieved rule's latest evaluation reads the provision's latest result: if the relieved rule ran first it finds no result and is not relieved, and the provision's first result queues it again. A queued relieved rule waits for any evaluation of it in progress (the per-rule advisory lock) and reads the provision's result committed before it was queued, so the record converges to the same result in either order. A relieved rule about another kind of subject than the provision is queued for nothing: the evaluator finds no rule of that kind for the subject. The queueing inserts work rows only (group 8 of `lock-order.md`); reading the provision's latest result takes no lock.

## 7. Conditions are not prerequisites

The waiver's own conditions (operating area, equipment, procedures, weather minimums, pilots, notification) are ordinary rules of the waiver pack. When one is not met, its finding counts as any finding does. Relief depends only on the provision that declares it (section 2): a waiver whose relief needs a subject to show something (a citation of the certificate, an aircraft on its list) states that in the provision's own check. The other conditions' findings sit beside the relieved result for a person to weigh.

## 8. What a waiver's conditions cover

A holder flies some flights under its waiver and others under the regulation alone. A waiver pack states which flights its conditions cover, as data on the pack version (`waiver` in `RulePackVersionSchema`, with the certificate number and the dates the certificate states it is effective): `flights_citing_certificate` or `every_flight`. A pack description has no default for it (`pnpm pack:build` refuses a waiver without it); the built-in example waivers state it in their definitions.

- **A covered flight** is one whose latest plan cites the certificate number in its operating authority reference. With `flights_citing_certificate`, every rule about a flight gains a read of the flight's latest plan (`authority`, required, "flight plan" on file) and an applicability condition that it cites the number (`limitedToCitingFlights` in `packages/pack-example-waiver/src/obligations.ts`). For any other flight the rule records `not_applicable`, reason `condition_not_met`, with the condition's own sentence (`notMetSummary`): "The latest flight plan does not cite <number> as its operating authority, so the waiver’s conditions do not cover this flight." It opens no finding and is counted under "Does not apply". A flight with no plan on file gets "No flight plan on file." (`record_not_on_file`): the engine reports a required record a person names before deciding a condition on it. Every such rule is for the flights with records in the adoption's dates, so none is passed over.
- **People and aircraft through a covered flight.** A provision about people is a rule about the flight that fans out to the people the flight's assignments name in the role the obligation names (the named course: each remote pilot in command). A provision about aircraft reads the aircraft the flight's latest plan names. For a flight the waiver does not cover, the engine decides the condition on the flight's own records before it resolves any related subject (`evaluatedSubjectDecision`), so nobody and nothing else is reported: an unlisted pilot or aircraft of an ordinary flight carries no result of the waiver.
- **The organization once.** A provision about the organization, such as a procedure on file, is a rule about the organization, evaluated once for it, whatever the waiver covers.
- **Rules by check kind** in a waiver description cover every flight unless they carry `covers: flights whose plan cites the certificate`, which adds the same read and condition.
- **Relief is unchanged.** The relieving provision is limited like any other: for a flight that does not cite the certificate it records `not_applicable` instead of needing attention. Neither is supported, so the relieved rule's own result stands for that flight exactly as before (section 2).
- **Stated dates.** The dates the certificate states are shown, never judged: the adopt form starts an adoption from them in the organization's time zone, and the Rules screen says for an adopted waiver "The certificate states it is effective through <date>" with the days remaining, or that the date has passed. No screen says the waiver is valid or expired.
- **A flight outside the stated dates.** The provision `authority.flight-cites-certificate` takes the certificate's dates as parameters (`effectiveFrom`, `effectiveThrough`) and is about every flight whose plan cites the certificate, on any date (a `designated` population of the plans that cite it), not only those in the adoption's dates. A flight that cites it on a local date outside those dates needs attention, and the sentence gives the dates and the flight's date: "… The flight's time is takeoff at … on 2026-09-25, before the dates certificate 107W-EX-1 states it is effective, from 2026-09-28 through 2028-09-27." Since that provision is the one that relieves, such a flight is not relieved: the relieved rule's own result stands (section 2).

## 9. Database

`rule_evaluations.outcome` admits `relieved` (migration 0079). Nothing else in the schema changes; `relief` lives in the record.
