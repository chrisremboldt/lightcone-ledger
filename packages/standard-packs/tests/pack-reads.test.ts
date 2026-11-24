import { describe, expect, it } from 'vitest';
import type { PackFileCheckedRule } from '@ledger/contracts';
import { readsLine } from '../src/pack-reads.js';

const plans = (name: string, required: boolean, onFile?: string) => ({
  name,
  type: 'operator.record',
  versions: [1],
  about: 'target',
  required,
  select: 'latest',
  where: [{ field: 'values.recordType', oneOf: ['flight.plan'] }],
  ...(onFile ? { onFile } : {}),
});

describe('What a built rule reads, as the build prints it', () => {
  it('says each read once when two reads take the same records, required if either is', () => {
    const rule = {
      target: { subjectKind: 'flight' },
      reads: [plans('quantity', true, 'flight plan'), plans('authority', false)],
    } as unknown as PackFileCheckedRule;
    expect(readsLine(rule)).toBe(
      'flight plan records about the flight (latest, required; without one: "No flight plan on file")',
    );
  });

  it('names the records and the related subject by what a person calls them, never by a type id', () => {
    const rule = {
      target: { subjectKind: 'flight' },
      related: [
        {
          name: 'pilot',
          subjectKind: 'person',
          fanOut: false,
          whenNone: 'empty',
          from: { read: 'assignment', field: 'values.record.personId' },
        },
      ],
      reads: [
        {
          ...plans('assignment', true, 'pilot in command assignment'),
          where: [{ field: 'values.recordType', oneOf: ['operation.role-assignment'] }],
        },
        { name: 'periods', type: 'crew.duty-period', versions: [1], about: { related: 'pilot' }, select: 'all' },
      ],
    } as unknown as PackFileCheckedRule;
    expect(readsLine(rule)).toBe(
      'role assignment records about the flight (latest, required; without one: "No pilot in command assignment on file"); duty or rest period records about the person named by its pilot in command assignment (all)',
    );
  });
});
