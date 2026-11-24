import { Type, type Static } from '@sinclair/typebox';
import type { ResponseMeta } from './index.js';
import { InputCutSchema } from './input-cut.js';
import { OrganizationSchema } from './adoptions.js';

const Id = Type.String({ minLength: 1, maxLength: 200 });
const Revision = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const Digest = Type.String({ pattern: '^[a-f0-9]{64}$' });
const OrganizationTarget = Type.Object({ kind: Type.Literal('organization') }, { additionalProperties: false });
export const OrganizationSubjectSchema = Type.Object(
  { kind: Type.Literal('organization'), id: Id },
  { additionalProperties: false },
);
export const AdoptionCitationSchema = Type.Object(
  {
    id: Id,
    acceptedRevision: Revision,
    pack: Type.Object(
      { packId: Id, version: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), digest: Digest },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export const OrganizationDecisionCommandSchema = Type.Object(
  {
    kind: Type.Literal('decision.record'),
    subject: OrganizationTarget,
    expectedRevision: Revision,
    inputCut: Type.Object(
      {
        streams: Type.Record(Type.String(), Revision),
        basisRevision: Revision,
        principalRevision: Revision,
      },
      { additionalProperties: false },
    ),
    expectedDependencyBasis: Digest,
    adoption: AdoptionCitationSchema,
    decision: Type.Object(
      { kind: Type.Literal('adoption.review'), note: Type.String({ minLength: 1, maxLength: 4000 }) },
      { additionalProperties: false },
    ),
  },
  {
    additionalProperties: false,
    description: 'Record an informational review of one exact adoption for the authenticated organization.',
  },
);
export type OrganizationDecisionCommand = Static<typeof OrganizationDecisionCommandSchema>;

export const SubjectBasisManifestSchema = Type.Object(
  {
    version: Type.Literal('subject-evidence.1'),
    subjectId: Id,
    principalId: Id,
    principalRevision: Revision,
    subjects: Type.Array(Id),
    edges: Type.Array(
      Type.Object({ subjectId: Id, dependencySubjectId: Id, eventId: Id }, { additionalProperties: false }),
    ),
    frontiers: Type.Array(
      Type.Object(
        { subjectId: Id, streamId: Id, sequence: Revision, projectedSequence: Revision },
        { additionalProperties: false },
      ),
    ),
    authority: Type.Union([
      Type.Object({ streamId: Id, sequence: Revision, projectedSequence: Revision }, { additionalProperties: false }),
      Type.Null(),
    ]),
  },
  { additionalProperties: false },
);
export type SubjectBasisManifest = Static<typeof SubjectBasisManifestSchema>;
export const SubjectDecisionActorSchema = Type.Object(
  {
    id: Id,
    name: Type.String(),
    kind: Type.String(),
    principalRevision: Revision,
    capabilities: Type.Array(Type.String()),
    checkedCapabilities: Type.Array(Type.Literal('decision:write'), { minItems: 1, maxItems: 1 }),
    policyVersion: Type.Literal('ledger.organization-review-authority.1'),
    historicalProfile: Type.Literal('retained'),
    scope: OrganizationSubjectSchema,
  },
  { additionalProperties: false },
);
export const SubjectDecisionAcceptanceSchema = Type.Object(
  {
    id: Id,
    subject: OrganizationSubjectSchema,
    acceptedRevision: Revision,
    actor: SubjectDecisionActorSchema,
    adoption: AdoptionCitationSchema,
    kind: Type.Literal('adoption.review'),
    note: Type.String(),
    recordedAt: Type.String({ format: 'date-time' }),
    renderedInputCut: InputCutSchema,
    acceptedInputCut: InputCutSchema,
    acceptedBasisRevision: Revision,
    dependencyBasis: Digest,
    basisManifest: SubjectBasisManifestSchema,
  },
  { additionalProperties: false },
);
export type SubjectDecisionAcceptance = Static<typeof SubjectDecisionAcceptanceSchema>;
export const SubjectDecisionRecordSchema = Type.Object(
  {
    ...SubjectDecisionAcceptanceSchema.properties,
    processing: Type.Object(
      { status: Type.Union(['pending', 'projected', 'failed'].map((status) => Type.Literal(status))) },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type SubjectDecisionRecord = Static<typeof SubjectDecisionRecordSchema>;
export interface OrganizationDecisionsResponse {
  organization: Static<typeof OrganizationSchema>;
  decisions: SubjectDecisionRecord[];
  limit: 100;
  hasOlder: boolean;
  meta: ResponseMeta;
}
