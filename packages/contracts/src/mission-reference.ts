import { Type, type Static } from '@sinclair/typebox';

const Id = Type.String({ minLength: 1, maxLength: 200 });
const Revision = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const Digest = Type.String({ pattern: '^[a-f0-9]{64}$' });

/** The exact mission revision a review, release or applicability record was read against. */
export const MissionAvoidanceMissionReferenceSchema = Type.Object(
  { missionId: Id, sourceRevision: Revision, eventId: Id, contentDigest: Digest, recordDigest: Digest },
  { additionalProperties: false },
);
export type MissionAvoidanceMissionReference = Static<typeof MissionAvoidanceMissionReferenceSchema>;
