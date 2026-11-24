import { stat } from 'node:fs/promises';
import { Ajv } from 'ajv';
import addFormats from 'ajv-formats';
import type { LedgerClient } from '@ledger/adapters';
import type { Principal } from '@ledger/contracts';
import { ApiError } from '@ledger/contracts/client';
import { canonicalDigest, sha256 } from '@ledger/integrity';
import { lockPrivateJournal, readJournalEnvelope, writeJournalEnvelope } from './private-journal.js';

// What the simulator's effectiveness actors share: refusals that keep a journal for retry, the served-contract
// check, retained actions that replay the identical request and key, and a fetcher pinned to the plan's API.

/** The actor stops without a definitive answer; the plan and journal are kept so the same action can be retried. */
export class ActorPending extends Error {
  constructor(
    public readonly code: string,
    reason: string,
  ) {
    super(reason);
    this.name = 'ActorPending';
  }
}

export function pending(code: string, reason: string): never {
  throw new ActorPending(code, reason);
}

export const isId = (value: unknown): value is string =>
  typeof value === 'string' && Boolean(value.trim()) && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
export const isDigest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const same = (left: unknown, right: unknown): boolean =>
  left !== undefined && right !== undefined && canonicalDigest(left) === canonicalDigest(right);

export function isObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

export function hasKeys(value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> {
  return (
    isObject(value) &&
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  );
}

export function apiOrigin(value: unknown): string {
  try {
    if (typeof value !== 'string') throw new Error();
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new Error();
    return url.origin;
  } catch {
    return pending('invalid_plan', 'The plan requires an explicit Ledger API origin');
  }
}

export function compile<T>(schema: object) {
  const ajv = new Ajv({ strict: false, strictNumbers: true });
  (addFormats as unknown as (instance: Ajv) => void)(ajv);
  return ajv.compile<T>(structuredClone(schema));
}

// Served contract -------------------------------------------------------------------------------------------------

function child(value: unknown, ...keys: string[]): unknown {
  let result = value;
  for (const key of keys) result = isObject(result) ? result[key] : undefined;
  return result;
}

/** A schema's meaning, without its descriptions, so documentation changes do not fail the comparison. */
function schemaMeaning(value: unknown, keyword?: string): unknown {
  if (keyword === 'const' || keyword === 'enum') return value;
  if (Array.isArray(value)) {
    const entries = value.map((entry) => schemaMeaning(entry));
    return keyword === 'required' ? entries.sort() : entries;
  }
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          keyword === 'properties' || !['description', 'title', '$comment', 'examples', 'default'].includes(key),
      )
      .map(([key, entry]) => [key, schemaMeaning(entry, keyword === 'properties' ? undefined : key)]),
  );
}

function authenticated(operation: unknown): boolean {
  const security = child(operation, 'security');
  return Array.isArray(security) && security.some((rule) => Array.isArray(child(rule, 'bearerAuth')));
}

function acceptsKey(parameters: unknown, key: string): boolean {
  if (!Array.isArray(parameters)) return false;
  const header = parameters.find(
    (entry) => child(entry, 'in') === 'header' && String(child(entry, 'name')).toLowerCase() === 'idempotency-key',
  );
  try {
    return child(header, 'required') === true && compile(child(header, 'schema') as object)(key);
  } catch {
    return false;
  }
}

/** One operation the actor relies on, as it must be served: path, method, id, body and success schema. */
export interface ServedOperation {
  path: string;
  method: 'get' | 'post';
  operationId: string;
  status: number;
  response: unknown;
  body?: unknown;
  keyed?: boolean;
}

export async function checkContract(ledger: LedgerClient, key: string, operations: ServedOperation[]): Promise<void> {
  const document = await ledger.request<unknown>('/openapi.json');
  const served = (operation: ServedOperation) => {
    const found = child(document, 'paths', operation.path, operation.method);
    return (
      authenticated(found) &&
      child(found, 'operationId') === operation.operationId &&
      (!operation.keyed || acceptsKey(child(found, 'parameters'), key)) &&
      (operation.body === undefined ||
        same(
          schemaMeaning(child(found, 'requestBody', 'content', 'application/json', 'schema')),
          schemaMeaning(operation.body),
        )) &&
      same(
        schemaMeaning(child(found, 'responses', String(operation.status), 'content', 'application/json', 'schema')),
        schemaMeaning(operation.response),
      )
    );
  };
  if (!authenticated(child(document, 'paths', '/v1/me', 'get')) || !operations.every(served))
    pending('unsupported_contract', 'The served Ledger contract does not support this action');
}

/** The plan's principal, active, in its tenant, with what the action needs. */
export async function checkPrincipal(
  ledger: LedgerClient,
  plan: { tenantId: string; principalId: string },
  capabilities: string[],
): Promise<Principal> {
  const response = await ledger.request<{ principal: Principal & { active?: boolean } }>('/v1/me');
  const principal = response?.principal;
  if (
    !principal ||
    principal.id !== plan.principalId ||
    principal.tenantId !== plan.tenantId ||
    principal.active === false ||
    !Number.isSafeInteger(principal.revision) ||
    principal.revision < 1 ||
    !Array.isArray(principal.capabilities)
  )
    pending('principal_changed', 'The action requires its original active principal and tenant');
  const missing = capabilities.filter((capability) => !principal.capabilities.includes(capability as never));
  if (missing.length) pending('capability_required', `The action requires ${missing.join(', ')}`);
  return principal;
}

/** A refusal that will not change on retry; anything else leaves the outcome uncertain. */
export function definitiveRejection(error: unknown): { status: number; code: string } | undefined {
  if (
    !(error instanceof ApiError) ||
    error.status < 400 ||
    error.status >= 500 ||
    [401, 403, 404, 408, 425, 429].includes(error.status)
  )
    return undefined;
  const code = child(error.body, 'error', 'code');
  return typeof code === 'string' && /^[a-z][a-z0-9_]{0,99}$/.test(code) ? { status: error.status, code } : undefined;
}

// Retained actions --------------------------------------------------------------------------------------------------

/** One request, kept with its exact bytes and key before it is sent, and its answer once one is known. */
export interface RetainedAction<Accepted> {
  step: string;
  key: string;
  payload: string;
  payloadSha256: string;
  status: 'submitted' | 'accepted' | 'rejected';
  accepted?: Accepted;
  rejection?: { status: number; code: string };
}

export interface ActionJournal<Accepted> {
  version: 2;
  kind: string;
  apiUrl: string;
  planDigest: string;
  tenantId: string;
  principalId: string;
  actions: RetainedAction<Accepted>[];
}

const maxJournalBytes = 1024 * 1024;

function invalidJournal(): never {
  throw new Error('The action journal commitment is invalid; refusing to reset the action');
}

export function action<Accepted>(step: string, key: string, payload: string): RetainedAction<Accepted> {
  return { step, key, payload, payloadSha256: sha256(payload), status: 'submitted' };
}

/** Checks a journal's envelope and every action's commitments; `accepted` checks what each step's answer may be. */
export function validateJournal<Accepted>(
  value: unknown,
  kind: string,
  steps: string[],
  accepted: (step: string, value: unknown) => void,
): ActionJournal<Accepted> {
  if (
    !hasKeys(value, ['version', 'kind', 'apiUrl', 'planDigest', 'tenantId', 'principalId', 'actions']) ||
    value.version !== 2 ||
    value.kind !== kind ||
    apiOrigin(value.apiUrl) !== value.apiUrl ||
    !isDigest(value.planDigest) ||
    !isId(value.tenantId) ||
    !isId(value.principalId) ||
    !Array.isArray(value.actions) ||
    value.actions.length > steps.length
  )
    return invalidJournal();
  value.actions.forEach((entry, index) => {
    if (
      !hasKeys(entry, ['step', 'key', 'payload', 'payloadSha256', 'status'], ['accepted', 'rejection']) ||
      entry.step !== steps[index] ||
      !isId(entry.key) ||
      typeof entry.payload !== 'string' ||
      Buffer.byteLength(entry.payload) > 128 * 1024 ||
      sha256(entry.payload) !== entry.payloadSha256 ||
      (entry.status === 'submitted' && (entry.accepted !== undefined || entry.rejection !== undefined)) ||
      (entry.status === 'accepted' && (entry.accepted === undefined || entry.rejection !== undefined)) ||
      (entry.status === 'rejected' && (entry.rejection === undefined || entry.accepted !== undefined)) ||
      !['submitted', 'accepted', 'rejected'].includes(String(entry.status)) ||
      (index > 0 && (value.actions as { status: string }[])[index - 1]!.status !== 'accepted')
    )
      return invalidJournal();
    if (entry.accepted !== undefined) accepted(entry.step, entry.accepted);
    if (
      entry.rejection !== undefined &&
      (!hasKeys(entry.rejection, ['status', 'code']) ||
        !Number.isSafeInteger(entry.rejection.status) ||
        typeof entry.rejection.code !== 'string' ||
        !/^[a-z][a-z0-9_]{0,99}$/.test(entry.rejection.code))
    )
      return invalidJournal();
  });
  return value as unknown as ActionJournal<Accepted>;
}

export async function readJournal<Accepted>(
  path: string,
  validate: (value: unknown) => ActionJournal<Accepted>,
): Promise<ActionJournal<Accepted> | undefined> {
  let value: unknown;
  try {
    value = await readJournalEnvelope(path, maxJournalBytes);
  } catch {
    return invalidJournal();
  }
  return value === undefined ? undefined : validate(value);
}

export async function saveJournal<Accepted>(
  path: string,
  journal: ActionJournal<Accepted>,
  validate: (value: unknown) => ActionJournal<Accepted>,
): Promise<void> {
  validate(structuredClone(journal));
  await writeJournalEnvelope(path, journal, maxJournalBytes);
}

export function lockJournal(path: string, label: string): Promise<() => Promise<void>> {
  return lockPrivateJournal(path, label);
}

/** Sends a retained action with its exact bytes and key, and keeps the answer or a definitive refusal. */
export async function submit<Accepted>(
  entry: RetainedAction<Accepted>,
  send: (body: unknown, key: string) => Promise<unknown>,
  check: (response: unknown) => Accepted,
): Promise<void> {
  const body: unknown = JSON.parse(entry.payload);
  if (JSON.stringify(body) !== entry.payload)
    pending('journal_mismatch', 'The saved request cannot be replayed with identical bytes');
  try {
    entry.accepted = check(await send(body, entry.key));
    entry.status = 'accepted';
  } catch (error) {
    const rejection = definitiveRejection(error);
    if (!rejection) throw error;
    entry.status = 'rejected';
    entry.rejection = rejection;
  }
}

// Command-line support ----------------------------------------------------------------------------------------------

export function requiredSetting(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value?.trim()) pending('configuration_missing', `${name} is required`);
  return value!;
}

export async function separatePaths(planPath: string, statePath: string): Promise<void> {
  if ([statePath, `${statePath}.lock`].includes(planPath))
    pending('configuration_invalid', 'The plan and journal require separate paths');
  const plan = await stat(planPath);
  try {
    const journal = await stat(statePath);
    if (plan.dev === journal.dev && plan.ino === journal.ino)
      pending('configuration_invalid', 'The plan and journal must not alias');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/**
 * A fetch pinned to one API origin and the requests one action may make, bounded in count, time and size. Anything
 * else is refused before it is sent.
 */
export function boundedFetcher(
  origin: string,
  fetcher: typeof fetch,
  allowed: (method: string, path: string) => boolean,
  maxResponseBytes: number,
  maxRequests = 12,
  allowedSearch: (method: string, path: string, search: string) => boolean = () => false,
): typeof fetch {
  let requests = 0;
  return async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET';
    if (
      url.origin !== origin ||
      url.username ||
      url.password ||
      (url.search && !allowedSearch(method, url.pathname, url.search)) ||
      url.hash ||
      !((method === 'GET' && ['/openapi.json', '/v1/me'].includes(url.pathname)) || allowed(method, url.pathname)) ||
      ++requests > maxRequests
    )
      pending('request_scope_invalid', 'Requests exceed their pinned API scope');
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new ActorPending('request_timeout', 'The request timed out; retain its journal')),
      5000,
    );
    try {
      const response = await fetcher(url, {
        ...init,
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        signal: controller.signal,
      });
      if (response.redirected || (response.status >= 300 && response.status < 400))
        pending('redirect_unsupported', 'Redirects are unsupported');
      const maximum = url.pathname === '/openapi.json' ? 4 * 1024 * 1024 : maxResponseBytes;
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > maximum) pending('response_too_large', 'The response exceeds its byte bound');
      return new Response(bytes.byteLength ? bytes : null, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } finally {
      clearTimeout(timer);
    }
  };
}
