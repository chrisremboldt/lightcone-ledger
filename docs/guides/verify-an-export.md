# Verify an export

Ledger's exports can be checked by someone who does not run Ledger and does not trust it. The verifier in `tools/verifier` needs only Node 24. It imports no Ledger package, needs no database and no network, and never runs code from the file it checks. This guide shows how to produce a finding packet, check it offline, and read the result. The other export formats work the same way and are listed at the end.

## Terms

- **Finding packet** (`ledger.finding-packet.2`): one finding with everything needed to check it: the evaluations from the one that opened it to the latest, the pack adoption each ran under, the observations they read with their receipts and the original source bytes, any corrections, and any hazard opened from the finding.
- **Manifest digest**: the SHA-256 of the packet's canonical manifest. It identifies the exact packet that was issued.
- **Kept separately**: the manifest digest has to reach the person checking by another route than the packet itself, such as a ticket, an email or a printed record. A packet that checks out against its own digest only proves it is consistent, not that it is the one Ledger issued.

## 1. Produce a packet

Run the stack from the [README quickstart](../../README.md#from-a-source-checkout) and find a finding. The fictional Alpha Dispatch tenant has them: run the **A landing report goes missing** scene (`/?autopilot=landing`), or `pnpm scenario`.

In the web app, either:

- open **Rules → Findings by subject**, open the finding and choose **Issue a finding packet**; or
- open the decision that treated the finding. Its **Finding packet** panel offers **Issue a finding packet**, then **Download selected packet** and **Copy packet manifest digest**. The download is checked against the record's SHA-256 before it is saved.

Through the public API, with a principal that holds `evidence:read`:

1. `POST /v1/finding-packets` with `{ "findingId": "<finding id>" }` and an idempotency key. The response's `record` carries the packet's `id`, `packetSha256` and `manifestDigest`.
2. `GET /v1/finding-packets/{id}/content` returns the packet as JSON. Its headers repeat the digests: `X-Content-SHA256` and `X-Manifest-SHA256`.

Keep the manifest digest somewhere other than the packet file.

## 2. Check it offline

Copy the packet and the `tools/verifier` folder to any machine with Node 24. Nothing else is needed. Then:

```sh
node tools/verifier/finding-packet-cli.mjs packet.json \
  --expected-manifest-sha256 DIGEST_SAVED_SEPARATELY
```

The verifier prints one JSON object and exits with:

| Exit | `status` | Meaning |
| --- | --- | --- |
| `0` | `verified` | Every check passed and the manifest matches the digest you kept. |
| `2` | `internally_consistent` | You gave no expected digest. Every check passed, but nothing shows this is the packet that was issued. |
| `1` | `failed` | A check failed. `issues` names each one with a `code` and the JSON `path` of the offending item. |

A failure against the kept digest is code `packet_anchor`. A carried original whose length or SHA-256 does not match its source is `packet_original`, naming the source.

## 3. Read the result

A successful result names what was checked and against what:

| Field | What it holds |
| --- | --- |
| `status` | `verified` or `internally_consistent` |
| `format` | `ledger.finding-packet.2` (or `.1` for a packet issued before original bytes were carried) |
| `packetId`, `tenantId`, `findingId`, `subjectKey` | which packet, organization, finding and subject this is |
| `manifestDigest` | the digest the verifier computed; compare it with the one you kept |
| `authenticity` | whether the manifest was checked against a digest kept separately, in one sentence |
| `counts` | how many events, evaluations, receipts, sources and hazards the packet holds |
| `originals` | version 2 only: how many sources' bytes were carried, their total length, and each source left out with its digest, length and content type |
| `notChecked` | what the packet cannot show (section 5) |
| `limitations` | the format's own limitations, as issued |

A failed result has `status: "failed"` and `issues`, each with a `code`, a `path` and a `message`. The code says which part failed:

| Code | The part that failed |
| --- | --- |
| `packet_anchor` | the manifest does not match the digest you kept |
| `packet_format`, `packet_shape`, `packet_limits`, `packet_bound` | the packet is not the format, or exceeds its bounds |
| `packet_entry`, `packet_chain`, `packet_encoding`, `packet_tenant` | a journal event, its hash chain or its tenant |
| `packet_inventory`, `packet_counts`, `packet_duplicate` | the list of what the packet holds |
| `packet_evaluation`, `packet_adoption` | an evaluation, or the adoption it ran under |
| `packet_observation`, `packet_correction`, `packet_subject_state` | what an evaluation read |
| `packet_original` | a carried original's bytes |
| `packet_hazard`, `packet_treatment` | a hazard or decision about the finding |
| `packet_statements` | the plain-language statements |

## 4. What it checks

In plain terms, the verifier checks that:

- every journal event's envelope recomputes to its digest and entry hash, belongs to the packet's tenant, and links to its neighbours in the same stream;
- the inventory lists exactly what the packet holds, each under its digest, and the counts match;
- each evaluation is about the finding's subject, pack and rule, and the evaluations run from the first to the latest;
- each adoption's pack digest recomputes, and its rule digest, organization and mode (shadow or active) match each evaluation that names it;
- each observation an evaluation read is linked to its receipt and source, and lies inside the evaluation's input cut;
- each original carried as `bytesBase64` decodes to bytes whose length and SHA-256 match the source, and those left out to keep within 1 MiB are listed and left out largest first;
- each hazard opened from the finding pins one of the packet's evaluations by digest;
- the plain-language statements match the modes and kinds of rule text.

The verifier contains no code specific to a rule, pack or observation type. Every check follows the references the records make, so a packet about a rule from your own pack verifies with the same tool. `docs/design/finding-packets.md` records the format decisions.

## 5. What it cannot show

Every result lists under `notChecked` what a packet cannot prove. Read that list before you rely on a result. It includes:

- that the packet holds every event of the journal, or a complete history before it;
- that the evaluator's logic was right: the verifier checks what the evaluation recorded, it does not run the rule again;
- the rule content behind a rule digest, beyond what the adoption carries;
- source bytes left out to keep within the bound (their digests are still checked when you have the bytes).

A verified packet says that the records are intact and consistent with each other and with the digest you kept. What they mean is for a person to decide.

## 6. Try it without the stack

You can watch the verifier work before you run Ledger at all. The unit tests build finding packets from fixed, fictional records (a toy rule and the example operations pack's battery reserve rule), with no database:

```sh
pnpm exec vitest run tests/unit/finding-packet-verifier.test.ts
```

Each test changes one thing in a good packet (an envelope byte, a count, a carried original) and expects the verifier to fail with the named code. Read the test names to see which tampering each check catches.

## 7. The other export formats

Each has its own command, with the same rule: keep the manifest digest separately and pass it in.

| Export | Produced by | Check it with |
| --- | --- | --- |
| Flight evidence bundle (`ledger.flight-evidence.2`) | a flight decision's **Download evidence bundle**; `POST /v1/exports` | `pnpm verify:bundle BUNDLE.json --expected-manifest-sha256 DIGEST --rebuild-dir EMPTY_DIRECTORY` (runs `node tools/verifier/cli.mjs`) |
| Organization review bundle (`ledger.subject-evidence.2`) | `POST /v1/subject-exports` | the same `cli.mjs` |
| SMS export | `POST /v1/sms/exports` | `node tools/verifier/sms-cli.mjs EXPORT.json --expected-manifest-sha256 DIGEST` |
| Decision packet (`ledger.decision-packet.1`, `.2`) | no longer issued; earlier packets stay downloadable | `node tools/verifier/decision-packet-cli.mjs PACKET.json --expected-manifest-sha256 DIGEST` |
| Records produced on request (`ledger.record-production.1`, a .zip) | **Records → Produce records**; `POST /v1/record-productions` | `node tools/verifier/record-production-cli.mjs RECORDS.zip --expected-manifest-sha256 DIGEST` |

The evidence bundle verifier also rebuilds the cuts a decision was made on into `--rebuild-dir`, and exits `2` when integrity holds but that rebuild is not possible. `tools/verifier/README.md` describes each verifier in full.

### Records produced on request

An organization produces its records for an inspector from the **Records** screen (**Produce records**, or **Produce these records** on a pilot's, aircraft's or flight's file), or with `POST /v1/record-productions`, giving subjects, record types, dates, the reason and who asked. The result is one .zip and a manifest SHA-256 (`manifestSha256`, also the `X-Manifest-SHA256` header of `GET /v1/record-productions/{id}/content`). The organization sends the digest by another route than the file.

The inspector opens `index.html` in any browser to read and print the records: who produced them, when, why, for whom, the selection, a table per record type, and the original files with their SHA-256. The CSV files under `records/` open in a spreadsheet; open them as text or import them, because cells are written as recorded and a spreadsheet may read one that starts with `=` as a formula.

To check the file, with Node 24 and the `tools/verifier` folder only:

```sh
node tools/verifier/record-production-cli.mjs records.zip --expected-manifest-sha256 DIGEST_SENT_SEPARATELY
```

| Exit | `status` | Meaning |
| --- | --- | --- |
| `0` | `verified` | Every check passed and `manifest.json` matches the digest you were sent. |
| `2` | `internally_consistent` | No digest given. The file is consistent, but nothing shows it is the file that was produced. |
| `1` | `failed` | `issues` names each failed check with a `code` and a path. |

It checks that the .zip is plain (no encryption, every entry's CRC-32 and length), that every file `manifest.json` lists is present with its length and SHA-256 and that no file is unlisted (`file_missing`, `file_digest`, `file_unlisted`), that `index.html` runs no script and loads nothing from elsewhere (`index_page`), that each records CSV has the rows the manifest states and names only listed original files (`records_csv`, `records_original`), that the counts match (`counts`), that included originals match their listed digests and appear only when asked for (`originals`), and that the manifest matches the digest you kept (`manifest_anchor`). A successful result repeats the organization, who produced the file, when, the reason, who asked, the selection and the counts.

Under `notChecked` it says what it cannot show: that the records are complete, that the journal positions in the manifest are those of the organization's journal, that the values are true or that any requirement is met, and what the original files say beyond their length and digest. [record-productions.md](../design/record-productions.md) records the format.

## Check your work

1. Run `pnpm verify`. Among the unit tests, `tests/unit/finding-packet-verifier.test.ts` assembles packets from fixed records, tampers with them one way at a time, and expects the named failure. It also runs the command-line verifier the way a stranger would: `verifyOffline` in `tests/unit/finding-packet-fixture.ts` copies `tools/verifier` into an empty temporary folder and runs it with an empty environment.
2. To test a packet about your own pack's rule, follow that test: it already builds one from the example operations pack's battery reserve rule. Copy it and pass your rule, pack and observation type.
3. By hand: issue a packet in the running app, copy the verifier and the packet to another folder, run the command above with the digest you copied, and confirm `"status":"verified"` and exit code `0`. Then change one character inside a `canonicalEnvelope` in the packet and confirm it fails with a named check.
