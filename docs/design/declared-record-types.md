# Record types a pack declares

Status: accepted. Code: `packages/contracts/src/declared-record-types.ts` (the declaration and what it becomes), `packages/standard-packs/src/pack-files.ts` (checking declarations when a pack file loads), `packages/domain/src/organization-record-types.ts` (the record types an organization has). Worked examples: `examples/declared-record-type/`, and a checklist in `examples/preflight-checklist/`.

Before this, a pack file read the record types core declares in `packages/contracts/src/observations/operator-records/`. When an operator's procedure asked for something no record type holds, the path that needs no code ended: someone had to change `packages/contracts`. Now a pack file may declare record types of its own, as data, and a declared type gets what a built-in one has: import (CSV and JSON, with a column mapping), `records check`, the entry form and browse on the Records screen, record production, and checks by the generic check kinds.

## One mechanism: a declaration lives in a pack file

A pack file gains an optional section, `recordTypes`. Each entry declares one record type. There is no second path: an organization that wants a record type with no rule yet writes a pack file with declarations and no rules (a pack file may have no rules when it declares at least one record type), and adopts it as it adopts any pack. Writing a rule later is a new version of the same pack.

What an organization keeps on file is decided by the packs it adopts, so the types it may record are the built-in ones and those its adopted packs declare.

## Identity and version

**The id sits under the pack's id.** A declared type's id is `<pack id>.<name>`, such as `example-ridge-procedures.aircraft-check`. Every record type id in Ledger is a lowercase `domain.noun`, and that pattern is written into the parameter schemas of the record check kinds (`record.complete` and others). Those schemas are part of each check kind's definition digest, which every shipped pack pins, so widening the pattern would move every shipped pack's digest. A pack that declares record types therefore has a one-word id (lowercase letters, digits and hyphens, starting with a letter), and that word is the domain of every type it declares. The loader refuses:

- a declaring pack whose id has a dot, or starts with a digit;
- a declaring pack whose id is a domain a built-in type already uses (`aircraft`, `person`, `flight` and the others), so a pack can never declare `aircraft.inspection` or any id beside it;
- a declared id that does not start with the pack's id and a dot.

Pack ids are unique in a Ledger, so one pack's types can never shadow another's.

**Version and digest.** Each declaration states its own `version`, an integer, as a rule does. It is identified by its content digest (`ledger.v6.sha256.jcs.1` over the declaration), which the pack version carries beside it. The declarations are part of the pack version, so the pack's digest binds them. A pack with no declarations has no `recordTypes` section at all: an absent section does not enter the digest, so no existing pack's digest moves.

Two versions of one pack may both declare the same type and version only with the same content. Any change to a declaration, even to a label, is a new version of the type.

## Pinning

An adoption keeps the whole pack version it adopts, so it pins the declarations exactly as it pins the rules. A rule reads only built-in types and types its own pack declares; the loader refuses a rule that reads a type another pack declares. The declarations a rule reads are therefore always the ones its own adoption pinned.

A record names the declaration it was written under: an `operator.record` observation of a declared type carries `values.declarationDigest`, the digest of the declaration it was validated against. Import and hand entry fill it in. Intake refuses a record of a declared type that names no digest, or a digest that none of the organization's adopted declarations has.

## The record types an organization has

One interface answers "which record types exist for this organization at this time": `organizationRecordTypes(client, tenantId, at)` in `packages/domain`. It returns the built-in types and the declarations pinned by the organization's adoptions that have not ended by `at` (in effect, or still to come, so records can be entered before the rules start). Every reader that offers or accepts records goes through it: the record types read (`GET /v1/operator-records/types`, which the command line and the Records screen read), templates, import preview and commit, generic observation intake, and record production.

Built-in types stay where they are, in TypeScript, behind the same interface. They are already data of this shape (`OperatorRecordDefinition`: fields, time, subject kinds), and a declaration becomes the same `OperatorRecordDefinition` through the same `defineOperatorRecordType`; moving the built-in ones to files would be a rewrite that changes nothing a reader sees.

A declared type, once a pack file is loaded, is also registered in the process's observation registry under its id and version, so that the code that reads records already on file (field labels, the check kinds, the reads of the Records screen) finds it the way it finds a built-in type. Nothing lists types from that registry for an organization.

**Tenant isolation.** An organization's record types, templates, import and entry offer and accept only the declarations of its own adoptions. A record of a type another organization adopted is refused at intake. Pack files are the deployment's, read from one folder at startup; the catalogue shows each pack's content, its rules and its declarations, to every organization of the deployment, as it always has. A deployment whose organizations must not see each other's packs at all needs packs kept per organization, which is not built.

## Change

Records on file are never rewritten. A later version of a declared type may add fields and options and change wording; a rule of a later pack version reads an older record field by field. A field the older record holds is read. A field it does not hold is not on file: a check reports it missing, as it reports any field with no value, and never guesses or fills in a default. A rule's read selects records by type, not by version, so it reads every version of the type at once.

Removing a field, or changing its kind, its unit or what it refers to, is not an edit: it is a new field name, or a new type. When two versions of a declared type are loaded together, the loader compares each with every earlier one and refuses the later one, saying why, when it:

- leaves out a field an earlier version has;
- changes a field's kind, unit or reference kind;
- leaves out an option an earlier version of a select field has;
- leaves out a subject kind, or changes how the record is placed in time.

## What a declaration can say

| A declaration says | Written as | Kept as |
| --- | --- | --- |
| Text | `kind: text` (one line, up to 1,000 characters) or `long_text` | text |
| A whole number | `kind: number`, `unit: Count` | an integer |
| A number with a unit | `kind: number`, `unit: Hours`, `Meters`, `MetersPerSecond` or `Percent`; optional `minimum`, `maximum` | the number in that unit; import and entry accept the other units Ledger converts (feet, knots, statute miles) |
| A date | `kind: date` | `YYYY-MM-DD`, with no time of day |
| A date and time | `kind: date_time` | a UTC instant. Entered with an offset, or in the organization's time zone under a heading that says `[local]`, as every time column is; the field that places the record also takes a date alone |
| Yes or no | `kind: boolean` | true or false; false is an answer |
| One of listed options | `kind: select`, `options: [{ value, label }]` | the option's value |
| A subject on file | `kind: reference`, `referenceKind: person`, `aircraft`, `site` or `component` | the operator's own id, as any reference |

Each field has a `name`, a `label` and optionally a one-line `help` in the operator's words and a `heading`, and is `required` or not. Names follow the built-in types' rules, which the loader checks: a number's name ends in its unit (`airframeHours`), a date and time's in `At`, a date's in `On`, a reference's in `Id`. At least one field is required.

The declaration also says the kinds of subject the record is about, from the six core has (`aircraft`, `person`, `flight`, `site`, `component`, `organization`), and how the record is placed in time, as a built-in type does: `event` at a time field, `as_of` (optionally at a time field) or `interval` between two.

**Headings.** A long form reads in sections: a checklist has "Airframe", "Batteries", "Site". A field may carry a `heading`, a short text (up to 60 characters), as data. The entry form shows a heading above a field whose heading differs from that of the field before it, so the fields of one section give the same heading and are listed together; a field without one stays in the section before it. Nothing else reads it: import templates, column mappings, `records check`, completeness, production and the check kinds read fields by name, in the declaration's order, as before. It is part of the declaration's content, so the declaration's digest covers it and changing one is a new version of the type, like a change to a label. A later version may change headings freely; records on file hold no heading. A declaration without headings is unchanged, and so is its digest. What was considered: sections as a list beside the fields (each naming its fields), which says the same thing twice and lets a field be left out of every section; and a `section` kind of field, which would put something that holds no value among the fields every reader walks. A built-in type could carry headings the same way (`heading` on its field definition); none does yet.

New kinds of subject are out of scope. A subject kind is part of the observation envelope's schema, of the subject and alias tables, of who a rule covers and of every screen that names a subject; a new one is core work, not a declaration.

## Extra fields on a built-in type: designed, not built

The decision was that a pack may also add fields to a built-in type, under a key named for the pack (`values.record.<pack id>.<field>`; the one-word pack id is a valid path segment for exactly this reason). Reading the code shows it cannot be done as a declaration alone: a built-in type's record is checked against one closed schema per type and version, and every reader of a record (import columns, the entry form, completeness, production's columns, column mappings, the check kinds' field lists) reads a field by its name at the top of the record. A field under a key needs each of them to read nested fields, and the same `aircraft.inspection@1` record would then mean different things in different organizations. Until that is built, a pack that needs more about an inspection declares its own type about the same aircraft.

## A checklist is a declared record type

Ledger has no checklist feature. A checklist is a record a person makes: a declared type with one `select` field per item, each answered from the same closed set of answers (`done`, `not-applicable`, `defect-found`), a note, who completed it and when, with a `heading` per section. Three rules over it use kinds Ledger already has: `record.made-before@1` (one is on file, completed before the takeoff), `record.complete@2` (every item is answered: the items are the type's required fields) and `value.one-of@2` (no item holds an answer other than done or not applicable; each that does is named by its label, the item in the manual's own words). `examples/preflight-checklist/` is the worked example and `tests/integration/preflight-checklist.integration.test.ts` runs it. Building it showed what was missing, each added the smallest generic way: one rule over many fields (`value.one-of@2`, [record-check-kinds.md](record-check-kinds.md)), headings (above), and nothing for "not applicable" (an expected answer the sentence counts) or for entry without a connection (a declared type's form is kept on the device as a built-in type's is, [offline-entry.md](offline-entry.md)). Ledger does not hold a flight until a checklist is made, and no screen says a flight may or may not go: the rules report what is on file.

## Worked example

`examples/declared-record-type/` is a procedure pack, `example-ridge-procedures`, for Example Ridge Survey's own airframe check. It declares one type:

```json
{
  "id": "example-ridge-procedures.airframe-check",
  "version": 1,
  "title": "Airframe check",
  "description": "A check of an aircraft's airframe under the operator's own procedure.",
  "subjectKinds": ["aircraft"],
  "time": { "meaning": "event", "atField": "checkedAt" },
  "fields": [
    { "name": "checkedAt", "label": "Checked at", "kind": "date_time", "required": true },
    { "name": "inspectorId", "label": "Inspector", "kind": "reference", "referenceKind": "person", "required": true },
    { "name": "result", "label": "Result", "kind": "select", "required": true,
      "options": [{ "value": "serviceable", "label": "Serviceable" }, { "value": "repair-needed", "label": "Repair needed" }] },
    { "name": "airframeHours", "label": "Airframe hours", "kind": "number", "unit": "Hours", "required": true }
  ]
}
```

Its rule asks, with the generic `value.one-of` check kind, that the latest check of each aircraft on record found it serviceable. It reads the records through `type: operator.record`, `where: values.recordType oneOf [example-ridge-procedures.airframe-check]`. Its records are a CSV file whose header is the template `pnpm ledger records template example-ridge-procedures.airframe-check` prints. Once the pack is adopted, `records check` and `records import` take the file, the Records screen offers the form, and coverage shows each aircraft: one found serviceable, one needing repair, and one with no airframe check on file. `tests/integration/declared-record-type.integration.test.ts` runs it.
