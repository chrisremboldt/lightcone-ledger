import type { Fidelity, ObservationSubject, ObservationSubjectKind, ObservationV1 } from '@ledger/contracts';
import { canonicalize, parseStrictJson, sha256 } from '@ledger/integrity';

/** The fields every observation carries, whatever its type. */
export interface ObservationEnvelope {
  readonly type: string;
  readonly version: number;
  readonly fidelity: Fidelity;
  readonly limitations: readonly string[];
  readonly originalArtifactId: string;
  readonly originalLocator?: OriginalLocator;
}
export type OriginalLocator = NonNullable<ObservationV1['originalLocator']>;
export type JsonPointerLocator = Extract<OriginalLocator, { kind: 'json_pointer' }>;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * What translate returns for one observation. The runner adds fidelity and limitations from the descriptor
 * (extraLimitations are appended) and originalArtifactId from the sink once the original bytes are retained.
 */
export type ObservationDraft<O extends ObservationEnvelope = ObservationV1> = DistributiveOmit<
  O,
  'fidelity' | 'limitations' | 'originalArtifactId'
> & { readonly extraLimitations?: readonly string[] };

export interface ObservationTypeRef {
  readonly type: string;
  readonly version: number;
}

export interface AdapterDescriptor {
  /** Stable adapter id, for example `example-vendor-telemetry-position`. Vendor names are allowed here. */
  readonly id: string;
  /** Version of the mapping. A changed mapping is a new version. */
  readonly version: string;
  readonly source: {
    readonly vendor: string;
    readonly product: string;
    /** The interface the adapter reads, for example an MQTT topic pattern or an HTTP path. */
    readonly interface: string;
  };
  readonly produces: readonly ObservationTypeRef[];
  readonly fidelity: Fidelity;
  /** Copied into every observation. Written for a reader who does not know the vendor; never names the vendor. */
  readonly limitations: readonly string[];
  readonly documentation: readonly { readonly reference: string; readonly sha256?: string }[];
}

/** One vendor message as the runtime captured it. */
export interface VendorMessage {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  /** Transport metadata such as an MQTT topic or an HTTP method and path. */
  readonly transport: Readonly<Record<string, string>>;
  /** UTC instant at which the adapter runtime captured the message. Not a source claim. */
  readonly capturedAt: string;
}

/** How translate names subjects: by the source's own ids, or by Ledger ids the adapter is bound to. */
export type SubjectNaming =
  | { readonly scope: 'source' }
  | {
      readonly scope: 'ledger';
      readonly ids: Readonly<Partial<Record<ObservationSubjectKind, Readonly<Record<string, string>>>>>;
    };

export interface TranslationContext<Binding = undefined> {
  readonly subjects: SubjectNaming;
  /** Adapter-specific configuration, such as the device a runtime is bound to. Plain JSON data. */
  readonly binding: Binding;
}

export interface TranslationRejection {
  readonly reason: string;
  readonly locator?: OriginalLocator;
}

export interface TranslationResult<O extends ObservationEnvelope = ObservationV1> {
  readonly drafts: readonly ObservationDraft<O>[];
  readonly rejections: readonly TranslationRejection[];
  /** Fields present in the message that no observation carries. They stay in the retained original bytes. */
  readonly unmapped: readonly OriginalLocator[];
}

/** Pure and synchronous: no I/O, no clock, no randomness. Rejects malformed or ambiguous input instead of guessing. */
export type TranslateFunction<Binding = undefined, O extends ObservationEnvelope = ObservationV1> = (
  message: VendorMessage,
  context: TranslationContext<Binding>,
) => TranslationResult<O>;

export interface ObservationAdapter<Binding = undefined, O extends ObservationEnvelope = ObservationV1> {
  readonly descriptor: AdapterDescriptor;
  readonly translate: TranslateFunction<Binding, O>;
}

export interface RetainOriginalRequest {
  readonly adapterId: string;
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly sha256: string;
  readonly capturedAt: string;
}

/**
 * Where the runtime sends what translate produced: first the original bytes, then each observation citing them.
 * `HttpObservationSink` (src/http-observation-sink.ts) is the implementation over the public API.
 */
export interface ObservationSink<O extends ObservationEnvelope = ObservationV1> {
  retainOriginal(request: RetainOriginalRequest): Promise<{ readonly artifactId: string }>;
  submitObservation(observation: O, idempotencyKey: string): Promise<{ readonly receiptId: string }>;
}

export interface SubmissionOutcome<O extends ObservationEnvelope = ObservationV1> {
  readonly artifactId?: string;
  readonly submitted: readonly { readonly observation: O; readonly receiptId: string }[];
  readonly rejections: readonly TranslationRejection[];
  readonly unmapped: readonly OriginalLocator[];
}

export const typeKey = (ref: ObservationTypeRef): string => `${ref.type}@${ref.version}`;

/** Adds the descriptor's fidelity and limitations and the retained original to each draft. */
export function completeObservations<O extends ObservationEnvelope>(
  descriptor: AdapterDescriptor,
  drafts: readonly ObservationDraft<O>[],
  originalArtifactId: string,
): O[] {
  const declared = new Set(descriptor.produces.map(typeKey));
  return drafts.map((draft) => {
    const { extraLimitations, ...rest } = draft as ObservationDraft<O> & ObservationTypeRef;
    if (!declared.has(typeKey(rest)))
      throw new Error(`Adapter ${descriptor.id} produced ${typeKey(rest)}, which its descriptor does not declare`);
    return {
      ...rest,
      fidelity: descriptor.fidelity,
      limitations: [...descriptor.limitations, ...(extraLimitations ?? [])],
      originalArtifactId,
    } as unknown as O;
  });
}

/** The same message translated again gives the same keys, so a replay is idempotent at intake. */
export function observationIdempotencyKey(adapterId: string, message: VendorMessage, index: number): string {
  const identity = canonicalize({ adapterId, sha256: sha256(message.bytes), transport: message.transport, index });
  return `observation:${sha256(identity)}`;
}

/** Runs translate, retains the original bytes once, then submits every observation citing them. */
export async function translateAndSubmit<Binding, O extends ObservationEnvelope = ObservationV1>(
  adapter: ObservationAdapter<Binding, O>,
  message: VendorMessage,
  context: TranslationContext<Binding>,
  sink: ObservationSink<O>,
): Promise<SubmissionOutcome<O>> {
  const { drafts, rejections, unmapped } = adapter.translate(message, context);
  if (drafts.length === 0) return { submitted: [], rejections, unmapped };
  const { artifactId } = await sink.retainOriginal({
    adapterId: adapter.descriptor.id,
    bytes: message.bytes,
    contentType: message.contentType,
    sha256: sha256(message.bytes),
    capturedAt: message.capturedAt,
  });
  const observations = completeObservations(adapter.descriptor, drafts, artifactId);
  const submitted = [];
  for (const [index, observation] of observations.entries()) {
    const key = observationIdempotencyKey(adapter.descriptor.id, message, index);
    const { receiptId } = await sink.submitObservation(observation, key);
    submitted.push({ observation, receiptId });
  }
  return { artifactId, submitted, rejections, unmapped };
}

/** Keeps everything in memory. Same key with different content conflicts, as intake does. */
export class InMemoryObservationSink<O extends ObservationEnvelope = ObservationV1> implements ObservationSink<O> {
  readonly originals = new Map<string, { bytes: Uint8Array; contentType: string }>();
  readonly observations: { observation: O; idempotencyKey: string; receiptId: string }[] = [];
  async retainOriginal(request: RetainOriginalRequest): Promise<{ artifactId: string }> {
    const artifactId = `memory-artifact-${request.sha256}`;
    if (!this.originals.has(artifactId))
      this.originals.set(artifactId, { bytes: request.bytes.slice(), contentType: request.contentType });
    return { artifactId };
  }
  async submitObservation(observation: O, idempotencyKey: string): Promise<{ receiptId: string }> {
    const existing = this.observations.find((entry) => entry.idempotencyKey === idempotencyKey);
    if (existing) {
      if (canonicalize(existing.observation) !== canonicalize(observation))
        throw new Error(`Idempotency key ${idempotencyKey} was used with different content`);
      return { receiptId: existing.receiptId };
    }
    const receiptId = `memory-receipt-${this.observations.length + 1}`;
    this.observations.push({ observation: structuredClone(observation), idempotencyKey, receiptId });
    return { receiptId };
  }
}

// Helpers for translate functions --------------------------------------------------------------------------------

export function rejected(reason: string, locator?: OriginalLocator): TranslationResult<never> {
  return { drafts: [], rejections: [locator ? { reason, locator } : { reason }], unmapped: [] };
}

/** RFC 6901 pointer from path segments. */
export function jsonPointer(...segments: readonly (string | number)[]): JsonPointerLocator {
  return {
    kind: 'json_pointer',
    value: segments.map((segment) => `/${String(segment).replace(/~/g, '~0').replace(/\//g, '~1')}`).join(''),
  };
}

/** The subject for a source identifier, or undefined when a Ledger-scoped naming has no binding for it. */
export function subjectFor<Kind extends ObservationSubjectKind>(
  naming: SubjectNaming,
  kind: Kind,
  sourceIdentifier: string,
): (ObservationSubject & { kind: Kind }) | undefined {
  if (naming.scope === 'source') return { kind, id: sourceIdentifier, scope: 'source' };
  const ids = naming.ids[kind];
  const id = ids && Object.hasOwn(ids, sourceIdentifier) ? ids[sourceIdentifier] : undefined;
  return id ? { kind, id, scope: 'ledger' } : undefined;
}

/**
 * Decodes UTF-8 strictly and parses JSON that has no duplicate keys, within a byte bound.
 * Returns the reason instead of throwing so translate can turn it into a rejection.
 */
export function decodeStrictJson(
  bytes: Uint8Array,
  maxBytes: number,
): { ok: true; value: unknown } | { ok: false; reason: string } {
  if (bytes.byteLength === 0) return { ok: false, reason: 'Message body is empty' };
  if (bytes.byteLength > maxBytes) return { ok: false, reason: `Message body exceeds ${maxBytes} bytes` };
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: 'Message body is not valid UTF-8' };
  }
  try {
    return { ok: true, value: parseStrictJson(text, { maxBytes }) };
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
}

/** Pointers to the keys of an object that are not in the known set. Unknown nested objects are reported whole. */
export function unknownKeys(
  value: Record<string, unknown>,
  known: readonly string[],
  ...path: readonly (string | number)[]
): OriginalLocator[] {
  return Object.keys(value)
    .filter((key) => !known.includes(key))
    .sort()
    .map((key) => jsonPointer(...path, key));
}
