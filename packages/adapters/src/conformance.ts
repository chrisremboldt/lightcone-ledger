import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  fidelityValues,
  findObservationType,
  observationRegistryV1,
  type ObservationRegistry,
} from '@ledger/contracts';
import { canonicalize } from '@ledger/integrity';
import type { ValidateFunction } from 'ajv';
import {
  type ObservationAdapter,
  type ObservationEnvelope,
  type OriginalLocator,
  type TranslationContext,
  type TranslationResult,
  type VendorMessage,
  InMemoryObservationSink,
  jsonPointer,
  translateAndSubmit,
  typeKey,
} from './adapter-contract.js';
import { schemaValidator } from './source-contract.js';

export type GoldenCase = 'valid' | 'malformed' | 'ambiguous' | 'rejected';

/** States the vendor unit of one numeric observation field and the value the adapter must produce. */
export interface GoldenConversion {
  /** Index of the observation in expect.observations. */
  readonly observation: number;
  /** JSON pointer into that observation, for example /values/groundSpeedMetersPerSecond. */
  readonly field: string;
  /** JSON pointer into a JSON vendor body; when given, the kit checks it holds vendorValue. */
  readonly vendorField?: string;
  readonly vendorUnit: string;
  readonly vendorValue: number;
  readonly expected: number;
  readonly tolerance?: number;
}

/** One golden file: a vendor sample in, the expected translation out. */
export interface GoldenFile<Binding = unknown> {
  readonly name: string;
  readonly case: GoldenCase;
  readonly message: {
    readonly contentType: string;
    readonly transport: Readonly<Record<string, string>>;
    readonly capturedAt: string;
    /** Exactly one of body (JSON value, serialised compactly), bodyText (exact UTF-8 text) or bodyBase64. */
    readonly body?: unknown;
    readonly bodyText?: string;
    readonly bodyBase64?: string;
  };
  readonly context?: TranslationContext<Binding>;
  readonly expect: {
    /** Drafts as translate returns them: no fidelity, limitations or originalArtifactId. */
    readonly observations: readonly unknown[];
    readonly rejections: readonly { readonly reasonIncludes: string }[];
    readonly unmapped: readonly OriginalLocator[];
    readonly conversions?: readonly GoldenConversion[];
  };
}

export type ConformanceCheck =
  | 'descriptor'
  | 'golden'
  | 'no-throw'
  | 'expected-output'
  | 'declared-types'
  | 'schema'
  | 'vendor-names'
  | 'determinism'
  | 'purity'
  | 'unmapped'
  | 'rejection'
  | 'units'
  | 'provenance';

export interface ConformanceFailure {
  readonly check: ConformanceCheck;
  readonly golden?: string;
  readonly message: string;
}

export interface ConformanceReport {
  readonly passed: boolean;
  readonly failures: readonly ConformanceFailure[];
  readonly checked: { readonly goldens: number; readonly observations: number; readonly probes: number };
}

export interface ConformanceOptions<Binding, O extends ObservationEnvelope = ObservationEnvelope> {
  readonly adapter: ObservationAdapter<Binding, O>;
  /** Context used for every golden file that does not state its own. */
  readonly context: TranslationContext<Binding>;
  /** A directory of *.json golden files, or golden files already loaded. Exactly one. */
  readonly goldenDirectory?: string;
  readonly goldens?: readonly GoldenFile<Binding>[];
  readonly registry?: ObservationRegistry;
  /** Words besides the descriptor's vendor and the built-in list that must not appear in ids, fields or limitations. */
  readonly vendorTerms?: readonly string[];
}

// Vendor and product names that must never reach type ids, field names or observation limitations.
const builtInVendorTerms = [
  'dji',
  'autel',
  'skydio',
  'parrot',
  'yuneec',
  'airhub',
  'aloft',
  'airmap',
  'dronedeploy',
  'flighthub',
  'dedrone',
  'wingcopter',
  'ardupilot',
  'px4',
  'mavlink',
  'airspace link',
  'airspacelink',
  'laanc',
];

/** The unit a field's name states. Field names end in their unit (see the observation vocabulary). */
const fieldUnits: readonly [RegExp, string][] = [
  [/MetersPerSecond$/, 'm/s'],
  [/Meters$/, 'm'],
  [/^meters$/, 'm'],
  [/Percent$/, '%'],
  [/Degrees$/, 'deg'],
  [/Volts$/, 'V'],
  [/Celsius$/, 'degC'],
  [/Seconds$/, 's'],
  [/Count$/, 'count'],
  [/Index$/, 'index'],
  [/Bytes$/, 'B'],
];

/** Vendor units the kit can check, each with the observation unit it converts to. */
const vendorUnits: Readonly<Record<string, { readonly to: string; readonly convert: (value: number) => number }>> = {
  m: { to: 'm', convert: (value) => value },
  km: { to: 'm', convert: (value) => value * 1000 },
  cm: { to: 'm', convert: (value) => value / 100 },
  mm: { to: 'm', convert: (value) => value / 1000 },
  ft: { to: 'm', convert: (value) => value * 0.3048 },
  mi: { to: 'm', convert: (value) => value * 1609.344 },
  nmi: { to: 'm', convert: (value) => value * 1852 },
  'm/s': { to: 'm/s', convert: (value) => value },
  'km/h': { to: 'm/s', convert: (value) => value / 3.6 },
  kn: { to: 'm/s', convert: (value) => (value * 1852) / 3600 },
  mph: { to: 'm/s', convert: (value) => value * 0.44704 },
  'ft/s': { to: 'm/s', convert: (value) => value * 0.3048 },
  'ft/min': { to: 'm/s', convert: (value) => value * 0.00508 },
  deg: { to: 'deg', convert: (value) => value },
  rad: { to: 'deg', convert: (value) => (value * 180) / Math.PI },
  '%': { to: '%', convert: (value) => value },
  fraction: { to: '%', convert: (value) => value * 100 },
  V: { to: 'V', convert: (value) => value },
  mV: { to: 'V', convert: (value) => value / 1000 },
  degC: { to: 'degC', convert: (value) => value },
  degF: { to: 'degC', convert: (value) => ((value - 32) * 5) / 9 },
  K: { to: 'degC', convert: (value) => value - 273.15 },
  s: { to: 's', convert: (value) => value },
  ms: { to: 's', convert: (value) => value / 1000 },
  min: { to: 's', convert: (value) => value * 60 },
  h: { to: 's', convert: (value) => value * 3600 },
  count: { to: 'count', convert: (value) => value },
  index: { to: 'index', convert: (value) => value },
  B: { to: 'B', convert: (value) => value },
  kB: { to: 'B', convert: (value) => value * 1000 },
  KiB: { to: 'B', convert: (value) => value * 1024 },
};

const probeField = 'conformanceProbeField';
const goldenCases: readonly GoldenCase[] = ['valid', 'malformed', 'ambiguous', 'rejected'];

// Golden files -----------------------------------------------------------------------------------------------------

export function loadGoldenFiles<Binding = unknown>(directory: string): GoldenFile<Binding>[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map(
      (name) =>
        ({ name, ...(JSON.parse(readFileSync(join(directory, name), 'utf8')) as object) }) as GoldenFile<Binding>,
    );
}

function goldenProblems(golden: GoldenFile<unknown>): string[] {
  const problems: string[] = [];
  const message = golden.message as GoldenFile['message'] | undefined;
  const expected = golden.expect as GoldenFile['expect'] | undefined;
  if (!goldenCases.includes(golden.case)) problems.push(`case must be one of ${goldenCases.join(', ')}`);
  if (!message || typeof message !== 'object') return [...problems, 'message is missing'];
  const bodies = ['body', 'bodyText', 'bodyBase64'].filter((key) => Object.hasOwn(message, key));
  if (bodies.length !== 1) problems.push('message needs exactly one of body, bodyText or bodyBase64');
  if (typeof message.contentType !== 'string') problems.push('message.contentType must be a string');
  if (typeof message.capturedAt !== 'string') problems.push('message.capturedAt must be a string');
  if (
    !message.transport ||
    typeof message.transport !== 'object' ||
    Object.values(message.transport).some((value) => typeof value !== 'string')
  )
    problems.push('message.transport must be an object of strings');
  if (!expected || !Array.isArray(expected.observations) || !Array.isArray(expected.unmapped))
    return [...problems, 'expect needs observations and unmapped arrays'];
  if (!Array.isArray(expected.rejections) || expected.rejections.some((entry) => !entry?.reasonIncludes))
    problems.push('expect.rejections must be an array of { reasonIncludes }');
  if (golden.case !== 'valid' && (expected.observations.length > 0 || expected.rejections.length === 0))
    problems.push(`a ${golden.case} sample must expect no observations and at least one rejection`);
  if (golden.case === 'valid' && expected.observations.length === 0)
    problems.push('a valid sample must expect at least one observation');
  return problems;
}

function messageOf(golden: GoldenFile<unknown>): VendorMessage {
  const { body, bodyText, bodyBase64, contentType, transport, capturedAt } = golden.message;
  const bytes =
    bodyBase64 !== undefined
      ? new Uint8Array(Buffer.from(bodyBase64, 'base64'))
      : new TextEncoder().encode(bodyText ?? JSON.stringify(body));
  return { bytes, contentType, transport: { ...transport }, capturedAt };
}

/** The message body as a JSON object, when it is one; probes that edit JSON apply only then. */
function jsonObjectBody(message: VendorMessage): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(message.bytes));
    return plainObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

// Small JSON utilities -----------------------------------------------------------------------------------------------

const plainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

function canonical(value: unknown): string {
  if (value === undefined) return 'nothing';
  try {
    return canonicalize(JSON.parse(JSON.stringify(value)));
  } catch {
    return '<not plain JSON>';
  }
}

function pointerSegments(pointer: string): string[] {
  return pointer
    .split('/')
    .slice(1)
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function atPointer(value: unknown, pointer: string): unknown {
  return pointerSegments(pointer).reduce<unknown>(
    (current, segment) =>
      current && typeof current === 'object' && Object.hasOwn(current, segment)
        ? (current as Record<string, unknown>)[segment]
        : undefined,
    value,
  );
}

/** Array indices become * so a conversion stated for one pack covers every pack. */
const fieldPattern = (pointer: string): string => pointer.replace(/\/\d+(?=\/|$)/g, '/*');

function numericLeaves(value: unknown, path: string[] = []): string[] {
  if (typeof value === 'number') return [jsonPointer(...path).value];
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) =>
    // Versions are not measurements, and a locator's byte offsets describe the original, not the world.
    /(^v|V)ersion$/.test(key) || key === 'originalLocator' ? [] : numericLeaves(child, [...path, key]),
  );
}

function objectPaths(value: unknown, path: string[] = []): string[][] {
  if (!value || typeof value !== 'object') return [];
  const children = Object.entries(value).flatMap(([key, child]) => objectPaths(child, [...path, key]));
  return plainObject(value) ? [path, ...children] : children;
}

function allKeys(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => [...(Array.isArray(value) ? [] : [key]), ...allKeys(child)]);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const words = (text: string): string =>
  ` ${text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()} `;

// Running translate in isolation -------------------------------------------------------------------------------------

type Run = { ok: true; result: TranslationResult<ObservationEnvelope> } | { ok: false; error: string };

/**
 * Runs translate on a copy of the message with a frozen context and network access trapped. With shifted set, the
 * clock reads a different time and Math.random a different sequence, so output that depends on them changes.
 */
function isolatedRun<Binding>(
  adapter: ObservationAdapter<Binding, ObservationEnvelope>,
  message: VendorMessage,
  context: TranslationContext<Binding>,
  shifted: boolean,
): { run: Run; impurities: string[] } {
  const impurities: string[] = [];
  const bytes = message.bytes.slice();
  const copy: VendorMessage = { ...message, bytes, transport: deepFreeze({ ...message.transport }) };
  const frozenContext = deepFreeze(structuredClone(context));
  const RealDate = globalThis.Date;
  const realRandom = Math.random;
  const realFetch = globalThis.fetch;
  const offset = 400 * 86_400_000 + 12_345;
  class ShiftedDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(RealDate.now() + offset);
      else super(...(args as [number]));
    }
    static now(): number {
      return RealDate.now() + offset;
    }
  }
  let seed = 0.731;
  globalThis.fetch = (() => {
    impurities.push('translate called fetch');
    return Promise.reject(new Error('Network access during translate'));
  }) as typeof fetch;
  if (shifted) {
    globalThis.Date = ShiftedDate as DateConstructor;
    Math.random = () => (seed = (seed * 9301 + 0.49297) % 1);
  }
  let run: Run;
  try {
    run = { ok: true, result: adapter.translate(copy, frozenContext) };
  } catch (error) {
    run = { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    globalThis.Date = RealDate;
    Math.random = realRandom;
    globalThis.fetch = realFetch;
  }
  if (Buffer.compare(Buffer.from(bytes), Buffer.from(message.bytes)) !== 0)
    impurities.push('translate changed the message bytes');
  return { run, impurities };
}

function resultShapeProblems(result: TranslationResult<ObservationEnvelope>): string[] {
  if (!result || !Array.isArray(result.drafts) || !Array.isArray(result.rejections) || !Array.isArray(result.unmapped))
    return ['translate must return drafts, rejections and unmapped arrays'];
  const problems: string[] = [];
  for (const [index, draft] of result.drafts.entries())
    for (const key of ['fidelity', 'limitations', 'originalArtifactId'])
      if (plainObject(draft) && Object.hasOwn(draft, key))
        problems.push(`draft ${index} sets ${key}; the runner fills it from the descriptor and the sink`);
  for (const rejection of result.rejections)
    if (typeof rejection?.reason !== 'string' || !rejection.reason.trim())
      problems.push('every rejection needs a reason');
  return problems;
}

// The kit --------------------------------------------------------------------------------------------------------

/**
 * Checks an adapter against its golden files. Call it from the adapter's tests and expect `passed` to be true;
 * `failures` says which check failed for which golden file.
 */
export async function checkAdapterConformance<Binding, O extends ObservationEnvelope = ObservationEnvelope>(
  options: ConformanceOptions<Binding, O>,
): Promise<ConformanceReport> {
  const adapter = options.adapter as unknown as ObservationAdapter<Binding, ObservationEnvelope>;
  const { descriptor } = adapter;
  const registry = options.registry ?? observationRegistryV1;
  const failures: ConformanceFailure[] = [];
  const fail = (check: ConformanceCheck, message: string, golden?: string) =>
    failures.push(golden === undefined ? { check, message } : { check, golden, message });
  if ((options.goldenDirectory === undefined) === (options.goldens === undefined))
    throw new Error('Pass exactly one of goldenDirectory and goldens');
  const goldens = options.goldens ?? loadGoldenFiles<Binding>(options.goldenDirectory!);
  const terms = [...builtInVendorTerms, descriptor.source.vendor, ...(options.vendorTerms ?? [])].map(words);
  const vendorTermIn = (text: string) => terms.find((term) => words(text).includes(term))?.trim();
  const counts = { goldens: goldens.length, observations: 0, probes: 0 };

  checkDescriptor();
  checkGoldenSet();

  const validators = new Map<string, ValidateFunction>();
  const ajv = schemaValidator();
  const produced = new Map<string, string>();
  const covered = new Set<string>();
  let emptyProbeDone = false;

  for (const golden of goldens) {
    const problems = goldenProblems(golden as GoldenFile<unknown>);
    if (problems.length) {
      for (const problem of problems) fail('golden', problem, golden.name);
      continue;
    }
    const message = messageOf(golden as GoldenFile<unknown>);
    const context = golden.context ?? options.context;
    const first = isolatedRun(adapter, message, context, false);
    if (!first.run.ok) {
      fail('no-throw', `translate threw instead of rejecting: ${first.run.error}`, golden.name);
      continue;
    }
    const result = first.run.result;
    const shape = resultShapeProblems(result);
    if (shape.length) {
      for (const problem of shape) fail('expected-output', problem, golden.name);
      continue;
    }
    counts.observations += result.drafts.length;
    checkPurity(golden.name, message, context, result, first.impurities);
    compareWithGolden(golden, result);
    checkDrafts(golden.name, result);
    await checkSubmission(golden.name, message, context);
    checkUnits(golden, result, message);
    if (golden.case === 'valid') {
      for (const draft of result.drafts as unknown as Record<string, unknown>[])
        for (const leaf of numericLeaves(draft))
          produced.set(`${typeKey(draft as never)} ${fieldPattern(leaf)}`, golden.name);
      probeUnknownFields(golden.name, message, context);
      probeRejections(golden.name, message, context);
    }
  }
  for (const [field, golden] of produced)
    if (!covered.has(field))
      fail('units', `no golden file states the vendor unit and expected value of ${field}`, golden);

  return { passed: failures.length === 0, failures, checked: counts };

  function checkDescriptor(): void {
    const text = (value: unknown, max = 200) =>
      typeof value === 'string' && value.trim().length > 0 && value.length <= max;
    if (!text(descriptor.id) || !text(descriptor.version))
      fail('descriptor', 'id and version must be non-empty strings');
    if (!text(descriptor.source?.vendor) || !text(descriptor.source?.product) || !text(descriptor.source?.interface))
      fail('descriptor', 'source needs vendor, product and interface');
    if (!fidelityValues.includes(descriptor.fidelity))
      fail('descriptor', `fidelity must be one of ${fidelityValues.join(', ')}`);
    if (!descriptor.produces?.length) fail('descriptor', 'produces must declare at least one observation type');
    const declared = (descriptor.produces ?? []).map(typeKey);
    if (new Set(declared).size !== declared.length) fail('descriptor', 'produces declares a type twice');
    for (const ref of descriptor.produces ?? []) {
      if (!findObservationType(registry, ref.type, ref.version))
        fail('declared-types', `${typeKey(ref)} is not a registered observation type`);
      const term = vendorTermIn(ref.type);
      if (term) fail('vendor-names', `declared type ${ref.type} names the vendor (${term})`);
    }
    if (!Array.isArray(descriptor.limitations) || descriptor.limitations.length > 20)
      fail('descriptor', 'limitations must be an array of at most 20 strings');
    for (const limitation of descriptor.limitations ?? []) {
      if (!text(limitation, 1000)) fail('descriptor', 'each limitation must be 1 to 1000 characters');
      const term = vendorTermIn(String(limitation));
      if (term) fail('vendor-names', `limitation names the vendor (${term}): ${limitation}`);
    }
    if (!descriptor.documentation?.length) fail('descriptor', 'documentation must cite at least one reference');
    for (const document of descriptor.documentation ?? []) {
      if (!text(document.reference, 1000)) fail('descriptor', 'each documentation entry needs a reference');
      if (document.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(document.sha256))
        fail('descriptor', `documentation digest must be 64 lowercase hex characters: ${document.reference}`);
    }
  }

  function checkGoldenSet(): void {
    for (const required of ['valid', 'malformed', 'ambiguous'] as const)
      if (!goldens.some((golden) => golden.case === required))
        fail('golden', `the golden files need at least one ${required} sample`);
    for (const ref of descriptor.produces ?? [])
      if (
        !goldens.some((golden) =>
          golden.expect?.observations?.some(
            (draft) => plainObject(draft) && draft.type === ref.type && draft.version === ref.version,
          ),
        )
      )
        fail('golden', `no golden file expects a ${typeKey(ref)} observation`);
  }

  function checkPurity(
    golden: string,
    message: VendorMessage,
    context: TranslationContext<Binding>,
    result: TranslationResult<ObservationEnvelope>,
    impurities: string[],
  ): void {
    const again = isolatedRun(adapter, message, context, false);
    const shifted = isolatedRun(adapter, message, context, true);
    counts.probes += 2;
    for (const impurity of new Set([...impurities, ...again.impurities, ...shifted.impurities]))
      fail('purity', impurity, golden);
    const expected = canonical(result);
    if (!again.run.ok || canonical(again.run.result) !== expected)
      fail('determinism', 'translating the same message twice gave different output', golden);
    if (!shifted.run.ok || canonical(shifted.run.result) !== expected)
      fail('purity', 'output changed when the clock or Math.random changed; translate must not read them', golden);
  }

  function compareWithGolden(golden: GoldenFile<Binding>, result: TranslationResult<ObservationEnvelope>): void {
    const expected = golden.expect;
    if (canonical(result.drafts) !== canonical(expected.observations)) {
      const index = Math.max(
        0,
        expected.observations.findIndex((draft, at) => canonical(draft) !== canonical(result.drafts[at])),
      );
      fail(
        'expected-output',
        `observations differ from the golden file (first at index ${index}): got ${canonical(result.drafts[index]).slice(0, 600)}, expected ${canonical(expected.observations[index]).slice(0, 600)}; ${result.drafts.length} produced, ${expected.observations.length} expected`,
        golden.name,
      );
    }
    if (
      result.rejections.length !== expected.rejections.length ||
      expected.rejections.some(
        ({ reasonIncludes }, index) => !result.rejections[index]!.reason.includes(reasonIncludes),
      )
    )
      fail(
        golden.case === 'valid' ? 'expected-output' : 'rejection',
        `rejections ${JSON.stringify(result.rejections.map((entry) => entry.reason))} do not match ${JSON.stringify(expected.rejections.map((entry) => entry.reasonIncludes))}`,
        golden.name,
      );
    const sorted = (locators: readonly OriginalLocator[]) => locators.map(canonical).sort();
    if (canonical(sorted(result.unmapped)) !== canonical(sorted(expected.unmapped)))
      fail(
        'unmapped',
        `unmapped fields ${JSON.stringify(sorted(result.unmapped))} do not match ${JSON.stringify(sorted(expected.unmapped))}`,
        golden.name,
      );
  }

  function checkDrafts(golden: string, result: TranslationResult<ObservationEnvelope>): void {
    const declared = new Set(descriptor.produces.map(typeKey));
    for (const draft of result.drafts) {
      const key = typeKey(draft as never);
      if (!declared.has(key)) fail('declared-types', `produced ${key}, which the descriptor does not declare`, golden);
      const term = vendorTermIn(String((draft as { type?: unknown }).type));
      if (term) fail('vendor-names', `type id ${key} names the vendor (${term})`, golden);
      for (const field of new Set(allKeys(draft))) {
        const fieldTerm = vendorTermIn(field);
        if (fieldTerm) fail('vendor-names', `field ${field} names the vendor (${fieldTerm})`, golden);
      }
      for (const limitation of (draft as { extraLimitations?: unknown[] }).extraLimitations ?? []) {
        const limitationTerm = vendorTermIn(String(limitation));
        if (limitationTerm)
          fail('vendor-names', `limitation names the vendor (${limitationTerm}): ${limitation}`, golden);
      }
    }
  }

  async function checkSubmission(
    golden: string,
    message: VendorMessage,
    context: TranslationContext<Binding>,
  ): Promise<void> {
    const sink = new InMemoryObservationSink<ObservationEnvelope>();
    let outcome;
    try {
      outcome = await translateAndSubmit(adapter, message, context, sink);
    } catch (error) {
      fail('declared-types', `submitting through a sink failed: ${(error as Error).message}`, golden);
      return;
    }
    const retained = outcome.artifactId === undefined ? undefined : sink.originals.get(outcome.artifactId);
    if (outcome.submitted.length > 0 && (!retained || Buffer.compare(retained.bytes, message.bytes) !== 0))
      fail('provenance', 'the original bytes were not retained before observations were submitted', golden);
    for (const { observation } of outcome.submitted) {
      const key = typeKey(observation);
      if (observation.originalArtifactId !== outcome.artifactId)
        fail('provenance', `${key} does not cite the retained original bytes`, golden);
      if (outcome.submitted.length > 1 && !observation.originalLocator)
        fail('provenance', `${key} needs an originalLocator: one message yielded several observations`, golden);
      if (observation.fidelity !== descriptor.fidelity)
        fail('provenance', `${key} does not carry the descriptor's fidelity`, golden);
      if (
        canonical(observation.limitations.slice(0, descriptor.limitations.length)) !== canonical(descriptor.limitations)
      )
        fail('provenance', `${key} does not carry the descriptor's limitations`, golden);
      const definition = findObservationType(registry, observation.type, observation.version);
      if (!definition) {
        fail('schema', `${key} is not a registered observation type`, golden);
        continue;
      }
      let validate = validators.get(key);
      if (!validate) validators.set(key, (validate = ajv.compile(definition.schema)));
      if (!validate(observation))
        fail('schema', `${key} does not validate: ${ajv.errorsText(validate.errors)}`, golden);
    }
  }

  function checkUnits(
    golden: GoldenFile<Binding>,
    result: TranslationResult<ObservationEnvelope>,
    message: VendorMessage,
  ): void {
    const body = jsonObjectBody(message);
    for (const conversion of golden.expect.conversions ?? []) {
      const where = `${conversion.field} of observation ${conversion.observation}`;
      const draft = result.drafts[conversion.observation] as unknown as Record<string, unknown> | undefined;
      const fieldName = pointerSegments(conversion.field).at(-1) ?? '';
      const target = fieldUnits.find(([pattern]) => pattern.test(fieldName))?.[1];
      const unit = Object.hasOwn(vendorUnits, conversion.vendorUnit) ? vendorUnits[conversion.vendorUnit] : undefined;
      const expectedDraft = golden.expect.observations[conversion.observation];
      if (plainObject(expectedDraft))
        covered.add(`${typeKey(expectedDraft as never)} ${fieldPattern(conversion.field)}`);
      if (!target) {
        fail('units', `${where}: the field name does not end in a known unit`, golden.name);
        continue;
      }
      if (!unit) {
        fail('units', `${where}: vendor unit ${conversion.vendorUnit} is not one the kit knows`, golden.name);
        continue;
      }
      if (unit.to !== target) {
        fail('units', `${where}: vendor unit ${conversion.vendorUnit} cannot convert to ${target}`, golden.name);
        continue;
      }
      const tolerance = conversion.tolerance ?? 1e-9 * Math.max(1, Math.abs(conversion.expected));
      const close = (value: number, other: number) => Math.abs(value - other) <= tolerance;
      if (!close(unit.convert(conversion.vendorValue), conversion.expected))
        fail(
          'golden',
          `${where}: ${conversion.vendorValue} ${conversion.vendorUnit} is ${unit.convert(conversion.vendorValue)} ${target}, not ${conversion.expected}`,
          golden.name,
        );
      if (
        conversion.vendorField !== undefined &&
        body &&
        atPointer(body, conversion.vendorField) !== conversion.vendorValue
      )
        fail(
          'golden',
          `${where}: the sample does not hold ${conversion.vendorValue} at ${conversion.vendorField}`,
          golden.name,
        );
      const value = draft === undefined ? undefined : atPointer(draft, conversion.field);
      if (typeof value !== 'number') {
        fail('units', `${where}: the adapter produced no number`, golden.name);
        continue;
      }
      if (close(value, conversion.expected)) continue;
      fail(
        'units',
        conversion.vendorUnit !== target && close(value, conversion.vendorValue)
          ? `${where}: produced ${value}, the unconverted vendor value in ${conversion.vendorUnit}; expected ${conversion.expected} ${target}`
          : `${where}: produced ${value}, expected ${conversion.expected} ${target}`,
        golden.name,
      );
    }
  }

  /** Adds an unknown field to every object in a JSON body; each must be reported as unmapped or the message rejected. */
  function probeUnknownFields(golden: string, message: VendorMessage, context: TranslationContext<Binding>): void {
    const body = jsonObjectBody(message);
    if (!body) return;
    for (const path of objectPaths(body)) {
      const probed = structuredClone(body);
      const target = (path.length ? atPointer(probed, jsonPointer(...path).value) : probed) as Record<string, unknown>;
      target[probeField] = 'probe';
      const pointer = jsonPointer(...path, probeField).value;
      const { run } = isolatedRun(
        adapter,
        { ...message, bytes: new TextEncoder().encode(JSON.stringify(probed)) },
        context,
        false,
      );
      counts.probes++;
      if (!run.ok) {
        fail('no-throw', `translate threw on an added field at ${pointer}: ${run.error}`, golden);
        continue;
      }
      const reported = run.result.unmapped.some(
        (locator) =>
          locator.kind === 'json_pointer' &&
          locator.value !== '' &&
          (pointer === locator.value || pointer.startsWith(`${locator.value}/`)),
      );
      const refused = run.result.drafts.length === 0 && run.result.rejections.length > 0;
      if (!reported && !refused)
        fail('unmapped', `an added field at ${pointer} was silently dropped: not reported as unmapped`, golden);
    }
  }

  /** Truncated, empty and duplicate-key versions of a valid sample must each be rejected with a reason. */
  function probeRejections(golden: string, message: VendorMessage, context: TranslationContext<Binding>): void {
    const variants: [string, Uint8Array][] = [
      ['truncated to half its length', message.bytes.slice(0, Math.floor(message.bytes.byteLength / 2))],
    ];
    if (!emptyProbeDone) {
      emptyProbeDone = true;
      variants.push(['empty', new Uint8Array()]);
    }
    const body = jsonObjectBody(message);
    const firstKey = body ? Object.keys(body)[0] : undefined;
    if (body && firstKey !== undefined) {
      const text = JSON.stringify(body);
      const duplicate = `{${JSON.stringify(firstKey)}:${JSON.stringify(body[firstKey])},${text.slice(1)}`;
      variants.push([`with the key ${firstKey} repeated`, new TextEncoder().encode(duplicate)]);
    }
    for (const [description, bytes] of variants) {
      const { run } = isolatedRun(adapter, { ...message, bytes }, context, false);
      counts.probes++;
      if (!run.ok) fail('no-throw', `translate threw on the sample ${description}: ${run.error}`, golden);
      else if (run.result.drafts.length > 0 || run.result.rejections.length === 0)
        fail('rejection', `the sample ${description} was not rejected with a reason`, golden);
    }
  }
}

/** Throws with every failure listed when the adapter does not conform. */
export async function assertAdapterConformance<Binding, O extends ObservationEnvelope = ObservationEnvelope>(
  options: ConformanceOptions<Binding, O>,
): Promise<ConformanceReport> {
  const report = await checkAdapterConformance(options);
  if (!report.passed)
    throw new Error(
      `Adapter ${options.adapter.descriptor.id} does not conform:\n${report.failures
        .map((failure) => `- [${failure.check}]${failure.golden ? ` ${failure.golden}:` : ''} ${failure.message}`)
        .join('\n')}`,
    );
  return report;
}
