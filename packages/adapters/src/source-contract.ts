import { Ajv, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import type { LedgerClient } from '@ledger/contracts/client';
import { canonicalize } from '@ledger/integrity';

export function schemaValidator(): Ajv {
  const validator = new Ajv({ strict: false, strictNumbers: true });
  const installFormats = addFormats as unknown as (instance: Ajv) => void;
  installFormats(validator);
  return validator;
}

export function normalizeApiUrl(value: string, label: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error(`${label} requires an API URL without credentials, query or fragment`);
  return url.toString().replace(/\/$/, '');
}

function schemaMeaning(value: unknown, keyword?: string): unknown {
  if (keyword === 'const' || keyword === 'enum') return value;
  if (Array.isArray(value)) {
    const values = value.map((entry) => schemaMeaning(entry));
    return keyword === 'required' ? values.sort() : values;
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          keyword === 'properties' || !['description', 'title', '$comment', 'examples', 'default'].includes(key),
      )
      .map(([key, entry]) => [key, schemaMeaning(entry, keyword === 'properties' ? undefined : key)]),
  );
}

interface SourceContractRequest {
  ledger: LedgerClient;
  input: unknown;
  inputSchema: Record<string, unknown>;
  kind: string;
  key: string;
  uploadKey: string;
  filename: string;
  byteLength: number;
  unsupported: () => never;
}

export async function requireSourceContract({
  ledger,
  input,
  inputSchema: expectedInputSchema,
  kind,
  key,
  uploadKey,
  filename,
  byteLength,
  unsupported,
}: SourceContractRequest): Promise<ValidateFunction> {
  function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return unsupported();
    return value as Record<string, unknown>;
  }
  function endpoint(paths: Record<string, unknown>, path: string, method: string, mutation = false) {
    const operation = object(object(paths[path])[method]);
    if (
      !Array.isArray(operation.security) ||
      !operation.security.some((rule) => Array.isArray(object(rule).bearerAuth))
    )
      return unsupported();
    if (
      mutation &&
      (!Array.isArray(operation.parameters) ||
        !operation.parameters.some((parameter) => {
          const value = object(parameter);
          return (
            value.in === 'header' && String(value.name).toLowerCase() === 'idempotency-key' && value.required === true
          );
        }))
    )
      return unsupported();
    return operation;
  }
  function requestSchema(operation: Record<string, unknown>): Record<string, unknown> {
    return object(object(object(object(operation.requestBody).content)['application/json']).schema);
  }
  function checkKey(operation: Record<string, unknown>, value: string, validator: Ajv): void {
    const headers = (operation.parameters as unknown[])
      .map(object)
      .filter((parameter) => parameter.in === 'header' && parameter.required === true);
    if (
      headers.length !== 1 ||
      String(headers[0].name).toLowerCase() !== 'idempotency-key' ||
      !validator.compile(object(headers[0].schema))(value)
    )
      return unsupported();
  }
  const document = object(await ledger.request<unknown>('/openapi.json'));
  if (
    object(document.info).version !== '0.1.0' ||
    document['x-ledger-demo-contract-version'] !== 'ledger.demo-contract.1'
  )
    return unsupported();
  const paths = object(document.paths);
  const validator = schemaValidator();
  endpoint(paths, '/v1/me', 'get');
  const submit = endpoint(paths, '/v1/inputs', 'post', true);
  checkKey(submit, key, validator);
  const inputSchema = requestSchema(submit);
  if (!Array.isArray(inputSchema.allOf)) return unsupported();
  const clauses = inputSchema.allOf.filter(
    (clause) => object(object(object(object(clause).if).properties).kind).const === kind,
  );
  if (clauses.length !== 1) return unsupported();
  const clause = object(clauses[0]);
  if (
    canonicalize(schemaMeaning(clause.if)) !==
      canonicalize({ properties: { kind: { const: kind } }, required: ['kind'] }) ||
    canonicalize(schemaMeaning(clause.then)) !== canonicalize(schemaMeaning(expectedInputSchema))
  )
    return unsupported();
  const validate = validator.compile(inputSchema);
  if (!validate(input)) return unsupported();
  const upload = endpoint(paths, '/v1/uploads', 'post', true);
  checkKey(upload, `${uploadKey}:create`, validator);
  const uploadSchema = requestSchema(upload);
  if (!validator.compile(uploadSchema)({ contentType: 'application/json', byteLength, filename })) return unsupported();
  const content = endpoint(paths, '/v1/uploads/{id}/content', 'put', true);
  checkKey(content, `${uploadKey}:bytes`, validator);
  const binary = object(object(object(content.requestBody).content)['application/octet-stream']);
  if (canonicalize(schemaMeaning(binary.schema)) !== canonicalize({ type: 'string', format: 'binary' }))
    return unsupported();
  const finalize = endpoint(paths, '/v1/uploads/{id}/finalize', 'post', true);
  checkKey(finalize, `${uploadKey}:finalize`, validator);
  if (finalize.requestBody && object(finalize.requestBody).required === true) return unsupported();
  return validate;
}
