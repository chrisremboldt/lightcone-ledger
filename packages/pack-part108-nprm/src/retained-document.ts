import { readFileSync } from 'node:fs';
import type { RetainedDocumentSource } from '@ledger/contracts';
import { sha256 } from '@ledger/integrity';

export const PART108_NPRM_SOURCE_ID = 'govinfo.fr.2025-14992';

export const part108NprmDocument = Object.freeze({
  sourceId: PART108_NPRM_SOURCE_ID,
  url: 'https://www.govinfo.gov/content/pkg/FR-2025-08-07/html/2025-14992.htm',
  sha256: '2ebbbb6d3ecfe4757a192c1850d67373e75c18d7df52136a607737ee9672f7f7',
  byteLength: 1386012,
  contentType: 'text/html; charset=utf-8',
  readPath: `/v1/rule-sources/${PART108_NPRM_SOURCE_ID}/content`,
} as const);

export const part108NprmFilename = 'govinfo-fr-2025-14992.htm';

/** Where a quoted paragraph sits in the retained notice, and the digest of its exact bytes. */
export interface QuotedParagraph {
  reference: string;
  start: number;
  end: number;
  sha256: string;
}

/** The two paragraphs version 1 quoted; kept here so later versions can quote them without importing version 1. */
export const communicationAssessmentParagraph: QuotedParagraph = {
  reference: 'Proposed 14 CFR 108.550(a)',
  start: 1290994,
  end: 1291378,
  sha256: '2e5c4a5d0a54feff4c4ff1f0c3035f5272f3061b41ea01ea6d4e6ff808066abb',
};
export const safetyManagementParagraph: QuotedParagraph = {
  reference: 'Proposed 14 CFR 108.560(a)',
  start: 1292987,
  end: 1293310,
  sha256: '8b22d0aeda2c75c88437937bdbbfce8575aa279f3541c1a946f3f789e7dd867d',
};

export function readRetainedDocument(): Buffer {
  const documentBytes = readFileSync(new URL(`../resources/${part108NprmFilename}`, import.meta.url));
  if (documentBytes.length !== part108NprmDocument.byteLength || sha256(documentBytes) !== part108NprmDocument.sha256)
    throw new Error('Retained Part 108 NPRM source does not match its pinned original bytes');
  return documentBytes;
}

/** The quoted paragraph as a rule source, read from the retained notice; throws if its bytes changed. */
export function quotedSource(documentBytes: Buffer, paragraph: QuotedParagraph): RetainedDocumentSource {
  const { reference, start, end } = paragraph;
  const bytes = documentBytes.subarray(start, end);
  if (sha256(bytes) !== paragraph.sha256)
    throw new Error(`Retained proposed paragraph ${reference} does not match its pinned source span`);
  return {
    kind: 'proposed_regulation',
    reference,
    text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    encoding: 'utf-8',
    byteLength: bytes.length,
    sha256: paragraph.sha256,
    textSpan: { start, end, unit: 'utf8_byte', sourceId: PART108_NPRM_SOURCE_ID },
    document: { ...part108NprmDocument },
  };
}
