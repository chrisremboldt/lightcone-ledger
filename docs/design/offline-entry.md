# Entering records without a connection

Status: built. The browser spec `tests/browser/offline-entry.spec.ts` is written and not yet run. Code: `apps/web/src/outbox.ts` (what an entry is and the rules for sending it), `apps/web/src/outbox-store.ts` (the browser's database), `apps/web/src/DeviceOutbox.tsx` (sending, and the list of what waits), `apps/web/service-worker.js` and the `appShell` plugin in `apps/web/vite.config.ts` (installing the app and opening it without a connection), `apps/web/src/app-shell.ts` (registering it). Tests: `tests/unit/outbox.test.ts`, `tests/unit/service-worker.test.ts`, the device's sending path against the API in `tests/integration/operator-records.integration.test.ts` and `tests/integration/safety-report-submission.integration.test.ts`. On the server: the written time in `packages/contracts/src/operator-record-import.ts` and `packages/domain/src/operator-record-import.ts`, and the key of a signed-in safety report in `apps/api/src/safety-report-submission.ts`.

## The question

Three records are made where the flying happens: a preflight assessment, a flight record and a safety concern. The web app kept nothing on the device, so a form filled where there is no signal was lost when the person sent it. This note settles how such an entry is kept on the device and sent later, whom it belongs to, how sending it twice stays one record, which times it carries, and what is left on the device afterwards.

## What is in scope

The record form (`RecordForm.tsx`: every operator record type, which includes the preflight assessment, the flight record and every record type a pack the organization adopted declares, such as a checklist of its own) and the signed-in safety report (`SubmitReportDialog` in `SafetyReportSubmission.tsx`), for a person who is signed in. The public report page (`/report`, a reporting link, no sign-in) is unchanged: it keeps nothing on the device and needs a connection to send, as before. It has no person to tie an entry to, and keeping an anonymous report on a shared device would leave it for the next person to find.

## Opening the app without a connection

The web app has a manifest (`/manifest.webmanifest`) and a service worker (`/sw.js`), so a phone can install it and open it with no signal.

- The service worker keeps the app's own files only: the page, its scripts, styles, fonts and icons. It never keeps an answer from the API: nothing under `/v1/`, nor `/health` or `/readyz`, and nothing sent with an `Authorization` header. No record, list or person is kept by it. The rule is one function, `keeps`, in `service-worker.js`, and a unit test reads it.
- It does not keep the pages opened by a link someone was given (`/report`, `/shared`): those load from the network as before.
- A build lists the files the first screen needs; the service worker fetches them when it is installed. Files loaded later (a screen opened once) are kept as they are fetched. The PDF viewer's own files are not kept.
- Pages are fetched from the network first and fall back to the kept copy after a few seconds without an answer, so a person with a connection always gets the current version. Built files have their content's hash in their name and are read from the kept copy.
- A new version installs beside the old and takes over at once; the page in front of the person keeps running and loads the new version on its next load. The files of the version before are kept until the one after it installs, so a page still running the old version can load a screen it had not opened yet.
- The static demonstration build (`pnpm demo:build`) emits no service worker and no manifest, and registers none: it keeps nothing.

## Who an entry belongs to

The sign-in stays where it was: in the page's memory (`OpenIdSignIn.tsx`), never in storage. An ID token near its end is renewed through the provider's refresh token. What changes: when the provider cannot be reached at all (no connection), the renewal is tried again on the next request instead of ending the sign-in. A provider that answers and refuses still ends it.

So the rule is:

- An entry is written only by a person signed in on this device: the app was opened and signed in while there was a connection, and the page has stayed open since. The entry records that person's id, name and organization, read from `/v1/me` when they signed in.
- It is sent only under that same person's sign-in, and only to that organization. The API takes the tenant and the principal from the sign-in, never from the entry, so even a mistaken send could not record it as someone else; the device does not try.
- Reloading the page ends the sign-in, as it always has. Without a connection the app still opens, says how many entries wait on this device, and says they are sent once the person who wrote them signs in again. It does not show what they say. The person cannot write new entries until they sign in.
- When someone else signs in on the device, they are told only that entries of another person wait on this device, never what they say or whose they are; those entries are never sent under their sign-in and they cannot discard them.
- Signing out does not discard anything.

What was considered: keeping the sign-in on the device so a reload without a connection could still write entries. That would let anyone holding the phone write records in that person's name, and keep a credential in storage, which the sign-in has deliberately never done.

## How sending twice stays one record

When the form is first saved, the device makes a random key (`crypto.randomUUID()`) for the entry and stores the exact bytes it will send. Every attempt sends the same bytes with the same key.

- **A record.** The record form uploads its entry as a one-record JSON file and then commits that file, as it always has. The upload already takes an idempotency key (`POST /v1/uploads` with `key:create`, the bytes with `key:bytes`, the finalize with `key:finalize`): the same key gives the same upload and the same retained file, and the same key with other bytes is refused (`idempotency_conflict`, `immutable_object_conflict`). Committing the same file again records nothing new and answers that row `already_recorded`, with the record's id and receipt: intake keys a row by the file and the row. So the key the device makes is enough; nothing was added on the server for it. An upload left unfinished expires after a day (`upload_expired`); nothing can have been recorded from it, so the device makes a new key and sends again.
- **A safety concern.** `POST /v1/safety-reports` took no key: a retry made a second report. It now takes an optional `Idempotency-Key`. The key is kept under the organization's reporting channel, not the person (`idempotency_keys` has no time column), and the digest it is kept with is of the key together with the report, so it cannot be used to test a guess at what a report says. The same key with the same report records nothing new; with a different report it is refused (`idempotency_conflict`). The receipt code is shown once and Ledger keeps only its hash, so a repeat cannot give the code again: it answers 409 `safety_report_already_received`, and the device takes that as received. A report sent from the device whose first answer was lost therefore has no receipt code; the device says so. A report sent without a key is taken as before.

## Two times on the record

Each entry carries when it was written, by the device's clock (`writtenAt`), and the record carries when Ledger received it.

- **A record.** The JSON document the form uploads states `writtenAt` beside the record type. Intake adds one limitation to the record: "Written at T by the clock of the device it was entered on; Ledger does not check that clock." The received time is the record's receipt time, which the record's page shows with the time of day. No field was added to the record body, so no record type or pack digest moved; a JSON file imported by hand may state `writtenAt` too, and the record says the same.
- **A safety concern.** The report states `writtenAt`, which is kept in the report's protected content as `received.writtenAt` beside `received.receivedAt`, and the report's page shows both. It is protected like the rest of what the reporter wrote.

The device's clock is never used to place the record in time: a record's time is still the time its fields state, or when Ledger received it.

## What stays on the device

- An entry stays until Ledger acknowledges it or the person discards it. Where the person saves a form, the app says how many of their entries wait, and opens a list of them, each with what it is, when it was written, and Ledger's answer if it refused it, with Send now and Discard.
- When Ledger acknowledges an entry, its content is deleted from the device at once, a safety concern's first of all, before anything else is done with the answer. What may remain is a receipt: the kind of entry, its reference (the record's Ledger id, or the report's receipt code), when it was written and when the device had Ledger's answer, both by the device's clock. The person removes a receipt when they no longer need it; a report's receipt code is shown there until they do.
- Entries are kept in the browser's own database for this site (IndexedDB). Ledger does not encrypt them: anyone who can open this browser profile on this device can read them. The app says this where entries are listed. An organization that issues shared devices should use one browser profile per person.
- Each stored entry states its format (`format: 1`). A later version reads every format it knows; an entry in a format it does not know is kept, counted and never sent or discarded on its own, so a version change never loses an entry.

## When Ledger refuses an entry

An entry Ledger refuses is not dropped. A record refused row by row (a subject that no longer exists, a flight that meanwhile has a record of its own) or an answer such as 403 or 400 marks the entry refused, with Ledger's own words. The person corrects it, which saves new bytes under a new key (nothing was recorded under the old one), or discards it. An answer that says nothing about the entry (no connection, a time-out, 429, a 5xx, or 401 because the sign-in ended) leaves it waiting.

When the form is saved with a connection, the entry is sent at once. If Ledger refuses it then, the form shows the refusal as it always has and the entry is removed from the device: the form still holds what was typed.

## What an offline entry cannot do yet

- A record type a pack declares needs nothing of its own here. The form is generated from the record types the Records screen read, declared ones among them with their headings, and an entry is kept as the type's id and the bytes to send; Ledger names the declaration the record is written under when it takes the entry. If the organization's adoption of the pack ended while the entry waited, Ledger refuses it in its own words and the entry stays on the device, as any refused entry does.
- The record form offers the record types the Records screen read while there was a connection, and its subject picker cannot suggest subjects without one: a subject is typed by its own id.
- Files cannot be attached to an entry, as they cannot be to a report.
- The list of waiting entries is per device; Ledger cannot see what waits on a device.
- Importing a file, and every form other than these, still needs a connection. A correction made in the record form goes through the same path as a new entry.
