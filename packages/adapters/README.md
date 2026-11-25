# Adapters

Vendor-specific code lives here and nowhere else. An adapter translates what one vendor's system sends into **observations** from the shared vocabulary (`docs/design/observation-vocabulary.md`, `packages/contracts/src/observations/`). Rules read observations only, never a vendor's field names.

Vendor names may appear in this package: in adapter ids, descriptors, file names and code. They must never appear in an observation type id, an observation field name, an observation's `limitations`, or anything under `packages/contracts`. The conformance kit checks this.

The contract is in `src/adapter-contract.ts`, the kit in `src/conformance.ts`. The worked example is `src/dji-osd-position.ts` with its golden files in `src/golden/dji-osd-position/` and its test in `tests/dji-osd-position.test.ts`. Read those three alongside this guide.

## Writing an adapter

An adapter is two things: a **descriptor** and a **translate** function.

```ts
export const myAdapter: ObservationAdapter<MyBinding> = { descriptor, translate };
```

### Descriptor

```ts
const descriptor: AdapterDescriptor = {
  id: 'vendor-product-what-it-reads',   // stable; may name the vendor
  version: '1.0.0',                     // bump when the mapping changes
  source: { vendor, product, interface }, // interface: the topic pattern, path or file the adapter reads
  produces: [{ type: 'position.fix', version: 1 }],
  fidelity: 'synthetic_contract',
  limitations: [ ... ],
  documentation: [{ reference: '...', sha256: '...' }],
};
```

- `produces` lists every `type@version` translate may emit. Emitting anything else fails.
- `limitations` are copied into every observation. Write them for a reader who has never seen the vendor's documentation: say what the value is and is not ("altitude is height above the WGS84 ellipsoid, not above the takeoff point"), never "the M30 `height` field". Do not name the vendor or its products. At most 20, each at most 1000 characters. A draft may add `extraLimitations` that apply to that one observation.
- `documentation` names the vendor documentation the mapping was built from, with the SHA-256 of the pinned copy when there is one.

### Fidelity levels

The existing `Fidelity` values, from weakest to strongest:

| Value | Meaning |
| --- | --- |
| `synthetic_contract` | Built from documentation and exercised against an emulator only. No real vendor bytes. |
| `documented_schema_conformant` | Messages validate against a complete schema the vendor publishes. |
| `captured_source_replay` | Golden files include bytes captured from the real system and replayed. |
| `validated_sandbox` | Checked against the vendor's sandbox. |
| `validated_live` | Checked against the vendor's live system. |

Claim only what you have done. Every adapter in this repository is `synthetic_contract` today, except the published weather report adapter (`published-metar.ts`), at `captured_source_replay`: most of its golden files are reports fetched from the live service, each noting when and with which request.

### Translate

```ts
type TranslateFunction<Binding> = (message: VendorMessage, context: TranslationContext<Binding>) => TranslationResult;
```

- **Input:** one vendor message (`bytes`, `contentType`, `transport` such as `{ topic }` or `{ method, path }`, and `capturedAt`, when the runtime captured it) and a context: how to name subjects (`{ scope: 'source' }`, the usual case, or `{ scope: 'ledger', ids }` when the runtime is bound to Ledger ids; use `subjectFor`) and an adapter-specific `binding` such as the device a runtime is configured for.
- **Output:** `drafts` (zero or more observations without `fidelity`, `limitations` and `originalArtifactId`, which the runner fills in), `rejections` (each with a `reason`, and a `locator` when only part of the message is rejected) and `unmapped` (a locator for every field present in the message that no observation carries).
- **Pure and synchronous.** No I/O, no clock, no randomness, no mutation of its inputs. Time comes from the message, never from `Date.now()`.
- **Reject, never guess.** Malformed bytes, invalid UTF-8, duplicate JSON keys, missing or out-of-range fields, unknown enumeration words: return `rejected(reason)`. Do not throw. Use `decodeStrictJson` for JSON bodies (it rejects duplicate keys, as the telemetry decoder in `src/dji-osd.ts` does).
- **Convert units explicitly.** Every numeric observation field ends in its unit (`Meters`, `MetersPerSecond`, `Percent`, ...). Convert in code next to a comment naming the vendor's unit, even when the conversion is the identity.
- **Report what you do not map.** `unknownKeys(object, knownKeys, ...path)` returns pointers for every key you do not read. An unknown nested object is reported whole. The original bytes are retained, so unmapped fields are kept, not lost.
- When one message yields several observations, give each an `originalLocator` (a JSON pointer or byte range into the original) so it cites the part it came from.

### Running it

`translateAndSubmit(adapter, message, context, sink)` runs translate, retains the original bytes through the sink once, and submits each observation citing them, with a deterministic idempotency key so a replayed message submits the same observations again. A message with no drafts retains nothing; its rejections come back to the caller.

`ObservationSink` is the seam to the runtime. `InMemoryObservationSink` is for tests. `HttpObservationSink` sends to Ledger's public API:

```ts
const sink = new HttpObservationSink({ ledger: new LedgerClient(apiUrl, sourceToken), sourceId });
await translateAndSubmit(adapter, message, context, sink);
```

- `retainOriginal` uploads the bytes (create upload, put content, finalize) under an idempotency key made from the source id, content type and SHA-256, so the same bytes give the same artifact for every observation and adapter that cites them, including after a restart.
- `submitObservation` posts `{ sourceId, kind: 'observation', occurredAt, payload }` to `POST /v1/inputs` with the key `translateAndSubmit` derived.
- The principal behind the client needs an observation grant for `sourceId` and each type the adapter produces (`authority.update` with `observationGrants`).
- A refusal throws `ObservationSinkRefusal` with the `step`, HTTP `status` and error `code`. Nothing is retried; the caller decides. Network errors are rethrown unchanged.

`SourceLoop` (`src/source-loop.ts`) is the caller that decides, for a process that receives a stream: it submits each message in order through `submitVendorMessage` (the same step the simulator's observation capture uses), retries a submission that may pass later with capped, jittered backoff under the same keys, drops one Ledger refuses as invalid and logs why, stops on a refused credential, bounds its queue (dropping the oldest for periodic state, holding the transport for events) and flushes on stop. `BrokerSubscription` and `ServicePoll` (`src/source-transports.ts`) feed it from a broker topic or a service read. `apps/adapter-host` runs them for one source: `pnpm adapter:run`.

## Golden files

Put one JSON file per case in `src/golden/<adapter-id>/`. Each holds a vendor sample in and the expected translation out:

```json
{
  "case": "valid",
  "message": {
    "contentType": "application/json",
    "transport": { "topic": "..." },
    "capturedAt": "2026-10-01T17:00:00.250Z",
    "body": { "...": "..." }
  },
  "context": { "subjects": { "scope": "source" }, "binding": { "...": "..." } },
  "expect": {
    "observations": [{ "type": "position.fix", "version": 1, "...": "..." }],
    "rejections": [],
    "unmapped": [{ "kind": "json_pointer", "value": "/data/mode_code" }],
    "conversions": [
      {
        "observation": 0,
        "field": "/values/groundSpeedMetersPerSecond",
        "vendorField": "/data/speed_kn",
        "vendorUnit": "kn",
        "vendorValue": 20,
        "expected": 10.288888888888889
      }
    ]
  }
}
```

- `case` is `valid`, `malformed`, `ambiguous` or `rejected` (well-formed but refused, such as a value out of range or a message for another device). Non-valid cases expect no observations and at least one rejection; `reasonIncludes` matches part of the reason.
- The body is exactly one of `body` (a JSON value), `bodyText` (exact text, needed for duplicate keys or broken JSON) or `bodyBase64` (binary formats).
- `context` is optional; the test supplies a default.
- `expect.observations` are drafts, exactly as translate returns them.
- `conversions` state the vendor unit of a numeric field and the value the adapter must produce. Across all golden files, every numeric field your adapter produces must have at least one conversion entry, identity conversions included. Units the kit knows: `m km cm mm ft mi nmi`, `m/s km/h kn mph ft/s ft/min`, `deg rad`, `% fraction`, `V mV`, `degC degF K`, `s ms min h`, `count index`, `B kB KiB`.

The set must include at least one valid, one malformed and one ambiguous sample, and at least one valid sample per declared type.

## Running the kit

```ts
it('passes the conformance kit', async () => {
  await assertAdapterConformance({
    adapter: myAdapter,
    context: { subjects: { scope: 'source' }, binding },
    goldenDirectory: join(import.meta.dirname, '../src/golden/my-adapter'),
  });
});
```

`checkAdapterConformance` returns the report instead of throwing. For every golden file the kit checks that:

- translate returns, never throws, and its output equals the golden file;
- every observation validates against the registered schema for its `type@version`, and that type is declared in the descriptor;
- no type id, field name or limitation names a vendor (a built-in list, the descriptor's vendor, and any `vendorTerms` you pass);
- translate is deterministic and pure: the same message gives the same output, including with the clock and `Math.random` shifted, without network calls or changed input bytes;
- unknown fields are reported: the kit adds a field to every object of a valid JSON sample and expects each to be reported as unmapped (or the message rejected);
- malformed and ambiguous samples are rejected with a reason: the kit also rejects-tests a truncated copy, an empty body and a copy with a repeated key of each valid sample;
- unit conversions are stated and correct, and an adapter that passes a vendor value through unconverted is named as such;
- every observation carries the descriptor's fidelity and limitations and cites the retained original bytes (with a locator when one message yields several).

## Writing the emulator

Each adapter has an emulator in `apps/emulators` (see its README) so the adapter can be exercised end to end without the vendor. The emulator speaks the vendor's real interface and emits **vendor-shaped messages only**: the bytes the real system would send, never observations or anything in Ledger's vocabulary. The adapter is the only place where vendor shapes become observations. Reuse the emulator's message builder in the adapter's tests (as `tests/dji-osd-position.test.ts` does with `djiOsdBytes`) so the two cannot drift apart.
