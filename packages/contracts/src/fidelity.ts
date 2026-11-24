import { Type } from '@sinclair/typebox';

export const fidelityValues = [
  'synthetic_contract',
  'documented_schema_conformant',
  'captured_source_replay',
  'validated_sandbox',
  'validated_live',
] as const;
export type Fidelity = (typeof fidelityValues)[number];
export const FidelitySchema = Type.Union(fidelityValues.map((value) => Type.Literal(value)));
