import { useEffect, useState } from 'react';
import type { LedgerClient } from '@ledger/contracts/client';
import type { SmsAttachment } from '@ledger/contracts';
import { Button, Notice, Spinner } from '@ledger/ui';
import { checkDocumentFile } from './sms-document-reader.js';
import { plainError } from './sms-labels.js';
import { loadPdf } from './sms-pdf.js';
import { comparePdfText, pageText, type PageChange, type PdfComparison, type WordPiece } from './sms-pdf-compare.js';

const CONTEXT_WORDS = 10;
const EXCERPT_WORDS = 40;

async function pdfPages(client: LedgerClient, file: SmsAttachment): Promise<string[]> {
  const { bytes } = await client.download(`/v1/sms/attachments/${encodeURIComponent(file.id)}/content`);
  await checkDocumentFile(bytes, file);
  const loading = loadPdf(bytes);
  let encrypted = false;
  loading.onPassword = () => {
    encrypted = true;
    void loading.destroy().catch(() => {});
  };
  try {
    const pdf = await loading.promise;
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(pageText(content.items.map((item) => ('str' in item ? item.str : ''))));
      page.cleanup();
    }
    return pages;
  } catch (error) {
    if (encrypted) throw new Error(`${file.label} is encrypted, so its pages cannot be compared.`);
    throw error;
  } finally {
    void loading.destroy().catch(() => {});
  }
}

function fold(text: string, keepStart: number, keepEnd: number): string {
  const words = text.split(' ');
  if (words.length <= keepStart + keepEnd + 1) return text;
  return [...words.slice(0, keepStart), '…', ...words.slice(words.length - keepEnd)].join(' ').trim();
}

function foldContext(pieces: WordPiece[], index: number): string {
  const keepStart = index === 0 ? 0 : CONTEXT_WORDS;
  const keepEnd = index === pieces.length - 1 ? 0 : CONTEXT_WORDS;
  return fold(pieces[index]!.text, keepStart, keepEnd);
}

function isFolded(page: PageChange): boolean {
  if (page.kind !== 'changed') return fold(page.text, EXCERPT_WORDS, 0) !== page.text;
  return page.pieces.some((piece, index) => piece.kind === 'same' && foldContext(page.pieces, index) !== piece.text);
}

function Pieces({ pieces, whole }: { pieces: WordPiece[]; whole: boolean }) {
  return pieces.map((piece, index) => {
    const separator = index ? ' ' : '';
    if (piece.kind === 'same') {
      return (
        <span key={index}>
          {separator}
          {whole ? piece.text : foldContext(pieces, index)}
        </span>
      );
    }
    const Tag = piece.kind === 'added' ? 'ins' : 'del';
    return (
      <span key={index}>
        {separator}
        <Tag className={piece.running ? 'is-running' : undefined}>
          <span className="sr-only">{piece.kind === 'added' ? 'Added: ' : 'Removed: '}</span>
          {piece.text}
        </Tag>
      </span>
    );
  });
}

function pageHeading(page: PageChange, fromLabel: string, toLabel: string): [string, string] {
  if (page.kind === 'added') return [`Page ${page.toPage}`, `Added in ${toLabel}`];
  if (page.kind === 'removed') return [`Page ${page.fromPage} of ${fromLabel}`, 'Removed'];
  return [page.fromPage === page.toPage ? `Page ${page.toPage}` : `Page ${page.fromPage} → ${page.toPage}`, 'Changed'];
}

function PageEntry({ page, fromLabel, toLabel }: { page: PageChange; fromLabel: string; toLabel: string }) {
  const [whole, setWhole] = useState(false);
  const [heading, kind] = pageHeading(page, fromLabel, toLabel);
  const folded = isFolded(page);
  return (
    <li className={`sms-pdf-page sms-pdf-page--${page.kind}`}>
      <div className="sms-pdf-page-head">
        <strong>{heading}</strong>
        <span>{kind}</span>
      </div>
      <div className="sms-pdf-page-body">
        <p>
          {page.kind === 'changed' ? (
            <Pieces pieces={page.pieces} whole={whole} />
          ) : whole ? (
            page.text
          ) : (
            fold(page.text, EXCERPT_WORDS, 0) || <span className="muted">No text on this page.</span>
          )}
        </p>
        {folded && (
          <Button kind="quiet" aria-expanded={whole} onClick={() => setWhole((value) => !value)}>
            {whole ? (page.kind === 'changed' ? 'Show changes only' : 'Show less') : 'Show whole page'}
          </Button>
        )}
      </div>
    </li>
  );
}

function nothingMatched(comparison: PdfComparison): boolean {
  return (
    comparison.fromPages > 0 &&
    comparison.toPages > 0 &&
    comparison.unchanged === 0 &&
    comparison.pages.every((page) => page.kind !== 'changed')
  );
}

function summary(comparison: PdfComparison): string {
  const count = (kind: PageChange['kind']) => comparison.pages.filter((page) => page.kind === kind).length;
  const parts = [`${count('changed')} changed`, `${count('added')} added`, `${count('removed')} removed`];
  return `${parts.join(', ')} · ${comparison.unchanged} unchanged · ${comparison.fromPages} → ${comparison.toPages} pages`;
}

export default function SmsPdfCompare({
  client,
  from,
  to,
  fromLabel,
  toLabel,
}: {
  client: LedgerClient;
  from: SmsAttachment;
  to: SmsAttachment;
  fromLabel: string;
  toLabel: string;
}) {
  const [result, setResult] = useState<{ comparison: PdfComparison; textless: boolean } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let stopped = false;
    setResult(null);
    setFailure(null);
    Promise.all([pdfPages(client, from), pdfPages(client, to)])
      .then(([before, after]) => {
        if (stopped) return;
        setResult({
          comparison: comparePdfText(before, after),
          textless: !before.some(Boolean) || !after.some(Boolean),
        });
      })
      .catch((error: unknown) => {
        if (!stopped) setFailure(plainError(error).message);
      });
    return () => {
      stopped = true;
    };
    // Polling replaces the attachment objects without changing the files, so only their ids restart the comparison.
  }, [client, from.id, to.id, attempt]);
  if (failure)
    return (
      <Notice tone="alert" title="Pages could not be compared">
        {failure}
        <Button kind="quiet" onClick={() => setAttempt((value) => value + 1)}>
          Try again
        </Button>
      </Notice>
    );
  if (!result) return <Spinner label="Reading the text of both PDFs" />;
  if (result.textless)
    return (
      <Notice title="No text to compare">
        One of these PDFs has no text layer, such as a scan. Open each revision in the reader and compare its pages.
      </Notice>
    );
  const { comparison } = result;
  return (
    <div className="sms-pdf-compare" aria-label="Page changes" role="group">
      <p className="sms-pdf-summary">{summary(comparison)}</p>
      {comparison.running.length > 0 && (
        <p className="sms-pdf-running">
          <span className="sms-field-label">On most pages</span>
          {comparison.running.map((change, index) => (
            <span key={index}>
              {change.removed && <del>{change.removed}</del>}
              {change.removed && change.added && ' → '}
              {change.added && <ins>{change.added}</ins>}
            </span>
          ))}
        </p>
      )}
      {comparison.pages.length === 0 ? (
        <p className="muted">No wording changed on any page.</p>
      ) : (
        <>
          {nothingMatched(comparison) && (
            <Notice title="No pages matched">
              No page of the earlier file reads like a page of the later one, so every page is listed as removed or
              added. Check that each revision has the right file attached.
            </Notice>
          )}
          <ol className="sms-pdf-pages">
            {comparison.pages.map((page) => (
              <PageEntry
                key={`${page.kind}-${page.kind === 'removed' ? page.fromPage : page.toPage}`}
                page={page}
                fromLabel={fromLabel}
                toLabel={toLabel}
              />
            ))}
          </ol>
        </>
      )}
    </div>
  );
}
