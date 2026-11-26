import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import {
  capabilityValues,
  operatorRecordObservationGrant,
  readsOnly,
  rolePresetList,
  rolePresets,
  RolePresetListResponseSchema,
} from '../../packages/contracts/src/index.js';
import { administratorCapabilities } from '../../packages/domain/src/principal-authority.js';
import {
  capabilityGroups,
  keepsRecords,
  OPERATOR_RECORD_GRANT,
  selfChangeRefusal,
  withRecordGrant,
} from '../../apps/web/src/people.js';

describe('the People screen', () => {
  it('offers every capability a person can be given, once, and nothing retired', () => {
    const offered = capabilityGroups.flatMap((group) => group.capabilities.map((item) => item.value));
    expect([...offered].sort()).toEqual([...capabilityValues].sort());
    for (const template of rolePresets)
      for (const capability of template.capabilities) expect(offered).toContain(capability);
  });

  it('starts an administrator from what org:create gives the first one', () => {
    const administrator = rolePresets.find((template) => template.key === 'administrator')!;
    expect([...administrator.capabilities].sort()).toEqual([...administratorCapabilities].sort());
  });

  it('sets or clears the operator-record grant and keeps every other grant', () => {
    const other = { sourceId: 'fictional-feed', observationType: 'fictional.reading' };
    expect(withRecordGrant([other], true)).toEqual([other, OPERATOR_RECORD_GRANT]);
    expect(withRecordGrant([other, OPERATOR_RECORD_GRANT], false)).toEqual([other]);
    expect(withRecordGrant(undefined, false)).toEqual([]);
    expect(keepsRecords({ observationGrants: [OPERATOR_RECORD_GRANT] })).toBe(true);
    expect(keepsRecords({})).toBe(false);
  });

  it('keeps an administrator from deactivating themselves or removing their own authority over people', () => {
    const self = { id: 'person-self' };
    expect(selfChangeRefusal('person-self', self, { capabilities: ['authority:write'], active: false })).toMatch(
      'cannot deactivate yourself',
    );
    expect(selfChangeRefusal('person-self', self, { capabilities: ['flight:read'], active: true })).toMatch(
      'cannot remove your own authority',
    );
    expect(selfChangeRefusal('person-self', self, { capabilities: ['authority:write'], active: true })).toBeNull();
    expect(selfChangeRefusal('person-self', { id: 'person-other' }, { capabilities: [], active: false })).toBeNull();
  });

  it('reads the presets with exactly what each grants, the operator-record grant where the preset keeps records', () => {
    const read = rolePresetList();
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const valid = ajv.compile(RolePresetListResponseSchema);
    expect(valid(read), JSON.stringify(valid.errors)).toBe(true);
    expect(read.presets.map((preset) => [preset.key, preset.title])).toEqual([
      ['dispatcher', 'Dispatcher'],
      ['pilot', 'Pilot'],
      ['safety', 'Safety manager'],
      ['administrator', 'Administrator'],
      ['reader', 'Reader'],
      ['none', 'Nothing yet'],
    ]);
    for (const preset of read.presets) {
      const shared = rolePresets.find((entry) => entry.key === preset.key)!;
      expect(preset.capabilities).toEqual(shared.capabilities);
      expect(preset.observationGrants).toEqual(shared.keepsRecords ? [operatorRecordObservationGrant] : []);
    }
    expect(OPERATOR_RECORD_GRANT).toEqual(operatorRecordObservationGrant);
    // A read is a copy: changing it changes no preset.
    read.presets[0]!.capabilities.pop();
    expect(rolePresetList().presets[0]!.capabilities).toEqual(rolePresets[0]!.capabilities);
  });

  it('gives a reader reads alone, so they change nothing; every other preset but the empty one changes something', () => {
    const reader = rolePresets.find((preset) => preset.key === 'reader')!;
    expect(reader).toMatchObject({ capabilities: ['evidence:read', 'document:read'], keepsRecords: false });
    expect(reader.capabilities).not.toContain('sms:read');
    expect(reader.capabilities).not.toContain('sms:report:read');
    expect(readsOnly(reader.capabilities)).toBe(true);
    for (const preset of rolePresets.filter((entry) => !['reader', 'none'].includes(entry.key)))
      expect(readsOnly(preset.capabilities), preset.key).toBe(false);
    // Holding nothing is not reading only: a person who holds nothing yet still reports a safety concern.
    expect(readsOnly([])).toBe(false);
    expect(readsOnly(['flight:read', 'sms:read'])).toBe(true);
    expect(readsOnly(['evidence:read', 'input:write'])).toBe(false);
  });
});
