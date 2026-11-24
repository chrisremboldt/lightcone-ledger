import { Type, type Static } from '@sinclair/typebox';
import type { Capability, ObservationGrant, ResponseMeta } from './index.js';
import { OPERATOR_RECORD_SOURCE_ID } from './operator-record-import.js';
import { HistoryPageSchema } from './history.js';

export const PEOPLE_DIRECTORY_DEFAULT_LIMIT = 25;
export const PEOPLE_DIRECTORY_MAX_LIMIT = 100;
export const PEOPLE_DIRECTORY_MAX_PERSON_BYTES = 16 * 1024;
export const PEOPLE_DIRECTORY_MAX_RESPONSE_BYTES = 64 * 1024;

export const OrganizationPeopleQuerySchema = Type.Object(
  {
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: PEOPLE_DIRECTORY_MAX_LIMIT, default: PEOPLE_DIRECTORY_DEFAULT_LIMIT }),
    ),
    search: Type.Optional(Type.String({ maxLength: 200 })),
  },
  {
    additionalProperties: false,
    description:
      'Trimmed, case-insensitive literal substring search of human names. Omitted or empty search lists active humans. No caller-selected tenant or role filter.',
  },
);
export type OrganizationPeopleQuery = Static<typeof OrganizationPeopleQuerySchema>;

export const OrganizationPersonSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 200 }),
    name: Type.String({ maxLength: PEOPLE_DIRECTORY_MAX_PERSON_BYTES }),
    kind: Type.Literal('human'),
    revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  },
  {
    additionalProperties: false,
    description:
      'Current active human identity only, at most 16 KiB of serialized UTF-8 JSON. Directory membership grants no briefing or acknowledgement authority; mission.brief independently resolves and locks its actual recipients.',
  },
);
export type OrganizationPerson = Static<typeof OrganizationPersonSchema>;

export const OrganizationPeoplePageSchema = Type.Object(
  {
    ...HistoryPageSchema.properties,
    limit: Type.Integer({ minimum: 1, maximum: PEOPLE_DIRECTORY_MAX_LIMIT }),
    returned: Type.Integer({ minimum: 0, maximum: PEOPLE_DIRECTORY_MAX_LIMIT }),
    order: Type.Literal('id_ascending'),
    consistency: Type.Literal('live_directory'),
  },
  {
    additionalProperties: false,
    description:
      'ID keyset page scoped to the authenticated tenant, caller and authority revision, resource and normalized search, with an initial upper ID boundary. Each page reads current active humans; this is not a frozen recipient population. Restart a search to include identity changes before its cursor.',
  },
);
export type OrganizationPeoplePage = Static<typeof OrganizationPeoplePageSchema>;

export interface OrganizationPeopleResponse {
  people: OrganizationPerson[];
  page: OrganizationPeoplePage;
  meta: ResponseMeta;
}

/**
 * Starting points for a new person; each is only a set of capabilities, changed freely before adding. The People
 * screen, the API's read and the command-line client all read this one list.
 */
export const rolePresets: { key: string; title: string; capabilities: Capability[]; keepsRecords: boolean }[] = [
  {
    key: 'dispatcher',
    title: 'Dispatcher',
    capabilities: [
      'flight:read',
      'flight:create',
      'order:read',
      'evidence:read',
      'input:write',
      'decision:write',
      'correction:write',
      'identity:write',
      'mission:release',
      'briefing:write',
      'pack:adopt',
      'sms:read',
      'sms:write',
    ],
    keepsRecords: true,
  },
  {
    key: 'pilot',
    title: 'Pilot',
    capabilities: ['flight:read', 'evidence:read', 'input:write', 'briefing:ack', 'sms:read', 'sms:write'],
    keepsRecords: false,
  },
  {
    key: 'safety',
    title: 'Safety manager',
    capabilities: [
      'flight:read',
      'evidence:read',
      'input:write',
      'decision:write',
      'sms:read',
      'sms:write',
      'sms:configure',
      'sms:report:read',
      'sms:restricted:read',
    ],
    keepsRecords: true,
  },
  {
    key: 'administrator',
    title: 'Administrator',
    capabilities: [
      'authority:write',
      'flight:read',
      'flight:create',
      'order:read',
      'evidence:read',
      'input:write',
      'decision:write',
      'correction:write',
      'identity:write',
      'pack:adopt',
      'sms:read',
      'sms:write',
      'sms:configure',
      'sms:adopt',
    ],
    keepsRecords: true,
  },
  { key: 'none', title: 'Nothing yet', capabilities: [], keepsRecords: false },
];
export type RolePreset = (typeof rolePresets)[number];

/** The observation grant that lets a person import and enter operator records. */
export const operatorRecordObservationGrant: ObservationGrant = {
  sourceId: OPERATOR_RECORD_SOURCE_ID,
  observationType: 'operator.record',
};

export const RolePresetSchema = Type.Object(
  {
    key: Type.String({ minLength: 1, maxLength: 40 }),
    title: Type.String({ minLength: 1, maxLength: 80 }),
    capabilities: Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { uniqueItems: true }),
    keepsRecords: Type.Boolean({
      description: 'Whether the preset also grants importing and entering operator records.',
    }),
    observationGrants: Type.Array(
      Type.Object(
        { sourceId: Type.String({ minLength: 1 }), observationType: Type.String({ minLength: 1 }) },
        { additionalProperties: false },
      ),
      { description: 'The observation grants a person added from this preset is given.' },
    ),
  },
  { additionalProperties: false },
);
export const RolePresetListResponseSchema = Type.Object(
  { presets: Type.Array(RolePresetSchema) },
  {
    additionalProperties: false,
    description:
      'The role presets a person can be added from, each with exactly the capabilities and observation grants it gives. A preset is a starting point: person.add takes the capabilities themselves. Requires authority:write.',
  },
);
export type RolePresetListResponse = Static<typeof RolePresetListResponseSchema>;

/** The presets with what each grants, as the API's read returns them. */
export function rolePresetList(): RolePresetListResponse {
  return {
    presets: rolePresets.map((preset) => ({
      ...preset,
      capabilities: [...preset.capabilities],
      observationGrants: preset.keepsRecords ? [{ ...operatorRecordObservationGrant }] : [],
    })),
  };
}
