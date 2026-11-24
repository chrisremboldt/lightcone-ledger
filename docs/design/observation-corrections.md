# Observation corrections

Status: built. Code: `packages/domain/src/observation-corrections.ts` (the three records), `packages/domain/src/observations.ts` (intake of a replacement, and every read), migration `0051_observation_corrections.sql`. Tests: `tests/integration/observation-corrections.integration.test.ts`.

## Purpose

An accepted observation is never edited. Afterwards a source or a person can say it was wrong, give a new one in its place, or say which Ledger subject it is about. Each of these is a new append-only record with its own journal event. Reads decide what is current, at the evidence cut they read at.

## The three records

| Record | How it is made | Stored as |
| --- | --- | --- |
| Replacement | An `observation` input with `replaces: <observation id>` on the intake envelope (not in any type's payload). | The new observation, with `replaces_observation_id`. |
| Withdrawal | Command `observation.withdraw` `{ observationId, reason }`. | `observation_withdrawals`. |
| Subject resolution | Command `observation.resolve-subject` `{ observationId, role?, ledgerSubjectId, reason }` for one observation; command `subject.alias` `{ sourceId, subjectKind, externalId, ledgerSubjectId, validFrom?, validTo?, reason }` for a source identity. | `observation_subject_resolutions`; an alias also adds an `aliases` row. |

Rules for each:

- A replacement comes from the same tenant and source as the observation it replaces. Its type may differ (a report sent under the wrong type is replaced by one of the right type).
- An observation is replaced or withdrawn once. Replacing or withdrawing one that is already replaced or withdrawn is refused (`observation_replaced`, `observation_withdrawn`); correct the replacement instead. Resolving the subject of one that is no longer current is refused too.
- A subject resolution names a Ledger subject of the kind the observation names. `role` is `subject` (default) or `secondarySubject`.
- Who may do it: `input:write` and the observation grant that submitting the observation needs (its type under its source). An alias needs `input:write` and any observation grant under its source. The record keeps the principal and the time.
- The intake envelope is not structure-pinned (only observation types are), so `replaces` is an optional envelope field and no type gets a new version. It is refused on every other input kind.

## Reads

`listObservations` is the one read of observations; the evaluator, the API and the operator record reads use it or the same tables.

- **Current by default.** Replaced and withdrawn observations are left out. `include=all` returns them too. Each returned observation carries `replaces`, `replacedBy` and `withdrawal { reason, recordedAt, recordedBy }` where they apply.
- **Current subject.** A Ledger-scope query matches each observation's current subject: the latest subject resolution for that observation and role, or the latest alias resolution for its source identity, else what intake resolved. A subject set by a record reads `resolution: 'record'` with its `resolutionId`.
- **Source-scope queries match the subject as submitted.** The source's own id does not change when Ledger learns which subject it means, so resolutions do not move observations between source identities. Replacements and withdrawals still apply.
- **At an evidence cut**, a correction counts only if its journal event lies inside the cut. A rule evaluation replayed at its recorded `inputCut` therefore reads what it read then.

No check kind contains replacement logic. The record kinds' former `replaces-<id>` source event id convention is gone; record reads may use `select: 'latest'` without seeing a replaced record (see `record-check-kinds.md` for the remaining reason to read operator records with `all`).

## Evidence cuts and re-evaluation

Each correction event lists what it affected (`affected`: type, version and every subject the observation was about before or after). Projection queues the generic evaluator for each adopted rule that reads that type, for every listed subject, old and new.

So that the cut of an affected subject includes the correction:

- A Ledger subject retains the correction event in its evidence dependencies. A subject an observation is attached to also retains the observation's own event.
- A source identity's cut (computed by the evaluator from the observations naming it) also takes the streams of withdrawals and replacements of those observations.

## Relation to aliases and identity links

- **Aliases are reused, not paralleled.** `subject.alias` writes an ordinary alias, so later observations naming that identity resolve at intake (`resolution: 'alias'`). The same command records an alias resolution so that earlier observations of that identity that were *unresolved* at intake are attached to the subject, inside the alias's validity. An alias for an identity already aliased to another subject of the kind, in an overlapping validity, is refused (`alias_exists`); resolve single observations instead.
- **Observations that were ambiguous at intake** are not attached by an alias; resolve them one at a time.
- **The latest resolution wins**, whether per observation or by alias.
- **`identity.link` (older flight evidence)** moves a receipt by changing its stored flight. It still refuses observation receipts; observations use the records above, which never change a stored row.
- **`evidence.correct`** stays the older path's correction. Bridging it, and `identity.link`, onto these records belongs to moving the landing and lost-link rules onto the generic evaluator.

## Open questions

- Aliases created with a flight (`aliases` on flight creation) do not attach earlier unresolved observations: they have no journal position a cut could check. Only `subject.alias` does.
- Detaching an observation from every Ledger subject (back to unresolved) has no record.
- Rule evaluation work triggered by a correction records trigger kind `observation`, with the correction's event id.
