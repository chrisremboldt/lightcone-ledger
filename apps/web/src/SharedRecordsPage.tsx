import { useEffect, useState } from 'react';
import type { SharedRecords, SharedRecordsFile } from '@ledger/contracts';
import { Button, Mark, Notice, Spinner } from '@ledger/ui';
import { setTimeZone, time, timeZoneLabel } from './format.js';
import { saveBytes } from './sms-labels.js';

/** The secret of the link this page was opened with: the part after #, which the browser never sends to a server. */
function linkSecret(): string | null {
  const fragment = window.location.hash.replace(/^#/, '');
  return fragment ? decodeURIComponent(fragment) : null;
}

const NOT_IN_USE = 'This link does not open any records. It may have expired or been revoked.';

const brand = (
  <header className="gate-brand">
    <Mark size={22} />
    <span>LEDGER</span>
  </header>
);

const roleLabels: Record<SharedRecordsFile['role'], string> = {
  index: 'Printable index',
  records: 'Records',
  original: 'Original file',
  manifest: 'Manifest of digests',
};

/** Asks the API with the secret in the body, never in the address; answers the bytes, or why there are none. */
async function ask(apiUrl: string, path: string, body: Record<string, string>): Promise<Response> {
  const response = await fetch(`${apiUrl.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
  });
  if (response.ok) return response;
  const answer = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
  throw new Error(answer?.error?.message ?? NOT_IN_USE);
}

/**
 * The set a link opens, asked for once per page: every ask is kept by the organization as an opening, so a second run
 * of the effect (React runs effects twice in development) reuses the first answer instead of asking again.
 */
const opened = new Map<string, Promise<SharedRecords>>();
function openSet(apiUrl: string, secret: string): Promise<SharedRecords> {
  const key = `${apiUrl}\u0000${secret}`;
  let answer = opened.get(key);
  if (!answer) {
    answer = ask(apiUrl, '/v1/shared-records', { secret }).then(
      (response) => response.json() as Promise<SharedRecords>,
    );
    opened.set(key, answer);
  }
  return answer;
}

/**
 * The page a link to one produced set opens. It needs no sign-in: the organization's name, what the set is, its files
 * to read or download and the whole .zip. It changes nothing, and each opening is kept by Ledger with its time only.
 */
export function SharedRecordsPage({ apiUrl }: { apiUrl: string }) {
  const [secret] = useState(linkSecret);
  const [shown, setShown] = useState<SharedRecords | null>(null);
  const [failure, setFailure] = useState<string | null>(secret ? null : NOT_IN_USE);
  const [busy, setBusy] = useState<string | null>(null);
  const [fileFailure, setFileFailure] = useState<string | null>(null);
  const [reading, setReading] = useState<{ path: string; as: 'page' | 'text'; text: string } | null>(null);
  useEffect(() => {
    document.title = 'Shared records · Ledger';
    if (!secret) return;
    let stopped = false;
    openSet(apiUrl, secret).then(
      (answer) => {
        if (stopped) return;
        setTimeZone(answer.organization.timeZone);
        setShown(answer);
      },
      (error: Error) => !stopped && setFailure(error.message),
    );
    return () => {
      stopped = true;
    };
  }, [apiUrl, secret]);

  async function fetchFile(file: SharedRecordsFile, read: boolean) {
    setBusy(file.path);
    setFileFailure(null);
    try {
      const response = await ask(apiUrl, '/v1/shared-records/file', { secret: secret!, path: file.path });
      const bytes = new Uint8Array(await response.arrayBuffer());
      const shownAs = readable(file.contentType);
      if (read && shownAs === 'tab') {
        // A PDF or a picture opens in a tab of its own, from this page's memory: nothing of the link is in its address.
        const url = URL.createObjectURL(new Blob([bytes], { type: file.contentType }));
        window.open(url, '_blank', 'noopener,noreferrer');
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      } else if (read && shownAs)
        setReading({ path: file.path, as: shownAs as 'page' | 'text', text: new TextDecoder().decode(bytes) });
      else saveBytes(bytes, file.path.split('/').pop()!, file.contentType);
    } catch (error) {
      setFileFailure((error as Error).message);
    } finally {
      setBusy(null);
    }
  }
  async function fetchArchive() {
    setBusy('archive');
    setFileFailure(null);
    try {
      const response = await ask(apiUrl, '/v1/shared-records/archive', { secret: secret! });
      saveBytes(
        new Uint8Array(await response.arrayBuffer()),
        `records-${shown!.set.producedAt.slice(0, 10)}.zip`,
        'application/zip',
      );
    } catch (error) {
      setFileFailure((error as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (failure)
    return (
      <main className="shared-records-page" aria-label="Shared records">
        {brand}
        <Notice tone="neutral" title="No records to show">
          {failure}
        </Notice>
        <p className="records-note">Ask the organization that gave you the link for a new one.</p>
      </main>
    );
  if (!shown)
    return (
      <main className="shared-records-page" aria-label="Shared records">
        {brand}
        <Spinner label="Opening the records" />
      </main>
    );
  const { organization, set, files } = shown;
  return (
    <main className="shared-records-page" aria-label="Shared records" data-testid="shared-records">
      {brand}
      <p className="topbar-label">Records shared by</p>
      <h1>{organization.name}</h1>
      <p className="records-note">
        {organization.name} produced these records from what it kept in Ledger and shared them with you through a link.
        Ledger did not check them against any requirement. This page changes nothing; it opens until{' '}
        {time(shown.expiresAt, true)} {timeZoneLabel()} unless the organization revokes the link sooner.
      </p>
      <dl className="records-fields">
        <div>
          <dt>Why they were produced</dt>
          <dd>{set.reason}</dd>
        </div>
        <div>
          <dt>Asked for by</dt>
          <dd>{set.requestedBy}</dd>
        </div>
        <div>
          <dt>Produced</dt>
          <dd>
            {time(set.producedAt, true)} {timeZoneLabel()} by {set.producedBy}
          </dd>
        </div>
        <div>
          <dt>Records</dt>
          <dd>{set.records}</dd>
        </div>
        <div>
          <dt>SHA-256 of the .zip</dt>
          <dd>
            <code>{set.archiveSha256}</code>
          </dd>
        </div>
        <div>
          <dt>SHA-256 of manifest.json</dt>
          <dd>
            <code>{set.manifestSha256}</code>
            <p className="records-help">Compare it with the digest the organization gave you by another route.</p>
          </dd>
        </div>
      </dl>
      <Button kind="primary" disabled={busy !== null} onClick={() => void fetchArchive()}>
        {busy === 'archive' ? 'Downloading…' : 'Download the whole .zip'}
      </Button>
      {fileFailure && (
        <Notice tone="alert" title="The file could not be opened">
          {fileFailure}
        </Notice>
      )}
      <h2>Files</h2>
      <table className="records-preview" aria-label="Files in the set">
        <thead>
          <tr>
            <th>File</th>
            <th>What it is</th>
            <th>Size</th>
            <th>SHA-256</th>
            <th className="shared-records-open">Open</th>
          </tr>
        </thead>
        <tbody>
          {files.map((file) => (
            <tr key={file.path}>
              <td>
                <code>{file.path}</code>
              </td>
              <td>{roleLabels[file.role]}</td>
              <td>{file.byteLength} bytes</td>
              <td className="shared-records-digest">{file.sha256 ? <code>{file.sha256}</code> : 'See above'}</td>
              <td className="shared-records-open">
                {readable(file.contentType) && (
                  <>
                    <Button kind="quiet" disabled={busy !== null} onClick={() => void fetchFile(file, true)}>
                      Read {file.path}
                    </Button>{' '}
                  </>
                )}
                <Button kind="quiet" disabled={busy !== null} onClick={() => void fetchFile(file, false)}>
                  Download {file.path}
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {reading && (
        <section className="shared-records-reading" aria-label={`Reading ${reading.path}`}>
          <h2>{reading.path}</h2>
          <Button kind="quiet" onClick={() => setReading(null)}>
            Close {reading.path}
          </Button>
          {reading.as === 'page' ? (
            // The printable index as the page it is, in a frame that runs nothing and reaches nothing of this page.
            <iframe title={reading.path} sandbox="" srcDoc={reading.text} className="shared-records-frame" />
          ) : (
            <pre className="records-original">{reading.text}</pre>
          )}
        </section>
      )}
    </main>
  );
}

/** How a file is read on this page: a page in a frame that runs nothing, text as text, a PDF or picture in a tab. */
function readable(contentType: string): 'page' | 'text' | 'tab' | null {
  if (contentType.startsWith('text/html')) return 'page';
  if (contentType.startsWith('text/') || contentType.includes('json') || contentType.includes('csv')) return 'text';
  if (contentType === 'application/pdf' || /^image\/(png|jpeg|gif|webp)$/.test(contentType)) return 'tab';
  return null;
}
