# One hazard model

Design note. Proposal for review; no code changes. Paths are relative to the repository root.

## 1. Recommendation

**Keep the safety-program hazard (B) — the shared record envelope with an adopted matrix and signatures — as the only hazard. Delete the flight-finding hazard (A) in one clean cut, once its last unique feature, the area control that feeds route avoidance, has a replacement.**

Reasons, from the code:

- B already has what A builds by hand for each table. It has versioned bodies with digests, a basis check on every decision (`sms-decisions.ts:451`) and a matrix pinned by record, version and digest (`sms-decisions.ts:103`, `:431`). Risk acceptance is signed: the signature is bound to the exact content and needs re-authentication (`:156`, `:545`). B also has links, attachments, confidentiality classes and export.
- A names two specific rules (`hazards.ts:45-46`, `:179-204`). Its "newer evidence" queries read `command_link_source_events` and `flight.observation` claims directly (`:1159`, `:1239`, `:1256`). That breaks the project rule, and making A generic would mean rewriting most of it.
- A's 3×3 integer matrix (`risk-matrix.ts`) cannot be adopted under B's 5×5 schema (`contracts/src/sms.ts:58-81`), so one side must move anyway.

What A has that B lacks, and where each piece goes:

| A behaviour                                                                               | Today                                 | Kept as                                                                            |
| ----------------------------------------------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------- |
| Origin flight, finding and evaluation pinned at opening; one hazard per evaluation        | `hazards.ts:291-368`                  | typed origin (step 1)                                                                 |
| Evidence pinned again at assessment; stale evidence refused at control or acceptance time | `hazards.ts:396`, `:465-503`          | evidence pin on the assessment (step 1)                                               |
| "Newer evidence / newer evaluation since …" flags                                         | `hazards.ts:1153-1227`                | generic, from the evaluation's input cut (step 1)                                     |
| Area control with an owner and an effective interval                                      | `hazard-controls.ts`, `hazards.ts:613` | control record (step 4), circle type (step 5)                                            |
| Map of occurrence positions                                                               | `HazardControlMap.tsx`                | the area-control type's editor (step 5)                                               |
| Disposition by the owner, optionally citing an effectiveness review                       | `hazards.ts:810-920`                  | `record.close` with an optional review reference (step 5)                             |
| Effectiveness reviews and monitoring windows                                              | migrations 0033, 0036                 | re-pointed to control records in step 5, made generic by the lost-link indicator and the generic monitoring window                  |

## 2. Target record shape

A hazard is an `sms_records` row of kind `hazard`, with subject kind `sms` (`sms-envelope.ts:430`).

- **Origin** (set at opening, never changed): one of
  - `finding {flightId, findingId, evaluationId, evaluationDigest, evaluation}`. The rule's leaf and binding ids and versions are kept as data; core code never branches on them.
  - `report {recordId, versionNumber}`.
  - `manual {}`.

  Opening from a finding keeps A's checks: the expected flight revision and basis (`validateBasis`), `stale_finding` when the evaluation is no longer the latest, and `hazard_already_opened` for the same evaluation. It also links the hazard subject to the flight subject (`linkSubjectDependency`), so the hazard's basis covers the flight. `body.source.kind` is derived from the origin.
- **Assessment**: `risk.assess` on the adopted matrix, as today. For a finding origin it also pins the evaluation reference and digest current at that moment, and is refused if that evaluation is not the latest.
- **Newer evidence** (generic): the pinned evaluation's `acceptedInputCut` is compared with the current head of each stream in that cut, and the latest evaluation of the finding is compared with the pinned one. The work-item check for pending projections stays. No query needs to know the observation type.
- **Controls**: separate records of kind `control`, each with a control type and version, typed parameters, an owner and an effective interval. The assessment lists control record versions instead of `{type, description}` (step 4).
- **Acceptance**: a `risk.accept` signature. Today the signed content binds the hazard version, the assessment and the matrix version. It will also bind each control version and the origin evaluation digest.
  **Rule:** every risk acceptance is signed by a person (principal kind `human`) who holds a covering `risk:accept:<level>`, with re-authentication. A flight-side dispatcher is no exception. Today A accepts from any principal kind (`hazards.ts:94-119`). Locally, the `local_fixture` grant covers tests (`apps/api/src/sms.ts:52-58`).
- **Disposition**: `record.close` and `record.reopen` with a note. Closing a hazard may cite an effectiveness review by digest.
- **Links**: `SmsLink` gains target kinds `flight` and `finding`. Opening from a finding writes a `derived_from` link to it.

## 3. One matrix, one acceptance-authority function

- **Matrix**: the organization's adopted `risk_matrix` record (`adoptedMatrix`, `sms-decisions.ts:103`). `risk-matrix.ts` is deleted in the cut. Fixtures and tests that score severity and likelihood as 1–3 move to the slugs of the example matrix.
- **Seed**: today `tenant-alpha` and `tenant-beta` have no `sms:*` or `risk:accept:*` capabilities (`packages/persistence/src/index.ts:389-412`).
  - The seed opens `exampleRiskMatrix` (`sms-example-matrix.ts`) for each of them and adopts it with a signature. It reuses the flow in `apps/api/src/seed-utility.ts:98-132`, moved into a shared helper.
  - The operator gains `sms:read`, `sms:write`, `sms:configure` and `sms:adopt`. The actor gains `sms:read`. (Revised when step 2 was built: no `risk:accept:*` capability is seeded for the flight organizations. An administrator grants acceptance authority to a named person, which is what the demo scenes and browser tests show.)
- **Authority**: one function, `coveringRiskCapability` (`sms-matrix.ts:41-49`). `satisfyingRiskAcceptanceCapability` (`hazard-controls.ts:26-38`) is deleted. A third copy in `apps/simulator/src/hazard-control-plan.ts:331` is replaced by an import.
- **Trap**: `getSmsProgram` reports a program as soon as any SMS record exists (`sms-reads.ts:377-380`), and `main.tsx:216` then shows `SmsApp` without flights. Seeding a matrix would therefore hide the flight application. Step 2 must stop counting `risk_matrix` records until step 3 removes the switch.

## 4. Fate of A

Everything listed is **deleted in the cut (step 5)** unless the table says otherwise. Until then A is frozen: no new features, and its API is kept for the fixtures of the avoidance and assurance chain.

| Item                                                                                          | Fate                                                                                                 |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `hazards.ts`, `hazard-controls.ts`, `risk-matrix.ts`, `contracts/src/hazards.ts` (524 lines)  | Deleted; the authority copy goes in step 2                                                              |
| Tables `hazard_openings`, `_views`, `_assessments`, `_controls`, `_risk_acceptances`, `_dispositions`, `_effectiveness_reviews`, `_effectiveness_review_projections` | Dropped                                                                                              |
| `mission-avoidance.ts` (reads accepted controls, `:66-125`), `mission-briefing.ts`, `mission-release-integrity.ts`, `simulation-avoidance-demo.ts` | Re-pointed to the accepted-control projection (step 5); generalised by controls as rules                              |
| `monitoring-window.ts`, `control-effectiveness-*.ts`, `assurance-history.ts`                  | Kept; foreign keys and queries re-pointed to control versions (step 5); generalised by the lost-link indicator and the generic monitoring window      |
| Decision packets                                                                              | Unaffected: `apps/api/src/decision-packets.ts` reads no hazard data                                  |
| Simulator `hazard-*.ts` (8 files) and their tests (4,693 lines in all)                        | Rewritten against envelope commands, with local re-authentication                                    |
| Web `SafetyWorkspace`, `HazardRecord`, `HazardForms`                                          | Replaced by the SMS register and record page (step 3)                                                   |
| Web `HazardControlMap`                                                                        | Becomes the area-control type's editor (step 5)                                                         |
| `tools/verifier` hazard checks                                                                | Updated (step 5)                                                                                        |

## 5. Interface

There is **one register** (the SMS register) and **one record page** (`SmsRecordView`).

- From a flight finding, "Promote to hazard" opens the hazard form with the origin filled in, then lands on the record page.
- Safety home reaches the same register and page.
- `main.tsx` stops choosing between two applications. One shell shows **Flights** to holders of `flight:read` and **Safety** to holders of `sms:read`.
- An organization that only flies sees Flights and a Safety section holding its hazard register and its adopted matrix. Documents and reports appear only once it creates them.

## 6. Order of work and migrations

**Proposed order: steps 1 → 2 → 3 → 4 → 5 (the cut).** This keeps every step green: until step 5, the old tables still serve avoidance, monitoring and effectiveness.

| Step  | Content                                                           | Migration                                                                                                                                                                                                                                                                |
| ----- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Typed origin, evidence pins, generic newer-evidence; API first    | **M1 hazard origins**: immutable origin table, unique on (tenant, flight, finding, evaluation), RLS, no-mutation trigger                                                                                                                                                 |
| 2     | One authority function, seeded matrices, program-switch fix       | none                                                                                                                                                                                                                                                                     |
| 3     | One shell, register and record page; A dropped from the finding UI | none                                                                                                                                                                                                                                                                     |
| 4     | Control records and the type registry                             | **M2 control records**: `sms_records.kind` adds `control`; an `accepted_hazard_controls` projection indexed on the effective interval                                                                                                                                       |
| 5     | Circle type and **the cut**                                       | **M3 retire flight hazards**: drop A's tables; redefine the trigger functions from 0026, 0027, 0029-0033, 0036, 0037 and 0039; re-point the foreign keys in 0033:14-15 and 0036:77-90; narrow `decisions_target` (0040:2-19); refuse to run while A holds rows      |

Later work: controls as rules, the lost-link measure as an indicator and the generic monitoring window depend on step 5. The generic evidence packet depends only on step 1.

## 7. Risks and open questions

1. **Gap from step 3 to step 5**: area controls can be created only through the API. The alternative is to run steps 4 and 5 before step 3.
2. **Hosted demos**: hosted simulator actors cannot sign, because the local grant needs a `ledger-dev-` token in local or test (`sms.ts:52-54`). Should risk acceptance be a person's step in hosted demos?
3. **Who may close a hazard**: only the owner (A, `hazards.ts:820`) or any holder of `sms:write` (B)? Recommendation: the owner.
4. **Precision of newer-evidence**: the generic check is coarser, because any newer event on a stream the rule read counts. Is that acceptable?
5. **Old rows at the cut**: should M3 fail while A rows exist (recreate local databases), or delete them?
6. **Capability names**: flight organizations would use the `sms:*` names. Keep them, or rename them?

## 8. Rough size

| Step  | Files touched                                                                                                                        | Tests affected                                                                                                                                                             |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | ~14: contracts `sms.ts` and the generated API, domain envelope, decisions and reads, a new origin module, API, migration, evidence export, 2 web | `sms.integration` (12 tests) plus about 6 new; `sms-envelope` unit; contracts                                                                                             |
| 2     | ~7: `hazard-controls.ts`, `hazards.ts`, persistence seed, seed helper, `sms-reads.ts`, simulator plan                                | `tests/unit/hazard-controls.test.ts` (2); the authority cases in `hazards.integration` (10 tests in all); specs that sign in as alpha or beta                               |
| 3     | ~16 web files (21 import the A safety modules)                                                                                       | `tests/unit/safety.test.ts` (5); browser `safety.spec` (988 lines), `sms.spec`, `operations.spec`, `findings.spec`; re-recorded demo scenes                                |
| 5     | the bulk                                                                                                                             | 60 test files mention hazards and 29 call hazard routes, commands or tables; `hazards.integration.test.ts` alone is 3,260 lines                                            |

## 9. Reviewer rulings

The recommendation is accepted: the safety-program hazard is the one hazard, and the flight-side hazard is retired in a clean cut. The open questions in section 7 are settled as follows; where this section differs from the sections above, this section governs.

1. **Order.** Steps 1 → 2 → 4 → 3 → 5 → retirement. Control records and the type list (step 4) land before the single workspace (step 3), so the new record page has typed controls with generated forms from its first day. Only the circle and its map editor are missing between steps 3 and 5; in that window area controls are created through the API in tests.
2. **The cut is its own step.** Step 5 ports the circle as a control type, with its map editor, and makes route avoidance read accepted control records. A separate step, "Retire the flight-side hazard system", then re-points monitoring, effectiveness and assurance history to control records, rewrites the simulator's hazard actors and the tests that drive the old API, deletes the old modules and adds migration M3. The lost-link indicator and the generic monitoring window depend on the retirement; controls as rules depends on step 5.
3. **Hosted demonstrations.** Risk acceptance is always signed by a person with re-authentication. Simulated actors may sign only where the local fixture grant exists (local and test). Anywhere else it is a person's step.
4. **Closing a hazard.** The owner closes it, as recommended. Changing the owner is an ordinary revision by someone who may write safety records.
5. **Newer evidence.** The coarser, type-agnostic check is accepted: asking a person to look again is the safe direction. The record page must list which records are newer, so the prompt is not noise.
6. **Old rows at the cut.** M3 refuses to run while the old tables hold rows, with a message that says to recreate the database. Nothing is deployed, CI databases are fresh, and local and test databases are disposable. It never deletes rows.
7. **Capability names.** Flight organizations use the existing `sms:*` names. No rename.
8. **The application switch.** Accepted as described in section 3: step 2 stops a risk-matrix record alone from switching an organization to the safety application, and step 3 removes the switch.

**Order revised when step 4 was built.** The switch of the flight finding screens to the single workspace (step 3) moves later, so that nothing a person can do today disappears in between: the circle control type (step 5) first, then the generic monitoring window and the lost-link measure as an indicator (which needs the lost-link rule on the generic evaluator), then step 3, then the retirement. Until step 3, the flight-side screens keep working beside the safety record, and route avoidance reads accepted area controls from both.
