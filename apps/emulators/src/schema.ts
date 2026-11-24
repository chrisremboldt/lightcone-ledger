import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Ajv, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';

const files = [
  31492994, 29873889, 29873890, 29873891, 29873892, 29873893, 10829370, 10829371, 10829372, 10829373, 29742696,
  29742697, 29742698, 29742699, 29742700, 29742701, 29886782, 29744367, 29744368,
];
const ajv = new Ajv({ strict: false, allErrors: true });
const installFormats = addFormats as unknown as (instance: Ajv) => void;
installFormats(ajv);
for (const format of ['float', 'double', 'int32', 'int64'])
  ajv.addFormat(format, { type: 'number', validate: Number.isFinite });

interface ApiDocument {
  paths: Record<
    string,
    Record<
      string,
      {
        requestBody?: { content?: Record<string, { schema?: object }> };
        responses?: Record<string, { content?: Record<string, { schema?: object }> }>;
      }
    >
  >;
  components?: object;
}
export interface EndpointSchema {
  id: number;
  method: string;
  path: string;
  request?: ValidateFunction;
  response?: ValidateFunction;
}
function schemaPath(id: number): string {
  return fileURLToPath(new URL(`../vendor/airspace-link/${id}.yaml`, import.meta.url));
}

/**
 * The Airspace Link schemas not downloaded. Only the emulators, the simulated scenarios and `pnpm verify` need them
 * (`pnpm vendor:airspace`); Ledger itself builds and runs without them.
 */
export function missingAirspaceSchemas(): number[] {
  return files.filter((id) => !existsSync(schemaPath(id)));
}

function readSchema(id: number): string {
  const path = schemaPath(id);
  if (!existsSync(path)) throw new Error(`Airspace Link schema ${id} is missing. Run pnpm vendor:airspace.`);
  return readFileSync(path, 'utf8');
}

let compiled: EndpointSchema[] | undefined;
/** The emulated Airspace Link endpoints, compiled from the downloaded schemas on first use. */
export function endpointSchemas(): EndpointSchema[] {
  compiled ??= files.flatMap((id) => {
    const yaml = readSchema(id);
    const document = parse(yaml) as ApiDocument;
    return Object.entries(document.paths).flatMap(([path, methods]) =>
      Object.entries(methods).map(([method, operation]) => {
        const compile = (schema?: object): ValidateFunction | undefined =>
          schema ? ajv.compile({ ...schema, components: document.components }) : undefined;
        const request = Object.values(operation.requestBody?.content ?? {})[0]?.schema;
        const response = Object.values(operation.responses?.['200']?.content ?? {})[0]?.schema;
        return { id, method: method.toUpperCase(), path, request: compile(request), response: compile(response) };
      }),
    );
  });
  return compiled;
}

export function schemaFor(method: string, path: string): EndpointSchema | undefined {
  return endpointSchemas().find(
    (endpoint) =>
      endpoint.method === method && new RegExp(`^${endpoint.path.replace(/\{[^}]+\}/g, '[^/]+')}$`).test(path),
  );
}

export function validatePayload(
  method: string,
  path: string,
  body: unknown,
  direction: 'request' | 'response',
): { valid: boolean; errors: unknown } {
  const validator = schemaFor(method, path)?.[direction];
  return validator ? { valid: Boolean(validator(body)), errors: validator.errors } : { valid: true, errors: [] };
}
