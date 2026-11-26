# Submitting a safety report

Status: built. Code: `packages/domain/src/safety-report-submission.ts` (submission, receipts, links), `apps/api/src/safety-report-submission.ts` (routes, the concurrency bound), `requestLogLine` in `apps/api/src/index.ts` (the request log, with `isWebAppRequest` in `apps/api/src/web-app.ts`), `packages/contracts/src/safety-report-submission.ts`, `apps/web/src/SafetyReportSubmission.tsx` (the dialog and the link's page) and `ReportLinks` in `apps/web/src/SmsReports.tsx`. Migration `0086_safety_report_submission.sql`. Tests: `tests/integration/safety-report-submission.integration.test.ts`, `tests/unit/first-steps.test.ts`, `tests/browser/safety-report-submission.spec.ts`.

## The question

Until now a safety report reached Ledger only when a person cleared to read reports recorded it as received. Nobody else could put one in. An organization needs a way for anyone who works for it to report a safety concern themselves, in confidence, and a way to report without being identified at all.

This note says what each of the two ways keeps, where, and who can read it. "Confidential" and "without a name" are claims about the whole system, not only about the report record, so every place a submission touches is listed: the report record, the journal event, the submitter's receipt, the request log, the rate-limit state and every export. What Ledger cannot control is listed too, as the deploying organization's responsibility.

## Who must not learn what

| Who | Must not learn |
|-----|----------------|
| People in the organization who are not cleared to read reports, including administrators | What a report says, and who sent it |
| People cleared to read reports | Who sent a report that was sent without a name, beyond what the reporter wrote in it |
| Anyone reading the journal, an export or the request log | Who sent any report, and what it says |
| A database administrator | Who sent a report sent without a name. (They can read what a report says: see below.) |
| Someone who finds a receipt code | Anything but whether that report is received or closed |
| Someone who finds a reporting link | Anything already reported; they can only send a report |

Ledger does not protect a report's content from a person who administers its database or its servers: the content is stored as text in PostgreSQL, readable by the database owner, as every other record is. Protection from the database administrator is about the reporter's identity only.

## The two paths

### 1. Signed in, with or without a name

Any active person of the organization (any principal of kind `human`, with or without any permission) can submit a report from any screen: **Report a safety concern** in the top bar. The form asks what was seen, when and where, and offers **Put my name on this report** (off by default) and an optional way to reach the reporter. Attachments are not taken; the form says so. The form is a modal dialog: Escape or **Close** closes it without sending, and what the person typed stays in the page's memory, never in browser storage, so opening it again shows the draft with **Discard** to clear it. Reloading or leaving the page loses it. **Send report** is different: what is sent is first kept on the device until Ledger acknowledges it, so a report sent without a connection is sent when the connection returns, under the same person's sign-in, and its content is deleted from the device the moment Ledger has it (`offline-entry.md`).

`POST /v1/safety-reports`, signed in. The API uses the signed-in person for two things only, and only in memory: to know which organization the report goes to, and, when they ticked the box, to copy their display name into the report's protected content. The transaction that writes the report runs as the organization's **reporting channel** (below), not as the person: the person's id is never a parameter of any statement it runs.

### 2. Through a reporting link, without signing in

A person who may configure safety records (`sms:configure`) issues a **reporting link** on the Safety reports screen: a label people recognise ("Hangar crew room poster"), and optionally an expiry. Ledger makes a 32-byte random token, returns it once, and keeps only its SHA-256. The link is `https://<your Ledger>/report#<token>`. The token is in the fragment, after `#`, which a browser never sends to a server: the page's own request (`GET /report`) carries no token, so neither Ledger's request log nor a proxy in front of it sees it.

The page needs no sign-in. It asks only what was seen, when and where, and optionally a way to reach the reporter, marked optional and "visible to the people cleared to read safety reports". It says attachments cannot be sent. It posts the token in the request body to `POST /v1/safety-report-links/submissions`.

A link is revoked at once by the same permission (`POST /v1/sms/report-links/{id}/revoke`), and refused after its expiry. A revoked, expired or unknown link gets one answer, 404 "This reporting link is not in use", so the page cannot be used to tell them apart.

## The reporting channel principal

Every organization has exactly one principal of the new kind `intake`, named **Safety reporting channel** (id `safety-reports-<organization id>`). The migration adds one to each existing organization, and a trigger adds one to every new organization. It:

- holds no permission and can never hold one (a database check: `capabilities` is empty);
- cannot sign in or hold a credential (a check: no sign-in issuer or subject; `ledger_authenticate` never returns it; `credential.issue` already refuses anything but a source or a service; `authority.update` refuses it);
- is not listed on the People screen.

It is the journal principal of every submitted report, on both paths, and the actor, the opener and the owner of the record. So the journal, the record and the command record say the same thing for a signed-in person with or without a name, and for a link: the report came through the channel. Whether a signed-in person put their name on it is in the protected content only.

## What each path keeps

| Place | Signed in, without a name | Signed in, with a name | Through a link |
|-------|---------------------------|------------------------|----------------|
| `sms_records` (register entry) | Kind `report`, title "Safety report recorded YYYY-MM-DD", status `received`; owner and opener: the reporting channel | same | same |
| `sms_restricted_record_versions` (protected content) | What was seen, when, where, the optional contact, `received.channel = submitted_signed_in`, the time received and, when the device gave one, the time it was written by the device's clock (`received.writtenAt`); the title "Safety report submitted in Ledger"; a random salt and the salted digest; actor: the reporting channel | as left, plus `reporter.name`, the person's display name | as left, with `received.channel = submitted_link` and the title "Safety report submitted through a reporting link" |
| `subjects` | The same date title | same | same |
| `journal_events` | One `sms.record.open` event, principal: the reporting channel. Its payload is the record's shape and the salted content digest, never the text, as for every protected record | same | same |
| `command_records` | The same payload; actor: the reporting channel | same | same |
| `idempotency_keys` | Only when the device sent an `Idempotency-Key` (an entry sent from the device's outbox, `offline-entry.md`): the key, under the reporting channel and never the person, the report's id, and a digest of the key and the report together, so the row cannot confirm a guess at the content. No time. A repeat with the key records nothing and is answered 409 `safety_report_already_received`, without the receipt code. Without a key, a retried submission makes a second report, which a reader closes as a duplicate | same | Nothing: the link's page takes no key |
| `safety_report_receipts` | The SHA-256 of the receipt code and the report's id. No time, no principal | same | same |
| `safety_report_links` | Nothing | Nothing | The link's row is updated: the start of its current rate window and the count in it. Nothing about the sender |
| Input `receipts` (what sources send) | Nothing: a report is not a source input | same | same |
| Object storage | Nothing: attachments are not taken | same | same |
| API request log | One line each when the request starts and ends: method, path, status and duration, with no address, port or user agent | same | same; the token is never in a path. When the API serves the web app, the report page (`/report`) and every file it loads (`/assets/...`) are logged the same way |

The link's id is not kept on the report: a link issued to one crew narrows who sent it, so the report says only "through a reporting link".

### The receipt

The reporter is shown a receipt code once, after the report is stored: 20 characters from an alphabet without look-alike characters, in five groups of four, 100 random bits (`RK7Q-2MXD-9PJA-4TZC-H8WN`). Ledger keeps only its SHA-256. Anyone holding the code can ask `POST /v1/safety-reports/receipt` (no sign-in; the code is in the body, never in a path) and is told only `received` or `closed`. No date, no record id, no content, no name. A code that matches nothing gets 404. The code cannot be shown again.

The same request answers both paths, so a person who submitted signed in checks it the same way, on the same page (`/report`, opened without a link).

### Rate limits

A link takes at most 20 reports in an hour. The count is kept on the link's row (`window_started_at`, `window_count`), not per address: Ledger never sees or keeps the sender's address for this route. The 21st report in the hour is refused with 429 "This reporting link has taken many reports in the last hour. Try again later, or tell your safety lead in person." Someone holding the link can use that to block it for an hour; the organization revokes the link and issues another.

Across one API process, at most four requests on the three routes that record no person (the two submissions and the receipt check) run at once; more get 429. Each of these routes takes a body of at most 32 KiB.

Signed-in submissions are not counted per person: counting would keep the person's id beside a time.

## Who can read what

| What | Who |
|------|-----|
| What a report says, including a name or contact | People with `sms:report:read`. Each reading is retained, as it already is |
| That a report was received, its date title and status | People with `sms:read`, on the Safety reports screen |
| Whether a report is received or closed | Whoever holds its receipt code |
| The reporting links: label, who issued it and when, expiry, revoked or not | People with `sms:configure` |
| The links in force, by label and expiry | People with `sms:read`, on the Safety home, under "Who receives safety reports" |
| A link's rate-window count | Nobody through the API; the database administrator |

## Exports

- **A safety records export** (`POST /v1/sms/exports`) of a report or a period: the register entry, the channel as owner and actor, and each version's salted digest. The content is withheld, as for every protected record, and the export says so.
- **A records production** (`.zip`): never includes safety reports.
- **A flight, finding or decision packet**: a report is in one only if a hazard cites it, by id, version and salted digest.

None of them can name a sender who did not put their name in the report.

## What a database administrator can and cannot learn

They **can**: read every report's content, including a name or contact the reporter gave; see when each report was stored, to the microsecond; see how many reports came through each link in its current hour; see which links exist and who issued them.

They **cannot**, from the database: learn which person submitted a report sent without a name, on either path. No row written by a submission holds the person's id, their name, their address or their browser. The integration test for this submits as a fresh person and then searches every table for that person's id and name, and finds them in no row written since.

They **might**, by inference outside what Ledger stores: compare the time a report was stored with the times of the same person's other records, or with the request log of their other requests. In a small organization, what a report describes may itself say who saw it.

## What Ledger cannot make true

These are the deploying organization's responsibility. The deployment guide says so.

- **A reverse proxy, load balancer or TLS terminator in front of Ledger keeps its own access log**, usually with the address, the user agent, the time and the path of every request. For these routes the path holds no token (it is in the fragment or the body), but the address and user agent are there. Configure the proxy not to log them for `/report`, `/v1/safety-reports`, `/v1/safety-reports/receipt` and `/v1/safety-report-links/submissions`.
- **The web app's files served by something other than the API.** When the API serves the web app (the image does, with `LEDGER_WEB_DIR`), its request log keeps no address or user agent for the report page or any of the web app's files. A web server or content network that serves them instead keeps its own log, as a proxy does.
- **A signed-in person's other requests** carry their address in the request log as usual; a log reader who knows a report's time could look for that person's requests around it. A person who wants more distance uses the reporting link, from a device and network that are not the organization's.
- **The reporter's own device** keeps the link, fragment included, in its browser history.
- **Wherever the link is published** (a poster, an email, a chat) is the organization's choice.
- **PostgreSQL's own logs**, if statement logging with parameters is on, hold report text (not the sender). Leave it off.
- **What the reporter writes.** Naming themselves, giving a contact, or describing something only they saw identifies them. The form says the contact is optional and who can see it.

## Lock order

Both submissions run as the reporting channel: 0 the channel's `principals` row SHARE (`withScope`) → [6 the link's row UPDATE, link path] → 6 stream (`appendEvent`) → 5 the new record's subject (no other transaction can see it). Issuing a link: 0 caller → 6 stream → the new link row. Revoking: 0 caller → 6 the link row UPDATE → 6 stream.
