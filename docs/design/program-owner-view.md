# A program owner's view of the operators it contracts

Status: built. Migration 0093. Builds on links to produced records (`shared-links.md`), the webhook's secret and the outbound calls of notices (`notices.md`), coverage by rule (`rule-coverage.md`), the open findings (`finding-work.md`), the reports (`reports.md`) and the lock order (`lock-order.md`). Paths are relative to the checkout.

An organization that hires operators, a utility with contracted inspection crews for example, wants to see how each of them stands. Each operator runs its own Ledger, so the program owner and its operators are usually on different deployments. Where two organizations share one deployment, the same path is used.

## The decision: a grant read over the network, never by the database

Row-level security is never widened and no query reads another organization's rows. An operator's Ledger answers a narrow read to whoever presents a grant's secret. The program owner's Ledger asks, keeps what it was told, and shows its operators side by side. On one deployment the program owner's worker calls the deployment's own public address, exactly as it would call another one.

Considered and left out:

- **A cross-organization view inside one database** (a policy that lets the program owner read the operator's coverage). It would widen row-level security, the one rule every table keeps, and it would not work across deployments, which is the common case.
- **A file the operator produces and the program owner imports.** That already exists for records. It is stale the moment it is made, and nothing stops it being kept after the arrangement ends. A grant answers counts as of the moment of the read, and stops answering when it ends.
- **The program owner's Ledger signing in to the operator's.** A credential is a member of the organization and reaches every route its capabilities allow. A grant reaches one route and the parts it names.

## What crosses, and what never does

The operator names exactly what a grant covers, from this list and nothing else:

1. **The coverage of named packs**: for each pack the organization has adopted and the grant names, each rule's own name and citation, how it is checked, and how many subjects are in each result (`supported`, `attention`, `no_record`, `pending`, `not_applicable`, `relieved`, `other`, `not_evaluated`), counted by the same code as the Rules screen (`getAdoptionRuleCoverage`). The adoption that stands now, the highest version first, is the one read; a named pack no longer adopted is sent with no version and no rules.
2. **The open findings by rule**: for each rule, how many counted findings are open and when the oldest one opened, with its age in days, grouped by the same code as the open findings list (`groupOpenFindings`, the counted tab: active adoptions, nothing a waiver relieves).
3. **Named produced sets**: each as an ordinary link to that set, of the kind that already exists, made with the grant and ending with it.

The answer is one document, `ledger.program-view.1` (`packages/contracts/src/program-view.ts`): its version, the operator organization's name, when it was made (UTC), the grant's expiry, and the parts granted. Every number is a count of recorded things, as the reports count them.

Never in it: a subject's id or name, a record or a value, a person's name, a finding's id or summary, and the content, title or existence of a safety report or any other restricted record. A safety report is not a rule result and no part reads the safety records at all. A produced set never holds safety records or restricted files (`shared-links.md`), and the document carries only the set's time, its record count and its link, not its reason or who asked for it, since those are free text that may name a person. `tests/integration/program-view.integration.test.ts` fills an organization with a safety report, people with distinctive names, subjects and record values with distinctive ids, and a produced set asked for by a named person, and checks that the document holds none of them, that it holds nothing but the keys the contract lists, and that its coverage counts are the Rules screen's.

## The operator's side: a grant

Whoever manages authority (`authority:write`) makes a grant on **Reports**, **Shown to program owners** (`/reports/grants`), naming the program owner in their own words, the period (ninety days unless they choose, a year at most) and the parts.

- **The secret.** 32 random bytes, written `ledger-program-` and base64url, returned once in the answer that makes the grant. `program_grants` keeps only its SHA-256, which is unique and is how a grant is found; the API's role cannot read the hash back.
- **The produced sets.** Each named set gets a link in `record_production_links`, marked with the grant (`program_grant_id`), expiring when the grant does. A link's own limit is ninety days; a grant's link may run as long as its grant. Its secret is derived from the grant's: `ledger-records-` and the base64url of HMAC-SHA256 keyed with the grant's secret over `record-link:<link id>`. Only its SHA-256 is kept, as for any link. Each read recomputes it from the secret it was given, so the operator's Ledger never keeps a secret it could read back, and the program owner receives a link that works without a second secret to manage. The link shows on the set's own screen with its note, `For <program owner> under a program grant`, and its openings, and can be revoked there on its own.
- **Revocation** is at once and once, with the person and the reason, and revokes the grant's links in the same transaction with the same reason.
- **The read.** `POST /v1/program-view` takes the secret in its body, needs no sign-in, and is outside the signed-in API. It carries `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex` and `nosniff` on every answer, refusals included, and the request log keeps only its method and path. An unknown, expired or revoked secret answers `404 program_grant_not_in_use` with one message. The lookup is `ledger_program_grant`, a security-definer function that reads across organizations by the hash alone; the parts are then read inside the operator's own scope, as its worker principal, under its row-level security, with the same functions its own screens use. The read is kept by `ledger_program_grant_read`, which finds the grant again `FOR KEY SHARE`, so a revocation in progress is waited for and a revoked grant keeps no read and answers the same 404.
- **Each read** is a row in `program_grant_reads`, append-only: when, and which parts were read (`pack:<id>`, `open_findings`, `records:<production id>`). Ledger keeps no network address or other fact about the caller.
- **Journal events** `program-grant.create` and `program-grant.revoke` on the stream `program-grant:<id>` record who made the grant, for whom, for how long, what it covers and the links made with it, and who revoked it and why. The secret is in neither.

The screen lists the grants, newest first, with their state (in force, expired, revoked), what each covers, who made and revoked it, and its reads, newest first.

## The program owner's side: an operator it follows

Whoever manages authority adds an operator on **Reports**, **Operators you follow** (`/reports/operators`): a name of their own choosing, the address of the operator's Ledger (the address its people open it at), and the secret they were given.

- **The secret** is kept as the webhook's is: the API's role may insert it and never reads it back; only the workers' role reads it, to make the call. Removing the operator erases it.
- **The address** must be `https://` outside `LEDGER_ENV=local`, and outside a local Ledger may not name `localhost` or an IP address in a loopback, private, link-local or unspecified range. It is checked when the operator is added and again before each call.
- **The call** is made only by a fenced worker, never by the API: a leased row per operator in `program_operator_schedules`, read hourly. A person who asks for a fresh read sets that row due now, which queues the same work. The call is `POST <address>/v1/program-view` with the secret in the body, a 10-second limit, no redirect followed (a redirect is recorded as a failure), and at most 1 MiB of answer, counted as it arrives. The answer must be a `ledger.program-view.1` document by the contract's schema.
- **Every answer** is a row of `program_operator_answers`, append-only: when it was read, the outcome (`answered`, `not_in_use` for the operator's uniform 404, `failed`), and for an answer the document with the SHA-256 and length of its bytes as received; for a failure a reason of at most 300 characters, in words, never the answer's own text.
- **Removal** is recorded with who removed the operator and why; its answers are kept and it is read no more.
- **Journal events** `program-operator.add` and `program-operator.remove` on the stream `program-operator:<id>` record the name, the address and who added or removed it. The secret is in neither.

## The view

`/reports/operators` lists the operators the program owner follows, in alphabetical order of its own names for them, side by side: when each was last read, the grant's expiry, each pack's rules with their counts by result, the open findings by rule with the oldest one's age, and the links to the produced sets. There is no score, ranking, rating or verdict word. Every count is shown with the time it was read.

A row is one of:

- **Read**: the last read answered and the grant is in force.
- **Not read lately**: the last answer is more than two hours old; the counts are shown as of that time and say so.
- **Last read failed**: the reason, and the last answer with its date, never as current.
- **Grant ended**: the operator's Ledger answered that the grant opens nothing, or the last answer's expiry has passed. The last answer is shown with its date.
- **Not read yet**.

The page follows the themes, prints and works at 375 px. Reading it needs `evidence:read`, so a Reader opens it; adding and removing operators needs `authority:write`.

## Recorded on both sides

- The operator has the grant, its revocation and every read.
- The program owner has the operator's registration, its removal, and every answer and failure.

When a grant ends, the operator still sees the grant, its state and its reads; the program owner still sees every answer it was given, the last one under "Grant ended" with its date, and its links stop opening.

## Threats considered

- **A guessed secret.** 256 random bits; a guess is not practical. Unknown, expired and revoked secrets get one answer, so a guess learns nothing about which grants or organizations exist.
- **A leaked secret.** It opens counts, never subjects, records or safety reports, until the grant expires or the operator revokes it, at once. Every read is recorded with its time, so an unexpected reader shows as reads at hours the program owner's worker does not keep. On the program owner's side, only the workers' role reads the secret, the API never returns it, and removal erases it. A snapshot it keeps holds the links' secrets, which open the named sets only until the grant ends.
- **A program owner's Ledger made to call an address it should not.** Only a person with `authority:write` sets the address. The call goes to one fixed path, with no redirect, a time limit and a size limit; outside a local Ledger the address is `https` and may not be a loopback, private or link-local address literal. The answer is kept only if it is a program view document, and a failure is recorded in words of Ledger's own, never with the answer's text, so the call cannot be used to read another service's answers through the view. A host name that resolves to an internal address is the deployment's network to restrict (egress rules), as for the webhook.
- **A stale answer shown as current.** Every count is shown with the time it was read. A row whose last read failed, whose grant ended, or whose answer is more than two hours old says so in words and shows the last answer with its date.
- **An operator's name learned by someone without a grant.** The read route answers a secret it does not know exactly as an expired or revoked one, and its answer depends on nothing else, so nobody learns that an organization exists from it.

## Lock order

- Making a grant: 6 the grant's stream → new `program_grants` and `record_production_links` rows (no other transaction can see them).
- Revoking a grant: 6 the `program_grants` row `FOR UPDATE` → 6 its links' rows `FOR UPDATE`, in id order → 6 the grant's stream.
- Keeping a read (`ledger_program_grant_read`): the grant's row `FOR KEY SHARE`, which waits for a revocation holding it, then a new `program_grant_reads` row.
- Adding an operator: 6 its stream → new `program_operators` and `program_operator_schedules` rows.
- Removing an operator: 6 the `program_operators` row `FOR UPDATE` → 6 its stream.
- Asking for a fresh read: 8 the operator's `program_operator_schedules` row, by `UPDATE`, and nothing after it.
- The worker (`readLeasedProgramOperator`): reads under the lease, calls outside any transaction, then 8 its own `program_operator_schedules` row → a new `program_operator_answers` row, whose foreign key takes the operator's row `FOR KEY SHARE` and so waits for a removal holding it. An answer that arrives as the operator is removed is kept; the next pass reads it no more.

## Not done here

- A program owner who follows many operators reads each one hourly, one call at a time per worker pass. A large program would want the period to be a setting.
- The grant's document has one version. A later version would be added beside it in the contract and the program owner's Ledger would read both; nothing reads an unknown version.
