# Decision evidence verifier

Verifies retained `ledger.decision-evidence.1` flight bundles, new `ledger.flight-evidence.2` flight bundles, and `ledger.subject-evidence.2` organization-review bundles offline. Needs only Node 24; it imports no Ledger packages and never runs code from the bundle.

```sh
node tools/verifier/cli.mjs bundle.json \
  --expected-manifest-sha256 DIGEST_SAVED_AT_EXPORT \
  --rebuild-dir /tmp/ledger-evidence-rebuild
```

It checks the manifest digest against the one you saved separately, every hash chain and original byte, tenant boundaries, and the decision's links, then rebuilds the rendered, accepted and issuance cuts from the journal into `--rebuild-dir`.

Both v2 formats explicitly verify typed command-link receipts against their original synthetic source JSON, including receipts for unrelated flights. V1 keeps its original six receipt kinds. Flight v2 verifies the concrete flight target and explicitly unretained historical authority/basis evidence; it does not replay evaluator semantics or rebuild a historical browser display.

Exit codes: `0` verified, `1` failed, `2` integrity verified but reconstruction unavailable. `evidence-cut.1.mjs` is a pinned interpreter: its hash is committed in issued bundles, so never edit or reformat it.

Selected C2 finding-treatment packets use a separate verifier and require the manifest digest saved independently from the packet:

```sh
node tools/verifier/decision-packet-cli.mjs packet.json \
  --expected-manifest-sha256 DIGEST_SAVED_SEPARATELY
```

`ledger.decision-packet.1` verifies the declared record inventory, exact selected evaluation and reported-source mappings. It does not prove journal membership, complete prefixes or full history, reconstruct a display, replay evaluation, or establish present communications health. Missing historical flight actor policy and dependency manifests remain unretained. The packet verifier exits `0` on success and `1` on failure; it does not rebuild cuts.

The same CLI dispatches `ledger.decision-packet.2` to its separate verifier. V2 also checks the retained execution profile, exact selection and any cited adoption against the known company C2 policy, evaluator and half-open interval. It validates the selection basis digest and cuts without fetching omitted dependency records. These checks establish consistency of the declared records; they do not establish complete selection or replay the evaluator. V1 verification remains unchanged.

## Finding packets

`ledger.finding-packet.2` is the generic packet for one finding, from any rule about any subject, and the packet Ledger issues from the flight screens and the findings list. `ledger.finding-packet.1`, issued earlier, stays valid. Both have one verifier, which contains no rule-, pack- or observation-type-specific code: every check follows the references the records make. See `docs/design/finding-packets.md`.

```sh
node tools/verifier/finding-packet-cli.mjs packet.json \
  --expected-manifest-sha256 DIGEST_SAVED_SEPARATELY
```

It checks, and on failure names the check and the path of the offending item:

- the packet and manifest match the format, the limits and limitations are the format's own, and `manifestDigest` is the canonical digest of the manifest;
- each event's canonical envelope round-trips exactly, its envelope digest and entry hash recompute, its encoding version is `ledger.v6.sha256.jcs.1` and its tenant is the packet's; included neighbours in a stream link to each other;
- the inventory lists exactly the included events, receipts, sources and hazard origins, each under its digest and reason, and the counts match;
- each evaluation summary is its record (the evaluation in its event payload plus `recordedAt`), about the finding's subject, pack and rule, and the evaluations run from the finding's initial evaluation to its latest;
- each adoption is a pack adoption whose record digest matches and whose pack digest recomputes, and whose rule digest, accepted revision, organization and mode match each evaluation that names it;
- each read links its event, receipt and source, lies within the evaluation's input cut, and the evaluation's evidence is a subset of what it read;
- each correction event (replacement, withdrawal, subject resolution) and the corrected observation are present, and the correction lies within the cut;
- each recorded subject state matches its digest;
- each hazard origin pins one of the packet's evaluations by digest, its opening is the record opening of that hazard, and each assessment or acceptance is of that hazard and of the right kind;
- the plain-language statements match the evaluations' adoption modes and kinds of rule text.

For version 2 it also checks, before the records' links:

- each carried original (`bytesBase64`) is canonical base64 whose length and SHA-256 match the source item its receipt names (failure code `packet_original`, naming the source);
- the carried bytes total at most `maxOriginalBytes` (1 MiB);
- `manifest.leftOutOriginals` lists exactly the sources without bytes, left out largest first (ties by id); each is listed in the inventory as `observation_source_digest_only` and counted, and the statements say how many were left out.

Its result then adds `originals`: how many sources' bytes were carried, their total length, and each left-out source with its digest, length and content type.

With `--expected-manifest-sha256` the result is `verified` (exit `0`), or a `packet_anchor` failure when the manifest differs from the digest kept separately. Without it the result is `internally_consistent` (exit `2`) and says that only the packet's internal consistency was checked, not that it is the packet that was issued. Any failure exits `1`. Every result lists under `notChecked` what the packet cannot show: source original bytes (version 1) or the bytes left out to keep within the bound (version 2), journal membership and complete-prefix continuity, complete selection, the evaluator's logic, rule content behind a rule digest, and the content of correction, treatment and hazard decision events beyond what they name.

The older formats above keep their own verifiers unchanged. Decision packets are no longer issued (`POST /v1/decision-packets` answers `410 decision_packet_retired`); those issued earlier stay downloadable and verify with `decision-packet-cli.mjs`.

## Records produced on request

`ledger.record-production.1` is a .zip an organization produces for an inspector: `index.html`, `manifest.json`, a CSV per record type under `records/`, and original files under `originals/` when asked. See `docs/design/record-productions.md`.

```sh
node tools/verifier/record-production-cli.mjs records.zip \
  --expected-manifest-sha256 DIGEST_SENT_SEPARATELY
```

It reads the .zip with Node's own `zlib` (stored and deflate entries only; no encryption or ZIP64), checks each entry's CRC-32 and length, that every file the manifest lists is present with its length and SHA-256 and nothing else is, that `index.html` holds no script and loads nothing from elsewhere, that each records CSV has the produced columns and the rows the manifest states, that every row names a listed original, that the counts match, that included originals match their listed digests, and the manifest against the digest you kept. Exit `0` verified, `2` internally consistent (no digest given), `1` failed with named issues. `notChecked` lists what it cannot show.
