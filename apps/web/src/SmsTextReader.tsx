import { Fragment, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Button } from '@ledger/ui';
import {
  documentTextMatches,
  documentTextParts,
  documentTextSections,
  nextDocumentMatch,
  type DocumentTextPart,
} from './sms-document-text.js';
import { styledPart } from './SmsDocumentText.js';

function scrollReaderTo(pane: HTMLDivElement | null, target: HTMLElement | null, center = false) {
  if (!pane || !target) return;
  const position = target.getBoundingClientRect();
  const top = position.top - pane.getBoundingClientRect().top + pane.scrollTop;
  pane.scrollTo({ top: Math.max(0, top - (center ? (pane.clientHeight - position.height) / 2 : 16)) });
}

/** Keeps each heading line together so section navigation focuses the whole heading. */
function headingLines(parts: DocumentTextPart[]): { sectionIndex: number | null; parts: DocumentTextPart[] }[] {
  const lines: { sectionIndex: number | null; parts: DocumentTextPart[] }[] = [];
  for (const part of parts) {
    const line = lines[lines.length - 1];
    if (part.sectionIndex === null && part.heading !== null && line?.sectionIndex != null) line.parts.push(part);
    else lines.push({ sectionIndex: part.sectionIndex, parts: [part] });
  }
  return lines;
}

export default function SmsTextReader({ text, label = 'Document text' }: { text: string; label?: string }) {
  const searchId = useId();
  const [query, setQuery] = useState('');
  const [selectedMatch, setSelectedMatch] = useState(0);
  const pane = useRef<HTMLDivElement>(null);
  const currentMatch = useRef<HTMLElement | null>(null);
  const sectionElements = useRef(new Map<number, HTMLSpanElement>());
  const sections = useMemo(() => documentTextSections(text), [text]);
  const matches = useMemo(() => documentTextMatches(text, query), [text, query]);
  const parts = useMemo(() => documentTextParts(text, matches, sections), [text, matches, sections]);
  const activeMatch = matches.length ? ((selectedMatch % matches.length) + matches.length) % matches.length : -1;

  useEffect(() => {
    scrollReaderTo(pane.current, currentMatch.current, true);
  }, [activeMatch, matches]);

  function moveMatch(direction: 1 | -1) {
    setSelectedMatch((current) => nextDocumentMatch(current, matches.length, direction));
  }

  function searchKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    moveMatch(event.shiftKey ? -1 : 1);
  }

  function openSection(index: number) {
    const target = sectionElements.current.get(index);
    scrollReaderTo(pane.current, target ?? null);
    target?.focus({ preventScroll: true });
  }

  return (
    <div className="sms-text-reader">
      <div className="sms-text-reader-toolbar">
        <label className="sms-text-reader-search" htmlFor={searchId}>
          Search {label.toLowerCase()}
          <input
            id={searchId}
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelectedMatch(0);
            }}
            onKeyDown={searchKey}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <Button type="button" kind="quiet" disabled={!matches.length} onClick={() => moveMatch(-1)}>
          Previous match
        </Button>
        <Button type="button" kind="quiet" disabled={!matches.length} onClick={() => moveMatch(1)}>
          Next match
        </Button>
        <output aria-live="polite" aria-atomic="true">
          {matches.length ? `${activeMatch + 1} of ${matches.length}` : query ? 'No matches' : '0 matches'}
        </output>
      </div>
      {sections.length > 0 && (
        <details className="sms-text-reader-sections">
          <summary>Sections · {sections.length}</summary>
          <nav className="sms-text-reader-outline" aria-label="Sections">
            {sections.map((section, index) => (
              <Button
                key={section.start}
                type="button"
                kind="quiet"
                style={{ textAlign: 'left', justifyContent: 'start', marginInlineStart: (section.level - 1) * 10 }}
                onClick={() => openSection(index)}
              >
                {section.title}
              </Button>
            ))}
          </nav>
        </details>
      )}
      <div className="sms-text-reader-pane" ref={pane} role="region" aria-label={label} tabIndex={0}>
        <div className="sms-text-reader-content">
          {headingLines(parts).map((line) => {
            const content = line.parts.map((part) => {
              const highlighted = part.matchIndex !== null;
              const current = highlighted && part.matchIndex === activeMatch;
              const text = highlighted ? (
                <mark
                  className={`sms-text-reader-match${current ? ' is-current' : ''}`}
                  ref={(element) => {
                    if (current && part.start === matches[activeMatch]?.start) currentMatch.current = element;
                  }}
                >
                  {part.text}
                </mark>
              ) : (
                part.text
              );
              return <Fragment key={part.start}>{styledPart(part, text)}</Fragment>;
            });
            const sectionIndex = line.sectionIndex;
            if (sectionIndex === null) return <Fragment key={line.parts[0].start}>{content}</Fragment>;
            return (
              <span
                key={line.parts[0].start}
                tabIndex={-1}
                ref={(element) => {
                  if (element) sectionElements.current.set(sectionIndex, element);
                  else sectionElements.current.delete(sectionIndex);
                }}
              >
                {content}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}
