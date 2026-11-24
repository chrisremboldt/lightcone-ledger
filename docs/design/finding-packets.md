# Finding packets carry original source bytes

Status: built. Code: `packages/contracts/src/finding-packets.ts`, `packages/evidence/src/finding-packet-assembly.ts`, `packages/evidence/src/finding-packet-records.ts`, `tools/verifier/finding-packet.mjs`. Tests: `tests/unit/finding-packet.test.ts`, `tests/unit/finding-packet-verifier.test.ts`, `tests/integration/finding-packets.integration.test.ts`, `tests/browser/decision-packets.spec.ts`.

## The question

Two packet formats existed. The older decision packet (`ledger.decision-packet.1` and `.2`) served only the lost-link finding and carried the original bytes of every report it cited. The generic finding packet (`ledger.finding-packet.1`) serves any finding from any rule, but identified source originals by digest only. Now that lost link and landing run on the generic evaluator, the flight screens should issue one format for every finding. Should the generic packet carry the bytes too, or are digests enough?

## Decision: version 2 carries the bytes

Digests alone let a holder check bytes they already have, but not see what the source said. A reviewer of a finding usually has nothing but the packet, so the packet carries the bytes.

- **`ledger.finding-packet.2`** is the version 1 selection (same records, same inventory, same checks) plus the exact original bytes of every source an evaluation read, as `bytesBase64` on each source item. Ledger issues version 2 only.
- **Each carried byte range is checked** at issue and by the verifier: its length and SHA-256 must match the source item the observation's receipt names.
- **Bound.** The carried bytes total at most `maxOriginalBytes` = 1 MiB, the older decision packet's bound; the whole packet stays within 4 MiB as before. When the sources do not fit, bytes are left out **largest first** (ties by id) until the rest fit, and further only if the whole packet would exceed its bound. A left-out source keeps `bytesBase64: null` and its digest, length and content type.
- **A packet says what it left out**, three ways: `manifest.leftOutOriginals` lists the ids in leave-out order; each left-out source's inventory reason is `observation_source_digest_only`; and the statements add one plain sentence giving the count. `counts` gains `originalBytes` and `leftOutOriginals`, so the packet record carries them too.
- The limitation about originals is reworded for version 2; the other limitations are unchanged.

Version 1 stays valid, readable and verifiable unchanged: records of either version are read, listed and downloaded through the same routes, and the verifier dispatches on `format`.

## The verifier

`tools/verifier/finding-packet.mjs` verifies both versions; the CLI is unchanged. For version 2 it also decodes each carried range (canonical base64 only), checks its length and digest (failure code `packet_original`, naming the source), checks the carried total against the bound, checks that the listed left-out sources are exactly those without bytes and were left out largest first, and checks the statement. Its result adds `originals: { carried, carriedBytes, leftOut[] }`, each left-out source with its digest, length and content type. It still imports no Ledger package and runs no code from the packet. It does not parse carried bytes or compare them with the observation recorded from them; it says so under `notChecked`.

## The flight screens

The decision record's packet panel (`apps/web/src/DecisionPacket.tsx`) offers "Issue a finding packet" for any decision that treats a finding whose accepted basis is a rule evaluation. Which panel shows comes from the decision's retained payload (`decision-packet-eligibility.ts`), never from a rule or pack id. The panel lists the finding's packets, lets a person select and download one (bytes checked against the record's SHA-256 before saving), and shows the manifest digest to keep. Requests and selections live in `useDecisionPacketRequests` above the inspector, keyed by finding, so an issue in flight or a selected packet is still there after a person moves to another record and back. The findings list keeps its own issue button, which now issues version 2.

## The older decision packet

`POST /v1/decision-packets` refuses every request with `410 decision_packet_retired` and a plain reason pointing to the finding packet. Packets already issued stay listed, readable and downloadable through the GET routes, and a decision record that treated a retained lost-link evaluation still shows them (without an issue button). They verify with their own verifiers, whose code is unchanged: `tools/verifier/decision-packet.mjs`, `decision-packet-v2.mjs`, `decision-packet-cli.mjs` and `command-link-baseline.mjs`.

What must stay as long as old packets must verify:

- the registration they cite, `c2ExecutionRegistration` in `packages/domain/src/rules/command-link-execution-v1.ts` (exported as `@ledger/domain/retained-c2-execution`), with the version 1 lost-link leaf and binding in `packages/domain/src/rules/command-link-evidence-v1.ts`;
- the literals the old verifiers derive ids from: `LEAF`, the pack and evaluator definitions and `EXECUTION_POLICY` at the top of `tools/verifier/decision-packet.mjs` and `decision-packet-v2.mjs`;
- `createDecisionPacket` in `packages/evidence/src/decision-packets.ts`, which no route calls; tests use it to produce packets as they were issued.

## Storage

Migration `0064_finding_packet_v2.sql` widens the `format` check on `finding_packet_records` to both versions. No column is added: the version is the existing `format` column and the left-out count is in the record's `metadata` counts.
