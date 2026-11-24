import { useEffect, useState } from 'react';
import type { LedgerClient } from '@ledger/contracts/client';
import type { DocumentPurposesResponse } from '@ledger/contracts';

type Offered = DocumentPurposesResponse['purposes'];

/** True when a document of this type serves the purpose by being what it is, with no tick. */
function servedByType(purpose: Offered[number], documentType: string | undefined): boolean {
  return documentType !== undefined && purpose.documentTypes.includes(documentType);
}

/**
 * The purposes a document revision serves, ticked from those the organization's adopted rule packs look for
 * (docs/design/on-file-checks.md). The choice is part of the revision, reviewed and signed with it.
 */
export function SmsDocumentPurposes({
  client,
  documentType,
  value,
  onChange,
}: {
  client: LedgerClient;
  /** The document's type: a purpose this type serves by being what it is is shown as served, not as a box to tick. */
  documentType: string;
  value: readonly string[];
  onChange: (purposes: string[]) => void;
}) {
  const [offered, setOffered] = useState<Offered | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let current = true;
    client
      .documentPurposes()
      .then((response) => current && setOffered(response.purposes))
      .catch(() => current && setFailed(true));
    return () => {
      current = false;
    };
  }, [client]);
  // A purpose an earlier revision served stays visible, so it is never dropped without a person seeing it.
  const kept = value.filter((id) => offered && !offered.some((purpose) => purpose.id === id));
  const toggle = (id: string, ticked: boolean) =>
    onChange(ticked ? [...value.filter((item) => item !== id), id] : value.filter((item) => item !== id));
  return (
    <fieldset className="sms-controls" data-testid="document-purposes">
      <legend>What this document is on file for</legend>
      <p className="safety-form-note">
        Tick each purpose this revision serves. A rule counts it only once this revision is signed, issued and in
        effect, and names the document; whether what it says meets the paragraph is for a person.
      </p>
      {failed && <p className="rail-muted">The purposes your rule packs look for could not be loaded.</p>}
      {offered && !offered.length && !kept.length && (
        <p className="rail-muted">No rule pack your organization has adopted looks for a document.</p>
      )}
      {offered?.map((purpose) => (
        <label key={purpose.id} className="sms-check">
          <input
            type="checkbox"
            checked={servedByType(purpose, documentType) || value.includes(purpose.id)}
            disabled={servedByType(purpose, documentType)}
            onChange={(event) => toggle(purpose.id, event.target.checked)}
          />
          <span>
            {purpose.title}
            {servedByType(purpose, documentType) && <span className="rail-muted"> · served by its type</span>}
            <span className="rail-muted">
              {' · '}
              {purpose.declaredBy.map((pack) => `${pack.reference}, ${pack.packTitle}`).join('; ')}
            </span>
          </span>
        </label>
      ))}
      {kept.map((id) => (
        <label key={id} className="sms-check">
          <input type="checkbox" checked onChange={(event) => toggle(id, event.target.checked)} />
          <span>
            {id}
            <span className="rail-muted"> · served by the earlier revision; no adopted pack looks for it now</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/** The purposes a revision serves, read-only, named as the adopted packs title them, for a reviewer and a signer. */
export function SmsDocumentServes({
  client,
  documentType,
  purposes,
}: {
  client: LedgerClient;
  documentType: string;
  purposes: readonly string[];
}) {
  const [offered, setOffered] = useState<Offered>([]);
  useEffect(() => {
    let current = true;
    client
      .documentPurposes()
      .then((response) => current && setOffered(response.purposes))
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [client]);
  const byType = offered.filter((purpose) => servedByType(purpose, documentType));
  const ticked = purposes
    .filter((id) => !byType.some((purpose) => purpose.id === id))
    .map((id) => `${offered.find((purpose) => purpose.id === id)?.title ?? id} (ticked)`);
  const served = [...byType.map((purpose) => `${purpose.title} (by its type)`), ...ticked];
  return (
    <div data-testid="document-serves">
      <dt>On file for</dt>
      <dd>{served.length ? served.join('; ') : <span className="muted">No purpose a rule pack looks for</span>}</dd>
    </div>
  );
}
