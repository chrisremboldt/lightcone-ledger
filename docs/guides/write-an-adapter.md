# Write an adapter

An adapter connects Ledger to one outside system. It reads the bytes that system sends and turns them into **observations**: facts in Ledger's shared vocabulary, such as a position fix or a battery reading. Rules read observations only, never a source's own field names. So a new source means a new adapter, and no rule changes.

Code specific to one operator, vendor or product belongs in an adapter and nowhere else. Vendor names may appear in `packages/adapters` (adapter ids, descriptors, file names, code). They must never appear in an observation type id, a field name, an observation's limitations, or anywhere under `packages/contracts`. Core code never names a vendor.

This guide follows the smallest real adapter, `packages/adapters/src/dji-osd-position.ts`: one periodic aircraft state message from the DJI Cloud API becomes one `position.fix` observation. Read it with its golden files in `packages/adapters/src/golden/dji-osd-position/` and its test, `packages/adapters/tests/dji-osd-position.test.ts`. The reference for every rule the contract enforces is `packages/adapters/README.md`; this guide is the walk-through.

## Terms

- **Observation**: one closed JSON object with a `type` and `version` (such as `position.fix` version 1), a `subject` (what it is about), a time, values in named units, and `originalArtifactId`, the retained original bytes it came from. See [observation-vocabulary.md](../design/observation-vocabulary.md).
- **Original bytes**: the exact message the source sent. Ledger keeps them beside the observation, so anything the adapter did not map is still there, and anyone can check the mapping later.
- **Receipt**: what Ledger returns when it accepts an input. A receipt means the bytes are stored and work is queued.
- **Idempotency key**: a key sent with each submission. The same key with the same content returns the same receipt; the same key with different content conflicts. A replayed message therefore changes nothing.
- **Emulator**: a local stand-in for the outside system, in `apps/emulators`, that speaks its real interface so you can develop without credentials.

## 1. Pick the observation type

List what the source tells you and find the observation type that carries each fact. The types are in `packages/contracts/src/observations/`. Each states which values it carries, in which units, and what a rule may and may not infer from it. Field names end in their unit (`Meters`, `MetersPerSecond`, `Percent`), so your adapter converts every number explicitly.

If no type fits, a new fact needs a new observation type (or a new version of one), registered with `registerObservationType`. `tests/unit/made-up-problem-type.test.ts` registers a made-up `rotor.icing` type through the public registry with no core change.

## 2. Write the descriptor

The descriptor says what the adapter reads, what it produces and how far its mapping has been checked:

```ts
/** The reference adapter on the contract: one periodic aircraft state message becomes one position.fix@1. */
export const djiOsdPositionDescriptor: AdapterDescriptor = {
  id: 'dji-cloud-api-osd-position',
  version: '1.0.0',
  source: {
    vendor: 'DJI',
    product: 'DJI Cloud API',
    interface: 'MQTT device property push on thing/product/{device_sn}/osd',
  },
  produces: [{ type: 'position.fix', version: 1 }],
  fidelity: 'synthetic_contract',
  limitations: [
    'Built from pinned public documentation of a selected subset of the source’s periodic aircraft state message; not checked against a complete published schema or a real aircraft.',
    'occurredAt is the aircraft’s own clock reading; when Ledger received the message is recorded separately.',
```

- `produces` lists every type the adapter may emit. Emitting anything else fails.
- `fidelity` claims only what you have done. `synthetic_contract` means built from documentation and run against an emulator only; every adapter in this repository is at that level today.
- `limitations` are copied into every observation. Write them for a reader who has never seen the vendor's documentation, and never name the vendor in them.
- A changed mapping is a new `version`.

## 3. Write translate

`translate` takes one message and a context, and returns drafts, rejections and the fields it did not map. It is pure and synchronous: no I/O, no clock, no randomness. Time comes from the message. The position adapter, after decoding:

```ts
  const subject = subjectFor(context.subjects, 'aircraft', context.binding.deviceId);
  if (!subject) return rejected('No Ledger aircraft is bound to this device');
  return {
    drafts: [
      {
        type: 'position.fix',
        version: 1,
        subject,
        occurredAt: sample.occurredAt,
        sourceEventId: body.tid,
        position: {
          latitudeDegrees: sample.latitude,
          longitudeDegrees: sample.longitude,
          // The decoder reads height as ellipsoid height in meters, the unit its documentation states.
          ...(sample.altitudeMeters === null
            ? {}
            : { altitude: { meters: sample.altitudeMeters, datum: 'wgs84_ellipsoid' as const } }),
        },
        originalLocator: jsonPointer('data'),
        values: {
          fix: 'unknown',
          // horizontal_speed is documented in meters per second: the conversion is the identity.
          ...(sample.speedMetersPerSecond === undefined
            ? {}
            : { groundSpeedMetersPerSecond: sample.speedMetersPerSecond }),
        },
      },
    ],
    rejections: [],
    unmapped: [...unknownKeys(body, envelopeKeys), ...unknownKeys(body.data, mappedDataKeys, 'data')],
  };
```

What to notice:

- **Reject, never guess.** Malformed bytes, duplicate JSON keys, out-of-range values and messages for another device return `rejected(reason)`. They do not throw. `decodeStrictJson` refuses duplicate keys.
- **Subjects.** `subjectFor` names the aircraft by the source's own id (`scope: 'source'`), which Ledger later resolves to its own subject through aliases, or by a Ledger id the runtime is bound to.
- **Say what you do not know.** The message carries no fix quality, so `fix` is `unknown`, and a limitation says so.
- **Report what you leave out.** `unknownKeys` lists every field you did not read. They stay in the original bytes.
- **`sourceEventId`** is the source's own event id. Intake uses it, with the source, for idempotency.

## 4. Original bytes, receipts and idempotency

`translateAndSubmit` in `packages/adapters/src/adapter-contract.ts` runs translate, keeps the original bytes once, and submits each observation citing them:

```ts
/** The same message translated again gives the same keys, so a replay is idempotent at intake. */
export function observationIdempotencyKey(adapterId: string, message: VendorMessage, index: number): string {
  const identity = canonicalize({ adapterId, sha256: sha256(message.bytes), transport: message.transport, index });
  return `observation:${sha256(identity)}`;
}
```

The sink is the seam to the runtime. `InMemoryObservationSink` is for tests. `HttpObservationSink` (`src/http-observation-sink.ts`) uses the public API: it uploads the original bytes through `/v1/uploads` (create, put content, finalize) and posts each observation to `POST /v1/inputs` as input kind `observation`, getting a receipt back. Nothing writes Ledger tables directly. The principal it authenticates as needs an observation grant for the source id and each type the adapter produces. A refusal throws `ObservationSinkRefusal` with the step, status and error code; nothing is retried.

## 5. Golden files

Put one JSON file per case in `src/golden/<adapter>/`: a vendor message in, the exact drafts out. `01-fix-with-height-and-speed.json` begins:

```json
{
  "case": "valid",
  "message": {
    "contentType": "application/json",
    "transport": { "topic": "thing/product/ALPHA-AIRCRAFT-01/osd" },
    "capturedAt": "2026-10-01T17:00:00.250Z",
    "body": {
      "tid": "tid-alpha-0001",
      "bid": "bid-alpha-0001",
      "timestamp": 1790874000000,
      "gateway": "ALPHA-DOCK-01",
      "data": { "latitude": 41.88, "longitude": -87.63, "height": 220.5, "horizontal_speed": 10.2, "mode_code": 5 }
    }
  },
```

Its `expect` holds the drafts, the rejections, the unmapped fields (`/bid`, `/data/mode_code`) and a `conversions` entry for every numeric field, stating the vendor's unit even when the conversion is the identity. The set needs at least one valid, one malformed and one ambiguous case; `packages/adapters/README.md` lists the rest.

## 6. The emulator

`apps/emulators` plays the outside systems: partner orders, Airspace Link AirHub (from the pinned OpenAPI schemas that `pnpm vendor:airspace` downloads) and DJI Cloud API telemetry over the local MQTT broker. An emulator emits vendor-shaped bytes only, never observations. The adapter is the one place vendor shapes become observations.

Build your test messages with the emulator's own message builder, so the two cannot drift. The position test does this with `djiOsdBytes` from `apps/emulators/src/dji.ts`:

```ts
    const sink = new InMemoryObservationSink();
    const first = await translateAndSubmit(djiOsdPositionAdapter, message, context, sink);
    const replay = await translateAndSubmit(djiOsdPositionAdapter, message, context, sink);
    expect(replay.submitted.map((entry) => entry.receiptId)).toEqual(first.submitted.map((entry) => entry.receiptId));
    expect(sink.observations).toHaveLength(1);
    expect(sink.originals.get(first.artifactId!)?.bytes).toEqual(bytes);
```

The replay gives the same receipts and one stored observation, and the stored original is the exact bytes that were sent.

## Check your work

1. Copy `packages/adapters/tests/dji-osd-position.test.ts` and its golden directory, and rename them for your adapter. Keep three tests: the conformance kit passes on your golden files (`assertAdapterConformance`), an emulator message is submitted once and a replay changes nothing, and the descriptor's vendor name does not reach the limitations.
2. Run `pnpm verify`. The conformance kit checks that translate is pure and deterministic, that every observation validates against its registered schema, that unknown fields are reported, that malformed input is rejected, that unit conversions are stated, and that no vendor name reaches a type, field or limitation.
3. For the path through the database, copy an integration test that submits observations through the API, such as `packages/adapters/tests/wind-limit-rule.integration.test.ts`, and run it with `LEDGER_TEST_DATABASE=ledger_test_mine pnpm test:integration`.
4. In the running app, `pnpm scenario:telemetry` has the emulator publish one DJI flight over MQTT and a capture process send it to Ledger with its original bytes. Open the flight and choose **Telemetry map** to see the positions recorded. `wind-limit-rule.integration.test.ts` shows the same path for an adapter on the contract: emulator bytes, `HttpObservationSink`, receipts, then a rule's finding.
5. To connect a real source, give the adapter an entry in `apps/adapter-host/src/runnable.ts`: its transport (a broker topic or a service path to read), whether a newer message supersedes an older one, and the settings that bind it. `pnpm adapter:run <adapter id>` then receives, translates and submits with the loop in `src/source-loop.ts`, whose submitting step the simulator's observation capture also uses. [Deploy, section 10](deploy.md#10-connect-a-source-run-an-adapter) covers running it and what to check against real equipment first.
