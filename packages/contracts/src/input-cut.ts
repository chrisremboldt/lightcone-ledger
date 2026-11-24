import { Type, type Static } from '@sinclair/typebox';

export const InputCutSchema = Type.Object({
  streams: Type.Record(Type.String(), Type.Integer({ minimum: 0 })),
  basisRevision: Type.Optional(Type.Integer({ minimum: 0 })),
  principalRevision: Type.Optional(Type.Integer({ minimum: 0 })),
});
export type InputCut = Static<typeof InputCutSchema>;
