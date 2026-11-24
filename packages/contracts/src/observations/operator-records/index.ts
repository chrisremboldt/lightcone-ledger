import { aircraftRecordTypesV1 } from './aircraft.js';
import type { OperatorRecordDefinition } from './define.js';
import { occurrenceRecordTypesV1 } from './occurrence.js';
import { operationRecordTypesV1 } from './operation.js';
import { personRecordTypesV1 } from './person.js';

export * from './define.js';
export * from './rule-read.js';
export * from './person.js';
export * from './aircraft.js';
export * from './operation.js';
export * from './occurrence.js';

/** Every built-in operator record type, version 1. */
export const operatorRecordTypesV1: readonly OperatorRecordDefinition[] = [
  ...personRecordTypesV1,
  ...aircraftRecordTypesV1,
  ...operationRecordTypesV1,
  ...occurrenceRecordTypesV1,
];
