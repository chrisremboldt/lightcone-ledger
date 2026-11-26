import Ajv from 'ajv';
import { describe, expect, test } from 'vitest';
import { SubjectRecordQuerySchema } from '../../packages/contracts/src/index.js';
import { flightFileQuery } from '../../apps/web/src/ReportsArea.js';

describe('one flight’s file', () => {
  test('asks the API only what its query schema accepts', () => {
    const query = flightFileQuery('ridge-flight-0042');
    const valid = new Ajv({ strict: false }).compile(SubjectRecordQuerySchema);
    expect(valid(query), JSON.stringify(valid.errors)).toBe(true);
  });
});
