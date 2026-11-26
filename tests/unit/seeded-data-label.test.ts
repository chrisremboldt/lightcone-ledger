import { describe, expect, test } from 'vitest';
import { seededDataLabel } from '../../apps/web/src/demo/fictional-organizations.js';

describe('what the bar calls a seeded organization’s data', () => {
  test('follows the organization, not what the signed-in person may read', () => {
    expect(seededDataLabel('tenant-alpha')).toBe('fictional operators');
    expect(seededDataLabel('tenant-beta')).toBe('fictional operators');
    expect(seededDataLabel('tenant-utility')).toBe('fictional utility');
    expect(seededDataLabel('tenant-example-ridge')).toBeNull();
  });
});
