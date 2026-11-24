import { Ajv } from 'ajv';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import {
  CommandSchema,
  InputSchema,
  requestShapeRefusal,
  standardObservationRegistry,
  type SchemaError,
} from '../../packages/contracts/src/index.js';
import { validateObservation } from '../../packages/domain/src/observation-registry.js';

// The options the API's validator runs with.
const ajv = new Ajv({
  coerceTypes: 'array',
  useDefaults: true,
  removeAdditional: false,
  allowUnionTypes: true,
  allErrors: false,
  verbose: true,
});
(addFormats as unknown as (instance: Ajv) => void)(ajv);

function refusal(schema: object, body: unknown, part = 'body'): string {
  const validate = ajv.compile(schema);
  expect(validate(body)).toBe(false);
  return requestShapeRefusal(validate.errors as SchemaError[], part);
}

const rawPhrase = /must NOT|must match|must have required|must be equal|must pass|schema in/;

const payload = {
  type: 'flight.record',
  version: 1,
  subject: { kind: 'aircraft', id: 'RIDGE-AC-1' },
  occurredAt: '2026-11-10T15:00:00Z',
};
const observationInput = { sourceId: 'ridge-log', kind: 'observation', occurredAt: payload.occurredAt, payload };

describe('A request refused for its shape', () => {
  it('names a property an input must not carry and why, instead of saying the body must not be valid', () => {
    const beside = refusal(InputSchema, { ...observationInput, subject: { flightId: 'RIDGE-F-1' } });
    expect(beside).toBe(
      'The request body has subject, which is not taken here. An observation input states its subject, session, time of effect, revision, original file and fidelity inside its payload, not beside it.',
    );
    const replaces = refusal(InputSchema, {
      sourceId: 'ridge-orders',
      kind: 'order.revision',
      occurredAt: payload.occurredAt,
      subject: { orderId: 'RIDGE-O-1' },
      payload: {},
      replaces: 'obs-1',
    });
    expect(replaces).toBe(
      'The request body has replaces, which is not taken here. Only an input of kind observation replaces an earlier one.',
    );
  });

  it('says which form of a union was meant and what it lacks, or which forms there are', () => {
    expect(refusal(CommandSchema, { kind: 'finding.treat-many' })).toBe(
      'The request body has no selection, which is required.',
    );
    const unknown = refusal(CommandSchema, { kind: 'finding.forget' });
    expect(unknown).toMatch(/^kind "finding.forget" is not one Ledger takes here\. It is one of "decision.record", /);
    expect(unknown.match(/"decision.record"/g)).toHaveLength(1);
    expect(refusal(CommandSchema, {})).toMatch(/^The request body has no kind, which is required\. It is one of /);
    expect(refusal({ anyOf: [{ const: 'day' }, { const: 'night' }] }, 'dusk')).toBe(
      'The request body must be one of "day", "night"; it is "dusk".',
    );
    expect(
      refusal(
        { type: 'object', properties: { limit: { anyOf: [{ type: 'integer' }, { type: 'null' }] } } },
        { limit: 'many' },
      ),
    ).toBe('limit must be a whole number or null; it is text.');
  });

  it('names the property and what was expected for each kind of failure', () => {
    const shape = {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 5 },
        count: { type: 'integer', minimum: 1 },
        at: { type: 'string', format: 'date-time' },
        tags: { type: 'array', items: { type: 'string' }, uniqueItems: true, maxItems: 2 },
      },
      required: ['name'],
      additionalProperties: false,
    };
    expect(refusal(shape, {})).toBe('The request body has no name, which is required.');
    expect(refusal(shape, { name: '' })).toBe('name must not be empty.');
    expect(refusal(shape, { name: 'abcdefg' })).toBe('name must be at most 5 characters long.');
    expect(refusal(shape, { name: 'a', count: 0 })).toBe('count must be at least 1; it is 0.');
    expect(refusal(shape, { name: 'a', at: 'today' })).toBe(
      'at must be a date and time with its offset, such as 2026-11-10T15:00:00Z; it is "today".',
    );
    expect(refusal(shape, { name: 'a', tags: ['x', 'x'] })).toBe('tags lists the same item twice, at 0 and 1.');
    expect(refusal(shape, { name: 'a', colour: 'red' })).toBe(
      'The request body has colour, which it does not take. It takes name, count, at, tags.',
    );
    expect(
      refusal({ type: 'object', properties: { version: { type: 'integer' } } }, { version: 'latest' }, 'params'),
    ).toBe('Path parameter version must be a whole number; it is text.');
  });

  it('reads an observation refused by its registered schema the same way', () => {
    let message = '';
    try {
      validateObservation(standardObservationRegistry, {
        ...payload,
        type: 'battery.state',
        values: { unexpected: true },
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/^Observation battery.state@1: /);
    expect(message).not.toMatch(rawPhrase);
  });

  it('never answers with a validator phrase', () => {
    const cases: [object, unknown][] = [
      [InputSchema, { ...observationInput, subject: { flightId: 'RIDGE-F-1' } }],
      [InputSchema, { ...observationInput, kind: 'unknown' }],
      [CommandSchema, { kind: 'finding.treat-many' }],
      [CommandSchema, {}],
    ];
    for (const [schema, body] of cases) expect(refusal(schema, body)).not.toMatch(rawPhrase);
  });
});
