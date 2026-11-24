# What a decision rests on

Status: built. Code: `readSubjectEvidence(…, { decision: true })` and `decisionFrontiers` in `packages/domain/src/cuts.ts`. Tests: `tests/integration/decision-basis.integration.test.ts`, the basis tests in `tests/integration/hazard-origins.integration.test.ts`.

## What a basis is for

A person decides on what a screen showed them. The decision pins that view as a **basis**: the subject's dependency closure (the subjects it rests on, through recorded edges), the frontier of every stream those subjects retain (stream and sequence, and how far each is projected), and the person's authority stream. The command carries the basis digest it was shown (`expectedDependencyBasis`, and for flight and organization commands the rendered cut); if the basis read at acceptance differs, the command is refused with `stale_basis` and the person reviews again. The accepted decision stores the manifest, its digest and the cuts it makes, and a packet or export proves that the stored digest is the digest of the stored manifest and that every event it cites lies inside the cut.

A basis therefore says: "nothing this decision rests on changed between what the person saw and what was recorded". It has to hold exactly what the decision rests on. Holding more refuses decisions for changes that are not about them.

## What is left out

Two kinds of stream are left out of every decision basis, at the point the manifest is built (the stored manifest is the narrowed one, so its digest is the stored digest and the verifiers check exactly what they did):

- **The organization's own rule evaluations** (the `rule-evaluation:` streams the organization subject retains). A flight depends on the organization through its rule selection, and so does anything that depends on the flight. An organization rule is evaluated again when a record it reads changes or its deadline comes (a periodic report rule at a month's end, a role assignment ending), and before this every such evaluation refused every decision on every flight, safety record and adoption. An evaluation is derived from records, not evidence; a decision that rests on an evaluation cites it by id (a finding treatment, a hazard's promotion, an assessment's evidence), and that citation is checked on its own.
- **Ledger's records of what is on file** (the streams of the `ledger.records-on-file` source, `on-file-checks.md`). They are written about the organization whenever a safety record changes; they are derived from Ledger's own safety decisions, which have their own records.

Everything else stays: the subject's own streams and those of every subject in its closure (a flight's reports, plans, telemetry and its own evaluations; a hazard's record, links and the finding's subject; the organization's adoptions, organization decisions and the observations and operator records about the organization), the edges, and the person's authority.

## Where the line is for each kind of decision

| Decision | Its basis holds | Left out |
| --- | --- | --- |
| Flight decision, finding treatment on a flight (`decision.record`, the timeline's `meta.dependencyBasis`) | the flight's closure: its streams and evaluations, the organization's adoptions, decisions and records about it | the organization's rule evaluations, records on file |
| Decision on a safety record, promotion of a finding (`readSmsBasis`, `findingBasis`) | the record's closure, including the finding's subject | the same |
| Adoption (`rule-pack.adopt`, the coverage read's `meta.dependencyBasis`) and organization decision (`adoption.review`) | the organization's closure: its adoptions and organization decisions, the observations and operator records about the organization, and the person's authority | the same |

An adoption and an organization decision are about the organization itself, so the line was drawn at what their screens show and decide on. The adopt form shows the packs, their rules and the adoptions in effect; the review cites one adoption by its revision and digest. Coverage counts are shown beside them, but neither command decides on them, and they move whenever any subject is evaluated. So the organization's records stay in the basis (a new record about the organization still refuses an adoption made without seeing it), and its evaluations do not.

What is not a person's decision keeps the whole closure: a rule evaluation's cut (it must see the records on file it reads), a flight's rule selection, the accepted-controls adoption Ledger assembles, and a mission release or departure record, which records the cut it was made at without a person's basis to compare.

## What a packet attests to

A decision packet and a subject export attest that the decision rested on the narrowed basis: every event inside its accepted cut was there, and nothing it rests on changed before it was recorded. They no longer attest to the organization's rule evaluations or records on file at that moment; a decision that rests on an evaluation names it. Bundles exported before this change carry whole-closure manifests; they still verify, since the verifiers check a manifest against its own digest and cut, but a bundle made from a newer decision and an older one are not comparable frontier by frontier. There are no users, so nothing was migrated.
