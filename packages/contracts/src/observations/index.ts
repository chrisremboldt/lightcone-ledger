import { operatorRecordTypesV1 } from './operator-records/index.js';
import {
  emptyObservationRegistry,
  registerObservationType,
  registerOperatorRecordType,
  type ObservationRegistry,
} from './registry.js';
import { observationTypesV1 } from './types-v1.js';

export {
  AltitudeSchema,
  DocumentPurposeIdPattern,
  DocumentPurposeIdSchema,
  DocumentTypeIdSchema,
  DocumentTypesSchema,
  ObservationHeaderSchema,
  ObservationIntervalSchema,
  ObservationPositionSchema,
  ObservationSubjectSchema,
  ObservationTypeIdPattern,
  ObservationTypeIdSchema,
  ObservationVersionSchema,
  altitudeDatumValues,
  observationSubjectKindValues,
  observationSubjectScopeValues,
  type ObservationHeader,
  type ObservationInterval,
  type ObservationPosition,
  type ObservationSubject,
  type ObservationSubjectKind,
} from './envelope.js';
export * from './registry.js';
export * from './types-v1.js';
export * from './operator-records/index.js';

/** Every built-in observation type, without operator record types. */
export const observationRegistryV1: ObservationRegistry = observationTypesV1.reduce(
  registerObservationType,
  emptyObservationRegistry,
);

/** The default registry: the vocabulary types plus every built-in operator record type. */
export const standardObservationRegistry: ObservationRegistry = operatorRecordTypesV1.reduce(
  registerOperatorRecordType,
  observationRegistryV1,
);
