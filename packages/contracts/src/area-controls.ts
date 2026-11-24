import { Type, type Static } from '@sinclair/typebox';
import { MissionBriefingControlRecordContentSchema } from './mission-briefing.js';

const Closed = { additionalProperties: false };
const Id = Type.String({ minLength: 1, maxLength: 200 });
const Digest = Type.String({ pattern: '^[a-f0-9]{64}$' });
const Version = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });

export const AcceptedAreaControlParamsSchema = Type.Object({ hazardId: Id, controlId: Id, version: Version }, Closed);
export type AcceptedAreaControlParams = Static<typeof AcceptedAreaControlParamsSchema>;

export const AcceptedAreaControlResponseSchema = Type.Object(
  {
    control: Type.Object(
      {
        kind: Type.Literal('control_record'),
        hazard: Type.Object({ id: Id, title: Type.String({ minLength: 1, maxLength: 200 }) }, Closed),
        controlEventId: Id,
        bodyDigest: Digest,
        owner: Type.Object({ id: Id, name: Type.String() }, Closed),
        content: MissionBriefingControlRecordContentSchema,
      },
      Closed,
    ),
  },
  {
    ...Closed,
    description:
      'One accepted area control version as route review reads it: an area control record that a risk acceptance on a safety-record hazard binds. Readable with flight:read only once accepted; a proposal or a control of another type is not found.',
  },
);
export type AcceptedAreaControlResponse = Static<typeof AcceptedAreaControlResponseSchema>;
