# Notices

Design note. Migration 0090. Builds on finding work (`finding-work.md`), safety assurance records (`assurance-records.md`), the document distribution in `sms-documents.ts`, the worker queues and the lock order (`lock-order.md`).

## What was missing

Assigning a finding recorded the assignment and told nobody. The only signals were counts on screens a person had to open. Ledger now tells a person, by email, when something becomes theirs or falls due, and tells an organization's own systems the same through a webhook. Both are off unless configured.

## The notices

| Kind | When | Written |
| --- | --- | --- |
| `assigned` | A finding is assigned to a person, or a signature sets an action for a person who did not hold it in the previous signed version | In the transaction that records the assignment or the signature |
| `due` | An open action of the person's (a finding's action, or a safety assurance record's) is due within three days | By the periodic worker, once per action and due day |
| `overdue` | Such an action is past its due day | By the periodic worker, once per action and due day |
| `acknowledgement` | A document is issued or distributed to the person to acknowledge | In the transaction that records the issue or the distribution |
| `digest` | Daily, or weekly on Mondays, for a person who asks: what is assigned to them, what is due within seven days and overdue, what waits for their acknowledgement | By the periodic worker, once per person and day, from 06:00 in the organization's time zone |

No notice repeats by itself; the digest is the repeat. A digest with nothing in it is not written. A person who assigns something to themselves, or signs an action they own, gets no email about it; the webhook still hears of it.

## The outbox and the exactly-once key

`notices` is the outbox, append-only. A notice is one person, one channel and one key: `UNIQUE(tenant_id, channel, recipient_id, key)`, written with `ON CONFLICT DO NOTHING`. The key names the cause and never the time of writing:

- `finding.assigned:<finding>:<treatment>`: the treatment is a journal event, so a retried command (the same idempotency key replays the first command) writes nothing new.
- `action.assigned:<record>:<action>:<signature decision>`.
- `document.acknowledgement:<issue>`: one per reader of that issue.
- `action.due:<item>:<due day>` and `action.overdue:<item>:<due day>`, where the item is `finding:<id>` or `assurance:<record>:<action>`: a second pass, a second worker or a restart writes nothing; a new due day is a new notice.
- `digest:<daily|weekly>:<day>`.

The notice's content is fixed when it is written: the organization's name and time zone, the event, who did it, the record (label, id, reference, title, path; a finding's reference is its subject in the organization's own id beside the name its records give it, and its title is its rule's title, as the open findings list names it), the action id and the due day or instant. The text of an email and the body of a webhook call are made from it when it is sent, with the deployment's public address in front of the path. A safety report, and a record whose confidentiality is not ordinary, is written with its reference and path only; its title is null and nothing of its content is read. An action's text is not carried.

Writing a notice never blocks or fails its cause. A person with no address, a person who turned that kind off, an organization without a webhook, or a Ledger without a mail server simply writes no notice. Email notices are written only while the deployment has a mail server, so configuring one later does not send a backlog.

## Sending

Each notice gets one `notice_deliveries` row, the sending queue, leased like the other queues (`ledger_lease_notices`). A worker reads the notice while it holds the lease, sends it, and then, in a transaction that locks its own queue row and checks the lease again, inserts one `notice_attempts` row: the attempt number, its time, the outcome (`sent`, `failed`, `given_up`) and on failure a reason of at most 300 characters. Attempts are rows, never updates. After a failure the notice waits 1 minute, 5 minutes, 30 minutes, then 2 hours; the fifth failure is recorded as `given_up`. A notice that cannot be sent at all (the organization removed its webhook, an address is no longer https outside a local Ledger, the Ledger no longer has a mail server) is given up at once with that reason.

A worker that lost its lease records nothing; another worker sends the notice. The send itself is outside the database, so a worker that sent and then lost its lease before recording means the notice is sent twice. That is the one way a notice is sent more than once: the record of it exists once. The lease is 60 seconds, against a 10-second limit on each call.

The administrator's list reads a notice's state from its latest attempt: none is `waiting`, otherwise the attempt's outcome.

## The periodic pass

`notice_schedules` holds one row per organization, made the first time a worker looks (`ledger_lease_notice_schedules` adds the rows of new organizations). A worker leases an organization's row, writes its dated notices and digests, and sets the next pass 15 minutes on, all in one transaction that checks the lease before commit. The pass reads findings, assurance actions and document issues without locks.

## Who gets what

- A person's address and choices are in `notice_settings`, one row per person, changed by the person on the account panel or, for the address only, by an administrator on the People screen. Each change is a journal event (`notice.settings`) that records whether an address is kept and the choices, never the address, so an address can be removed for good. Without a row, every kind is on and there is no digest, but nothing is sent without an address.
- The webhook in `notice_webhooks`, one per organization, set by an administrator (`authority:write`). It receives every notice but the digest, for every person, with the person's id and never an email address. Its secret is 32 random bytes, shown once in the response that makes it. The API's database role may insert it but has no SELECT on the column; only the workers' role reads it, to sign. Setting the webhook again makes a new secret. The journal event (`notice.webhook`) records the address and who set it.
- An http:// webhook is refused outside `LEDGER_ENV=local`, when it is set and again when it is sent.

## Locks

- **Changing notice settings**: 0 caller → 6 the `notice_settings` row (upsert) → 6 stream `notices:<person>`.
- **Setting the webhook**: 0 caller → 2 advisory `notice-webhook|<tenant>` → 6 stream `notices:webhook` → the `notice_webhooks` row.
- **Writing a notice inside a command** (`finding.treat`, a flight's decision treating a finding, `finding.treat-many`, a safety-record decision): reads only, then inserts new rows into `notices` and `notice_deliveries` with `ON CONFLICT DO NOTHING`, like a queue row (group 8). For a finding on a flight the flight's hook (group 7) runs after it; that cannot close a cycle, because no other transaction waits for a notice row this one inserts: the only one that could write the same key is a retry of the same command, which the idempotency key already holds back. The insert takes `FOR KEY SHARE` on the recipient's principals row; as with the other late principals locks, the only writer of that row takes no later group.
- **Sending** (`sendLeasedNotice`): 8 own `notice_deliveries` row → insert into `notice_attempts`.
- **The periodic pass** (`processNoticeSchedule`): 8 own `notice_schedules` row → reads → 8 inserts.

No new lock is taken in a place a command already takes it, so no ordering test was added.

## Not done here

- A sent notice is not shown on the history of the record it is about. Each record's history is its own projection (a flight's timeline, a safety record's versions and decisions, a finding's treatments); adding a kind of entry to each is more than a small change. The administrator's list shows every notice with the person it is for, the reference and title, and a link to its record.
- No notice is sent when a hazard's or another safety record's owner changes, or for a document review that falls due. They fit the same outbox with a new key each.
- The mail server is one SMTP server for the whole deployment. There is no per-organization From address.
