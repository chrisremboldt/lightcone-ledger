import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import openapiTS, { astToString } from 'openapi-typescript';
import { openApiDocument } from './openapi.js';
const root = new URL('../../../', import.meta.url);
await mkdir(new URL('docs/', root), { recursive: true });
const output = new URL('./generated/api.ts', import.meta.url);
await mkdir(new URL('./generated/', import.meta.url), { recursive: true });
await writeFile(new URL('docs/openapi.json', root), JSON.stringify(openApiDocument, null, 2) + '\n');
// TypeBox's literal schema types differ from openapi-typescript's structural
// types; the generated JSON and actual HTTP responses are schema-verified.
const ast = await openapiTS(openApiDocument as unknown as Parameters<typeof openapiTS>[0]);
await writeFile(output, astToString(ast));
console.log(`Generated OpenAPI and typed routes: ${fileURLToPath(output)}`);
