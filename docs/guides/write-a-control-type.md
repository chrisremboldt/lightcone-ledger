# Write a control type

A **control** is a measure that reduces a hazard's risk, such as a battery reserve, an area to keep clear of, or a briefing. A **control type** says what kind of measure it is: the parameters a person fills in, how the control reads, and whether Ledger can check it. Registering a type is all a new kind of control needs. No core module names a control type.

This guide builds a small fictional type, an example height ceiling that bears only on listed aircraft, and explains each part against the three types Ledger ships. The example is real code in `tests/unit/guides/control-type-example.test.ts`, which `pnpm verify` runs. The design behind it is in [controls-as-rules.md](../design/controls-as-rules.md) and [control-applicability.md](../design/control-applicability.md).

## Terms

- **Hazard**: a safety-program record of something that could cause harm. Its risk is assessed against the organization's risk matrix.
- **Risk acceptance**: a signed decision by a person with the authority for that level of risk. It binds the exact control versions the assessment listed.
- **Accepted control**: a control version bound by its hazard's latest risk acceptance, while the hazard is open and the control is in its effective interval. What a person signed stays in force until a person signs again.
- **Applicability rule**: code a type declares that decides, from the control's parameters and a flight's recorded plan, whether the control bears on that flight.

## The shipped types

All three are in `packages/domain/src/control-type-library.ts`:

| Type | Parameters | How it is checked |
| --- | --- | --- |
| `control.described-measure` | a measure in words | By a person. It declares no rule. |
| `control.operating-limit` | an observation type, field, comparison, limit and scope | By the rules it declares (`rules()`). |
| `control.avoidance-area` | a circle and an optional reach | By route review (`area()`), with the area reach applicability rule. |

## 1. Parameters and their schema

A type is an object implementing `ControlType` from `packages/domain/src/control-types.ts`. The example begins with its identity and a JSON Schema for its parameters:

```ts
const heightCeilingControlType: ControlType<HeightCeilingParameters> = {
  id: 'example.guide-height-ceiling',
  version: 1,
  title: 'Example height ceiling',
  description: 'A fictional lower height ceiling for the listed aircraft, such as while a sensor is being trialled.',
  appliesTo: ['aircraft'],
  parameterSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['maxHeightMeters'],
    properties: {
      maxHeightMeters: {
        type: 'number',
        title: 'Highest height above ground (metres)',
        exclusiveMinimum: 0,
        maximum: 120,
      },
      aircraftIds: {
        type: 'array',
        title: 'Aircraft',
        description: 'The aircraft it bears on. Leave empty for every aircraft.',
        items: { type: 'string', minLength: 1, maxLength: 200 },
        minItems: 1,
        maxItems: 20,
        uniqueItems: true,
      },
    },
  },
  checkedAutomatically: false,
```

- `appliesTo` says what a control of this type is about: `aircraft`, `person_or_role`, `operation_kind`, `area`, `time_window` and so on.
- The hazard page's **Propose a control** form is generated from `parameterSchema`, using each property's `title` and `description`. Close the schema with `additionalProperties: false` and bound every value.
- `validate(parameters)` is optional: the first problem the schema cannot express, such as an observation type that is not registered. The operating limit uses it.
- `parameterChoices` is optional: lets a form offer named things (an observation type, a numeric field) instead of raw ids. The operating limit uses it.

## 2. Wording

`describe` turns valid parameters into one plain sentence. That sentence is the recorded wording: a rule assembled from the control quotes it, and a briefing shows it.

```ts
  describe: ({ maxHeightMeters, aircraftIds }) =>
    `Fly no higher than ${maxHeightMeters} m above ground` +
    (aircraftIds ? ` with aircraft ${aircraftIds.join(', ')}.` : ' with every aircraft.'),
```

`wording(parameters)` is optional: the control in the words a person knows its parameters by, for screens only, never recorded. Neither may state a verdict on the control.

## 3. `rules()`: a type a rule can check

A type whose controls a deterministic check can follow declares `rules(parameters)`. Once a control is accepted, Ledger turns each declaration into a rule in the organization's own pack, `ledger.accepted-controls`, adopted in active mode by the acceptance itself. The operating limit declares one rule per kind of subject:

```ts
  return kinds.map((kind) => ({
    target: { subjectKind: kind },
    ...(listed ? { subjectIds: listed } : {}),
    reads: [
      {
        name: 'subject',
        type: observationType,
        versions: [observationVersion],
        about: 'target',
        required: true,
        select: 'latest',
        ...(listed ? { where: [{ field: 'subject.kind', oneOf: [kind] }] } : {}),
      },
    ],
    check: { kind: 'value.within-limit', version: 1, params: { field, comparison, limit } },
```

The declaration has the same reads, check kinds and applicability as any rule in a pack; see [write-a-rule-pack.md](write-a-rule-pack.md).

## 4. `area()`: a type route review checks

A type that describes an area declares `area(parameters)`, which returns a circle. Route review then keeps every planned route clear of each accepted control of that type. The avoidance area:

```ts
  area: ({ center, radiusMeters, site }) => ({
    center: { latitude: center.latitude, longitude: center.longitude },
    radiusMeters,
    ...(site ? { site } : {}),
  }),
  applicability: areaReachApplicability,
```

A type that declares neither `rules()` nor `area()` is checked by a person, as the example and the described measure are.

## 5. `applicability`: which flights a control bears on

The most recent addition. A type may declare an applicability rule: a pure function from the control's accepted parameters and the exact mission revision to an outcome. It sees deep-frozen copies of the parameters and six plan fields (aircraft, source mission id, route, lateral tolerance, altitude, operating interval), and nothing else: no clock, no database, no registry. The example:

```ts
/** The frozen description the rule's digest covers. A changed rule is a new version of it and of the type. */
const listedAircraftRule = Object.freeze({
  id: 'example.applicability.guide-listed-aircraft',
  version: 1,
  reads: 'plan.mission.aircraftId',
  applies: 'aircraft_listed',
  uncertainty: 'applies',
});
```

```ts
  applicability: {
    rule: { id: listedAircraftRule.id, version: 1, digest: canonicalDigest(listedAircraftRule) },
    definition: listedAircraftRule,
    evaluate({ aircraftIds }, plan) {
      if (!aircraftIds) return { applies: 'undetermined', reasons: ['no_aircraft_listed'] };
      const aircraft = plan.mission.aircraftId;
      return {
        applies: aircraftIds.includes(aircraft),
        measured: [{ name: 'aircraftId', value: aircraft }],
        declared: [{ name: 'aircraftIds', value: aircraftIds.join(', ') }],
        summary: `This flight's mission names aircraft ${aircraft}; the control bears on aircraft ${aircraftIds.join(', ')}.`,
      };
    },
  },
```

The generic evaluator, `evaluateControlApplicability` in `packages/domain/src/control-applicability.ts`, runs the rule and records an applicability record: the outcome, what was measured, what the parameters declare, the inputs by digest and the rule's identity. It fails towards applying: no rule, missing inputs, a hazard reassessed since acceptance, a rule that throws, or `undetermined` all mean the control applies. Only a rule that ran on complete inputs and said `false` gives `does_not_apply`.

Model your rule on the area reach rule, `packages/domain/src/area-reach-rule.ts`. It freezes its definition, checks the definition against a digest constant when the module loads, and ships golden vectors (`tests/unit/area-reach-rule.test.ts`): fixed parameters and plans with fixed record digests. The digest covers the definition, not the code, so the golden vectors are what catch a code change that alters a result.

Know where it runs today. Route review evaluates applicability for every accepted control whose type describes an area and whose interval overlaps the flight. A type without `area()`, like the example, can declare a rule and the evaluator runs it (the test proves this), but no screen or command consults it yet.

## 6. What the digest covers

`controlTypeDigest` is the digest of `controlTypeDefinitionContent`: id, version, title, description, `appliesTo`, `parameterSchema`, `checkedAutomatically`, and the applicability rule's id, version and digest when there is one. Outside the digest: `describe`, `wording`, `validate`, `area`, `rules` and `parameterChoices`. The example test proves both sides:

```ts
    const reworded = { ...heightCeilingControlType, describe: () => 'Other words.' };
    expect(controlTypeDigest(reworded)).toBe(TYPE_DIGEST);
```

Changing anything inside the digest, the rule included, is a new type version. An accepted control keeps the version a person accepted. What `rules()` produced is pinned instead by each rule's digest inside the accepted-controls pack. `registerControlType` refuses an applicability declaration whose definition is not its rule's, or whose digest does not recompute, and refuses the same id and version registered again with another definition.

## 7. Register it

Call `registerControlType` once in every process. The shipped types register when `control-type-library.ts` loads. For your own, register the type where your pack registers, so the API and the workers both load it: they call `registerStandardPacks` from `packages/standard-packs` at startup.

## 8. How an accepted control shows on a flight

Propose the control on a hazard, assess the risk listing it, and have a person with the authority sign the acceptance. Then `GET /v1/flights/{id}/controls`, shown as **Controls in scope** on the mission review and briefing screens, lists it for each flight it bears on:

- a control with rules shows each rule's latest result for the subjects in scope: pass, attention, insufficient or not applicable;
- an area control shows route review's result, and one whose rule found it does not apply is listed under "Do not apply to this route" with its recorded sentence;
- any other control is listed as needing a person's confirmation.

A briefing and a departure authorization pin the list the person saw by its digest. Nothing is blocked or allowed automatically: a person still releases, briefs and authorizes.

## Check your work

1. Copy `tests/unit/guides/control-type-example.test.ts`. Keep what it proves: the type registers with its pinned digest, rewording does not move the digest and a changed rule does, parameters are checked by the schema, and one evaluation gives `does_not_apply` and another `applies`.
2. If your type declares an applicability rule, add golden vectors as `tests/unit/area-reach-rule.test.ts` does.
3. Run `pnpm verify`. `tests/unit/control-types.test.ts` checks that no core module names a control type, and `tests/unit/control-applicability.test.ts` that the evaluator names none.
4. In the running app, sign in as an Alpha Dispatch person who can write safety records, open a hazard, and look for your type in **Propose a control**; after a signed acceptance, open a flight's mission review and find the control under **Controls in scope**.
