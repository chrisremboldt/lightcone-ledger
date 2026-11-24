import { useMemo, type ReactNode } from 'react';
import { documentTextParts, documentTextSections, type DocumentTextPart } from './sms-document-text.js';

/** Headings are styled in place; the literal markers stay in the text so it reads exactly as signed. */
export function styledPart(part: DocumentTextPart, content: ReactNode): ReactNode {
  if (part.heading === null) return content;
  const className = part.marker ? 'sms-text-marker' : `sms-text-heading sms-text-heading--${Math.min(part.heading, 3)}`;
  return <span className={className}>{content}</span>;
}

export function DocumentText({ text, label }: { text: string; label: string }) {
  const parts = useMemo(() => documentTextParts(text, [], documentTextSections(text)), [text]);
  return (
    <div className="sms-document-text" role="region" aria-label={label}>
      {parts.map((part) => (
        <span key={part.start}>{styledPart(part, part.text)}</span>
      ))}
    </div>
  );
}
