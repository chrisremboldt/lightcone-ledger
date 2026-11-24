import { Type, type Static } from '@sinclair/typebox';
import type { ResponseMeta } from './index.js';
import { AdoptionParameterValuesSchema } from './checked-rules.js';
import { InputCutSchema } from './input-cut.js';
import { RulePackVersionSchema, type RulePackOrigin } from './rule-packs.js';

const Id = Type.String({ minLength: 1, maxLength: 200 });
const Digest = Type.String({ pattern: '^[a-f0-9]{64}$' });
const Revision = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const UtcTime = Type.String({ format: 'date-time', pattern: 'Z$' });
const ContentReference = Type.Object(
  { id: Id, version: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), digest: Digest },
  { additionalProperties: false },
);
export const PackAdoptionReferenceSchema = Type.Object(
  {
    packId: Id,
    version: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    digest: Digest,
    leaves: Type.Array(ContentReference, { maxItems: 100 }),
    bindings: Type.Array(ContentReference, { maxItems: 100 }),
  },
  { additionalProperties: false },
);
export const AdoptionEffectiveIntervalSchema = Type.Object(
  { start: UtcTime, end: UtcTime },
  { additionalProperties: false, description: 'A finite half-open UTC interval [start,end).' },
);
export const adoptionModeValues = ['shadow', 'active'] as const;
export type AdoptionMode = (typeof adoptionModeValues)[number];
export const AdoptionModeSchema = Type.Union(
  adoptionModeValues.map((value) => Type.Literal(value)),
  {
    description:
      'shadow: the rules are evaluated and their findings recorded and labelled, but never counted in what a person attests to. active: findings are counted. A pack that cites proposed text can only be adopted in shadow.',
  },
);
const RevisesSchema = Type.String({
  minLength: 1,
  maxLength: 200,
  description:
    'The adoption this one revises: the latest adoption of the same exact pack version, which this one replaces whole. A revision a person commands keeps the pack and changes the mode, the interval or the parameters; a revision of an adoption that succeeds an earlier version keeps its start. An adoption of the accepted-controls pack revises the adoption of its previous version. Earlier evaluations keep the mode, interval and parameters they were recorded under.',
});
const SucceedsSchema = Type.String({
  minLength: 1,
  maxLength: 200,
  description:
    'The adoption this one succeeds: an adoption of the same pack at a lower version, not revised and not already succeeded. The successor starts before that adoption’s end. Starting after its start, it takes over from then, and the earlier adoption ends where it starts. Starting at or before its start and ending at or after its end, it replaces that adoption for its whole period, which is then in effect at no instant. Both stay in the history; evaluations made under the earlier version keep it.',
});
const DisplayedCutSchema = Type.Object(
  { ...InputCutSchema.properties, basisRevision: Revision, principalRevision: Revision },
  { additionalProperties: false },
);
export const PackAdoptionCommandSchema = Type.Object(
  {
    kind: Type.Literal('rule-pack.adopt'),
    expectedRevision: Revision,
    inputCut: DisplayedCutSchema,
    expectedDependencyBasis: Digest,
    pack: PackAdoptionReferenceSchema,
    effectiveInterval: AdoptionEffectiveIntervalSchema,
    note: Type.String({ minLength: 1, maxLength: 4000 }),
    parameters: Type.Optional(AdoptionParameterValuesSchema),
    mode: AdoptionModeSchema,
    revises: Type.Optional(RevisesSchema),
    succeeds: Type.Optional(SucceedsSchema),
  },
  { additionalProperties: false, description: 'Adopt an exact pack for the authenticated tenant organization.' },
);
export type PackAdoptionCommand = Static<typeof PackAdoptionCommandSchema>;

export const PackAdoptionActorSchema = Type.Object(
  {
    id: Id,
    name: Type.String(),
    kind: Type.String(),
    principalRevision: Revision,
    capabilities: Type.Array(Type.String()),
    checkedCapabilities: Type.Array(Type.Literal('pack:adopt'), { minItems: 1, maxItems: 1 }),
    policyVersion: Type.Literal('ledger.pack-adoption-authority.1'),
  },
  { additionalProperties: false },
);
/** The pack of the rules Ledger assembles from an organization's accepted controls that a rule can check. */
export const ACCEPTED_CONTROL_PACK_ID = 'ledger.accepted-controls';
export const AcceptedControlAdoptionActorSchema = Type.Object(
  {
    id: Id,
    name: Type.String(),
    kind: Type.String(),
    principalRevision: Revision,
    capabilities: Type.Array(Type.String()),
    checkedCapabilities: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { minItems: 1, maxItems: 10 }),
    policyVersion: Type.Literal('ledger.accepted-control-rules.1'),
    decisionId: Id,
  },
  {
    additionalProperties: false,
    description:
      'The person whose safety decision changed the accepted controls, such as a signed risk acceptance or a withdrawal, with the capabilities that decision checked. That decision adopts the next version of the accepted-controls pack.',
  },
);
export const AcceptedControlBoundaryActorSchema = Type.Object(
  {
    id: Id,
    name: Type.String(),
    kind: Type.String(),
    principalRevision: Revision,
    capabilities: Type.Array(Type.String()),
    checkedCapabilities: Type.Array(Type.String(), { maxItems: 0 }),
    policyVersion: Type.Literal('ledger.accepted-control-interval.1'),
    boundaryAt: UtcTime,
    scheduledBy: Id,
  },
  {
    additionalProperties: false,
    description:
      'The worker that reassembled the accepted-controls pack when an accepted control’s effective interval started or ended (boundaryAt). scheduledBy is the safety decision whose accepted controls named that instant. No person decides anything here: the boundary was part of what a person signed.',
  },
);
export const PackAdoptionAcceptanceSchema = Type.Object(
  {
    id: Id,
    organizationId: Id,
    acceptedRevision: Revision,
    actor: Type.Union([
      PackAdoptionActorSchema,
      AcceptedControlAdoptionActorSchema,
      AcceptedControlBoundaryActorSchema,
    ]),
    pack: RulePackVersionSchema,
    scope: Type.Object({ kind: Type.Literal('organization'), organizationId: Id }, { additionalProperties: false }),
    effectiveInterval: AdoptionEffectiveIntervalSchema,
    note: Type.String(),
    parameters: Type.Optional(AdoptionParameterValuesSchema),
    mode: Type.Optional(
      Type.Union(
        adoptionModeValues.map((value) => Type.Literal(value)),
        { description: 'Absent only on adoptions accepted before modes existed; those are active.' },
      ),
    ),
    revises: Type.Optional(RevisesSchema),
    succeeds: Type.Optional(SucceedsSchema),
    renderedInputCut: InputCutSchema,
    acceptedInputCut: InputCutSchema,
    dependencyBasis: Digest,
    acceptedAt: UtcTime,
  },
  { additionalProperties: false },
);
export type PackAdoptionAcceptance = Static<typeof PackAdoptionAcceptanceSchema>;

/** The mode an adoption holds; adoptions accepted before modes existed are active. */
export function adoptionMode(acceptance: Pick<PackAdoptionAcceptance, 'mode'>): AdoptionMode {
  return acceptance.mode ?? 'active';
}
export const PackAdoptionRecordSchema = Type.Object(
  {
    ...PackAdoptionAcceptanceSchema.properties,
    mode: AdoptionModeSchema,
    revisedBy: Type.Optional(
      Type.String({ minLength: 1, maxLength: 200, description: 'The later adoption that revised this one.' }),
    ),
    succeededBy: Type.Optional(
      Type.Object(
        {
          id: Id,
          version: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
          start: UtcTime,
        },
        {
          additionalProperties: false,
          description:
            'The later adoption of a higher version that succeeds this one, its version and its start. A start at or before this adoption’s own start replaces it for its whole period.',
        },
      ),
    ),
    processing: Type.Object(
      { status: Type.Union(['pending', 'projected', 'failed'].map((value) => Type.Literal(value))) },
      { additionalProperties: false },
    ),
    state: Type.Union(
      ['pending', 'scheduled', 'effective', 'expired', 'revised', 'succeeded'].map((value) => Type.Literal(value)),
      {
        description:
          'revised: a later revision of this adoption replaces it, with its own mode, interval and parameters. succeeded: a successor adoption of a higher version has started, or replaces this one for its whole period.',
      },
    ),
    coverage: Type.Array(
      Type.Object(
        {
          leafId: Id,
          coverage: Type.Union(['automated', 'manual', 'unsupported'].map((value) => Type.Literal(value))),
          evidenceState: Type.Union(
            ['inactive', 'manual_review_required', 'unsupported'].map((value) => Type.Literal(value)),
          ),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type PackAdoptionRecord = Static<typeof PackAdoptionRecordSchema>;
export const OrganizationSchema = Type.Object(
  { id: Id, label: Type.String(), revision: Revision, projectedRevision: Revision },
  { additionalProperties: false },
);
export interface OrganizationCoverageResponse {
  organization: Static<typeof OrganizationSchema>;
  asOf: string;
  adoptions: PackAdoptionRecord[];
  /** Where each registered pack version the adoptions name came from, once per version. */
  packOrigins: { packId: string; version: number; origin: RulePackOrigin }[];
  limit: 100;
  hasOlder: boolean;
  meta: ResponseMeta;
}
export const RuleSourceParamsSchema = Type.Object({ sourceId: Id }, { additionalProperties: false });
export type RuleSourceParams = Static<typeof RuleSourceParamsSchema>;
