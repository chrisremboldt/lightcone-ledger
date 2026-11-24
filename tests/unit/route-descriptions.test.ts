import { describe, expect, it } from 'vitest';
import { openApiDocument } from '../../packages/contracts/src/openapi.js';
import { routeDescriptions } from '../../packages/contracts/src/route-descriptions.js';

// Every operation in the API reference says in one line what it does and, in its description, which capability it needs.

interface Operation {
  operationId?: string;
  summary?: unknown;
  description?: unknown;
}

const operations = Object.entries(openApiDocument.paths as Record<string, Record<string, Operation>>).flatMap(
  ([path, item]) =>
    Object.entries(item).map(([method, operation]) => ({ method: method.toUpperCase(), path, operation })),
);

describe('API reference route descriptions', () => {
  it('gives every operation a one-line summary and a description naming the capability it needs', () => {
    const problems: string[] = [];
    for (const { method, path, operation } of operations) {
      const where = `${method} ${path}`;
      const { summary, description } = operation;
      if (typeof summary !== 'string' || summary.trim() === '') problems.push(`${where}: no summary`);
      else {
        if (/[\r\n]/.test(summary)) problems.push(`${where}: summary is more than one line`);
        if (!/^[A-Z]/.test(summary)) problems.push(`${where}: summary does not start with a capital letter`);
        if (summary.trimEnd().endsWith('.')) problems.push(`${where}: summary ends with a period`);
      }
      if (typeof description !== 'string' || !description.includes('Needs '))
        problems.push(`${where}: description does not say what it needs ("Needs ...")`);
    }
    expect(problems).toEqual([]);
  });

  it('keeps away from words that read as a verdict', () => {
    const problems: string[] = [];
    for (const { method, path, operation } of operations) {
      const text = `${String(operation.summary)} ${String(operation.description)}`;
      const found = text.match(/\b(compliant|compliance|authori[sz]ed|no-go|go)\b/i);
      if (found) problems.push(`${method} ${path}: "${found[0]}"`);
    }
    expect(problems).toEqual([]);
  });

  it('has no entry for an operation the document does not have', () => {
    const operationIds = new Set(operations.map(({ operation }) => operation.operationId));
    expect(Object.keys(routeDescriptions).filter((operationId) => !operationIds.has(operationId))).toEqual([]);
  });
});
