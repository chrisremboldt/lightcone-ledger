# Pack files

Status: built. Code: `packages/contracts/src/pack-files.ts` (the schema), `packages/standard-packs/src/pack-files.ts` (verifying a file), `pack-folder.ts` (loading the folder at startup), `pack-builder.ts`, `pack-templates.ts` and `pack-cli.ts` (the authoring commands). Tests: `packages/standard-packs/tests/pack-files.test.ts` and `pack-files.integration.test.ts`. Worked example: `packages/standard-packs/examples/invented-waiver/`.

An organization's own waiver or procedure becomes a rule pack without TypeScript and without rebuilding Ledger. A pack file is the data form of one pack version. The API and the workers load every pack file in a folder at startup and register each one through the same registry path a built-in pack takes.

## What a pack file holds

A pack file is JSON with format `ledger.pack-file.1`. It holds exactly what the registered pack version is made of, and no code:

| Field | What it is |
| --- | --- |
| `packId`, `version`, `title` | The pack's identity. Ids are lowercase words joined by dots or hyphens. `ledger.` is reserved for packs that ship with Ledger. |
| `sources` | Each source document kept whole: an `id`, its `kind` (`operator_procedure` or `waiver_or_exemption`, which every rule quoting it takes as its source kind, so only a waiver's rule may declare `relieves`), a `reference` a reader cites, the `text`, its UTF-8 `byteLength` and `sha256`. |
| `rules` | Each rule as data (below). |
| `sections` | Optional: the sections of the pack in reading order, each `{ id, title }`. With sections, every rule names one in `section`; without, no rule may, and the pack is read in the order of its rules' paragraphs or provision numbers. Carried into the pack version and its digest. |
| `recordTypes` | Optional: record types the pack declares, as data ([declared-record-types.md](declared-record-types.md)). A file that declares at least one may have no rules. Each is carried into the pack version with its digest; absent, it does not enter the digest. |
| `waiver` | For a waiver: its certificate number, the dates it states it is effective and which flights its conditions cover (`waiver-relief.md`, section 8). Carried into the pack version and its digest. |
| `digest` | The digest of the pack version the rules make: the same digest the catalogue shows and an adoption pins. |

A rule is one of two kinds. Every provision a description lists becomes one, so nothing in it is dropped.

**A rule a check runs** carries every field a checked rule declares (`id`, `version`, `title`, `target`, `reads`, `adoptionParameters`, `applicability`, and `subjectState`, `wording`, `related` when used), plus:

- `quote`: `{ source, start, end, reference }`, zero-based half-open UTF-8 byte offsets into one of the file's sources. The rule's source text is exactly those bytes, and `reference` is how an evaluation cites it.
- `check`: `{ kind, version, params, written? }`. The check kind must be registered in code in this Ledger. A file never names code; a kind Ledger does not have refuses the file. `written` holds, for each parameter the description wrote with its unit, the text as written (`{ "limit": "3 sm" }`); `params` holds the value in the stored unit, converted by the import's own unit table (`recordEntryUnits` in `packages/contracts/src/operator-record-import.ts`). `written` is outside the rule and its digest; loading checks that each entry converts to exactly the value in `params`.

Its schema (`PackFileCheckedRuleSchema`) is derived from the checked rule schema (`CheckedRuleLeafSchema`) by leaving out what Ledger derives on loading: the source, the check kind's definition digest, the review labels and the rule's digest. A field a checked rule gains later is therefore carried by pack files without changing this format.

Either kind of rule may carry `section` (the id of a section the file lists) and `paragraph` (the paragraph it reads as a reader cites it, such as `Provision 3`, which a description's provision is given automatically).

**A rule no check runs** (`PackFileCoverageRuleSchema`) carries `id`, `version`, `title`, `quote`, `coverage` and `waitingFor`, and optionally `section` and `paragraph`:

- `coverage: manual`: a person checks it. `waitingFor` is the sentence saying what that person confirms.
- `coverage: unsupported`: no record type or check kind covers it yet. `waitingFor` says what Ledger would need.

It loads as the same kind of leaf the built-in packs use for a paragraph a person reviews or nothing covers (`coverage` `manual` or `unsupported`, no dependencies), so an adoption lists it and the coverage read reports it per rule as `manual_review_required` or `unsupported`. It is never evaluated and never opens a finding.

### What the shared schema gained

Before pack files, that leaf (`RegulatoryCoverageLeafSchema` in `packages/contracts/src/rule-packs.ts`) could only quote a retained regulatory document, and had nowhere to say what a person confirms: the built-in packs keep that sentence in code beside the pack. Two additions let a file carry it as data, and neither changes a built-in pack's digest:

- its `source` may also be an `operator_procedure` source carrying the provision's words whole, as checked rules already do (`ProcedureSourceSchema`, now exported from `checked-rules.ts`);
- an optional `waitingFor`, absent on every built-in leaf.

The offline verifier (`tools/verifier/subject.mjs`) accepts such a leaf when it quotes its own text whole and claims no binding.

## Loading and verifying

`verifiedPackFile` turns a file into a pack version, refusing it with a reason when:

- it does not match the schema (an unknown field, a missing one, a wrong type);
- the pack id starts with `ledger.`, or a rule id does not start with the pack id and a dot, or an id repeats;
- a source's text does not match its byte length and SHA-256;
- a quotation's span lies outside its source or splits a character, or a rule no check runs does not say what a person confirms or why nothing covers it;
- a rule names a check kind this Ledger does not have;
- a parameter's `written` text does not convert to the value its `params` hold;
- a field path a rule names under `values.` reaches nothing in what its reads take: a field the record type (from the read's `values.recordType` condition, or a selection's `recordType`) or the observation type's schema does not have, a path into a record type this Ledger does not register, or a reference (`{ id, scope }`) compared without `.id` in a `oneOf` condition, an applicability condition or the check's own `field`. A whole reference is accepted where one is meant: a `filled` condition, a related subject's `from.field`. A path is accepted when it reaches a value in any read it may point into. The paths are listed by `ruleFieldPaths` in `packages/contracts/src/rule-field-paths.ts` and checked in `packages/standard-packs/src/pack-field-paths.ts`; `pnpm pack:build`, `pnpm pack:check` and, for an organization's own file, `pnpm ledger packs show` print them per rule;
- a rule with no adoption parameters has parameters its check kind's schema refuses (the test adoption runs);
- `defineCheckedRule` refuses a rule, or the registry's own checks refuse the pack (the same checks a built-in pack meets);
- a record type it declares is refused (a dotted or reserved pack id, an id not under the pack's, a field named against the naming rules, a time field that is not a field, no required field), or cannot follow the same type in another version of the pack in the folder ([declared-record-types.md](declared-record-types.md), "Change");
- the pack version the rules make has a digest other than the one the file states. That happens when the file was edited after it was built, or when it was built against a Ledger whose check kind definitions differ.

Each rule a check runs is built with `defineCheckedRule`, exactly as a built-in pack builds its rules, with an `operator_procedure` source holding the quoted bytes. An evaluation therefore records the provision's own words and its SHA-256, as it does for the example waiver.

The digest binds every rule, including the exact quoted words. A source's own SHA-256 binds the whole document; it is checked on loading but is not part of the pack digest, so text outside every quotation does not change what a rule checks or the digest an adoption pins.

## The pack folder

`LEDGER_PACKS_DIR` names a folder. At startup the API (`createApp`) and the workers (`apps/workers/src/main.ts`) call `registerPackFolder` after registering the built-in packs. It reads every `*.pack.json` directly in the folder, in name order:

- Every file is verified before any is registered. A refused file stops startup with a message naming the file and the reason, and nothing from the folder is registered.
- Two files stating the same pack id and version with the same digest are one pack version, recorded under the first file's name. With different content, the second file is refused, naming both.
- A file whose pack id and version are already registered with different content is refused. A file whose pack id belongs to a built-in pack is refused.
- Several versions of one pack may come from several files; they are registered together.
- Loading the same files again in one process is not an error.

Unset, or empty, the variable loads nothing.

**Keeping the API and the workers in step.** Both processes read the folder only at startup, and an adoption names a pack version by its digest. An operator points both at the same folder (one path on one host, or one mounted volume), and restarts both after adding, changing or removing a file. The API accepts an adoption only of a pack version it has registered, and reads look pack versions up in the registry of the process serving them, so two processes reading different folders offer and show different packs. Removing a file never removes an adoption; adopt a successor version before taking the old file away.

## Origin

The registry records where each pack version came from: `built_in`, or `organization_file` with the file's name. The catalogue read (`GET /v1/rule-packs`) gives each summary an `origin`, and the coverage read (`GET /v1/organization/coverage`) lists `packOrigins` for the pack versions its adoptions name.

## Authoring a pack file

The commands, run with pnpm from the repository after `pnpm build`:

- `pnpm pack:new <folder> --kind waiver|procedure` writes `source.txt` (an invented placeholder) and `pack.yaml` (a description whose comments list the obligation types, check kinds and observation types this Ledger has). The templates build as they are.
- `pnpm pack:build <folder> [--out <folder>]` reads `pack.yaml` and the source file, locates every quotation, builds and verifies the pack file exactly as startup will, writes `<id>-v<version>.pack.json` and prints each rule: its title, what it quotes and how it is checked.
- `pnpm pack:check <file>` verifies a file as startup does and prints its rules.
- `pnpm pack:list [<pack id>]` prints the packs built into Ledger, or one pack's rules with their ids: what a waiver's provision names under `relieves`.
- `pnpm pack:compare <pack> <new text> [--json] [--write-next <folder>]` reports what each quotation of a pack did in a new source text, and starts the next version of a pack folder for a person to settle. [Comparing a new text with the one a pack quotes](pack-compare.md) has the design.

The description is YAML rather than JSON because an operator reads and edits it by hand: it has comments, so the template can explain each field and list what Ledger has, and long quotations wrap without escaping. The pack file it produces is JSON, which the loader reads with no extra parser.

**Quotations.** A quotation is the provision's exact words. Any run of spaces and line breaks in the quotation matches any run in the source, so a quotation wrapped differently from the source still matches; every other character, capital letters and punctuation included, must match. The span is the source's own bytes. A quotation that is absent is refused with where it stops matching; one that appears more than once is refused with the lines it appears on unless the rule gives `occurrence: N`.

**Provisions.** A waiver description lists provisions. Each names an obligation type from the waiver library (`packages/pack-example-waiver/src/obligations.ts`) and its parameters, which are checked against the type. The builder turns each into the rule the library defines for that type, with id `<pack id>.provision-<number>` and a reference naming the provision. A provision whose obligation no check serves becomes a rule no check runs: `manual` when the library says a person establishes it (attested or field-checked), `unsupported` otherwise. Its `waitingFor` is the provision's own `waitingFor` when the description gives one, or else the library's sentence for the obligation type. A provision no obligation type fits may give `coverage` and `waitingFor` in place of `obligation`. `pnpm pack:build` prints every rule with how it is covered: checked automatically (by which check kind, reading what), checked by a person (and what they confirm), or not supported yet (and why). A new obligation type in the library is available to descriptions without a change here.

**The waiver section.** A waiver description states `certificateNumber`, `effective` (`from` and `through`, year-month-day) and `conditionsCover`: `flights whose plan cites the certificate` or `every flight`, with no default. With the first, every provision about a flight is limited to the flights whose latest plan cites the certificate; `pnpm pack:build` prints the section once and, for each rule, whom it covers.

**Rules by check kind.** A description may also list rules written by check kind, for a provision no obligation type fits. In a waiver, a rule about each flight with `covers: flights whose plan cites the certificate` is limited the same way. A rule there with `coverage` and `waitingFor` and no `check` is a rule no check runs. Their fields are a pack file rule's, with a short `id` (the builder prefixes the pack id), a `quote` in place of the span, and an optional `reference`.

**Fields the builder does not know** on a provision or a rule pass through to the rule and are validated against the pack file schema. A declaration a checked rule gains later, such as a relief declaration, is written in a description the same way and is refused only if the schema does not have it.
