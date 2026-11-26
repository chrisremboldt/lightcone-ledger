import { Value } from '@sinclair/typebox/value';
import { ProgramViewDocumentSchema, type ProgramViewDocument } from './program-view.js';

/**
 * Whether an answer read over the network is a program view document this Ledger reads. Kept apart from the
 * contracts' index so the web app does not carry the checker.
 */
export function isProgramViewDocument(value: unknown): value is ProgramViewDocument {
  return Value.Check(ProgramViewDocumentSchema, value);
}
