import { readFileSync } from 'node:fs';
import type { RetainedDocumentSource } from '@ledger/contracts';
import { sha256 } from '@ledger/integrity';

export const PART107_SOURCE_ID = 'govinfo.cfr.2026.title14.vol2.part107';

/** The annual edition of the Code of Federal Regulations the retained text comes from: revised as of this date. */
export const PART107_EDITION_DATE = '2026-01-01';

/** Part 107 as published in that edition, retrieved from govinfo.gov on 2026-11-19 and kept unmodified. */
export const part107Document = Object.freeze({
  sourceId: PART107_SOURCE_ID,
  url: 'https://www.govinfo.gov/content/pkg/CFR-2026-title14-vol2/xml/CFR-2026-title14-vol2-part107.xml',
  sha256: '0c07b393796351d4a6b2fef98b330d16d1318d79a5b2bb608894a93443eed70f',
  byteLength: 86803,
  contentType: 'application/xml; charset=utf-8',
  readPath: `/v1/rule-sources/${PART107_SOURCE_ID}/content`,
} as const);

export const part107Filename = 'govinfo-cfr-2026-title14-vol2-part107.xml';

/** Where a quoted paragraph sits in the retained document, and the digest of its exact bytes. */
export interface QuotedParagraph {
  reference: string;
  start: number;
  end: number;
  sha256: string;
}

export function readRetainedDocument(): Buffer {
  const documentBytes = readFileSync(new URL(`../resources/${part107Filename}`, import.meta.url));
  if (documentBytes.length !== part107Document.byteLength || sha256(documentBytes) !== part107Document.sha256)
    throw new Error('Retained Part 107 source does not match its pinned original bytes');
  return documentBytes;
}

/** The quoted paragraph as an in-force rule source, read from the retained document; throws if its bytes changed. */
export function quotedSource(documentBytes: Buffer, paragraph: QuotedParagraph): RetainedDocumentSource {
  const { reference, start, end } = paragraph;
  const bytes = documentBytes.subarray(start, end);
  if (sha256(bytes) !== paragraph.sha256)
    throw new Error(`Retained paragraph ${reference} does not match its pinned source span`);
  return {
    kind: 'regulation',
    reference,
    text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    encoding: 'utf-8',
    byteLength: bytes.length,
    sha256: paragraph.sha256,
    textSpan: { start, end, unit: 'utf8_byte', sourceId: PART107_SOURCE_ID },
    document: { ...part107Document },
  };
}

/** A paragraph of the retained edition, by its byte span and the digest of those bytes. */
export const paragraph = (reference: string, start: number, end: number, sha256: string): QuotedParagraph => ({
  reference: `14 CFR ${reference} (edition of ${PART107_EDITION_DATE})`,
  start,
  end,
  sha256,
});
