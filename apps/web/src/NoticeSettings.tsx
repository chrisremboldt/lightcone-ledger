import { useEffect, useState, type FormEvent } from 'react';
import type { LedgerClient } from '@ledger/contracts/client';
import {
  NOTICE_EMAIL_PATTERN,
  type NoticeDigest,
  type NoticeEmailChoice,
  type NoticeSettingsResponse,
  type PrincipalAuthorityEntry,
} from '@ledger/contracts';
import { Button, Notice } from '@ledger/ui';
import { plainError } from './sms-labels.js';

/** Each notice a person can choose to get by email, in plain words. */
export const noticeChoiceLabels: Record<NoticeEmailChoice, string> = {
  assigned: 'A finding or an action is assigned to me',
  due: 'An action of mine is due within three days',
  overdue: 'An action of mine is overdue',
  acknowledgement: 'A document is waiting for my acknowledgement',
};
export const noticeDigestLabels: Record<NoticeDigest, string> = {
  none: 'No digest',
  daily: 'A daily digest',
  weekly: 'A weekly digest, on Mondays',
};

/**
 * The person's own notices, in the account panel: where their email goes, which notices arrive by email and whether
 * they get a digest. Folded until opened, so the panel stays short.
 */
export function NoticeChoices({ client }: { client: LedgerClient }) {
  const [read, setRead] = useState<NoticeSettingsResponse | null>(null);
  const [email, setEmail] = useState('');
  const [choices, setChoices] = useState<Record<NoticeEmailChoice, boolean> | null>(null);
  const [digest, setDigest] = useState<NoticeDigest>('none');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'observed' | 'alert'; text: string } | null>(null);

  useEffect(() => {
    let stopped = false;
    client
      .noticeSettings()
      .then((response) => {
        if (stopped) return;
        setRead(response);
        setEmail(response.settings.email ?? '');
        setChoices(response.settings.choices);
        setDigest(response.settings.digest);
      })
      .catch(() => undefined);
    return () => {
      stopped = true;
    };
  }, [client]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!choices) return;
    setBusy(true);
    setMessage(null);
    try {
      const saved = await client.updateNoticeSettings({ email: email.trim() || null, choices, digest });
      setRead((current) => (current ? { ...current, settings: saved.settings } : current));
      setMessage({ tone: 'observed', text: 'Your notices were saved. The change is recorded.' });
    } catch (error) {
      setMessage({ tone: 'alert', text: plainError(error).message });
    } finally {
      setBusy(false);
    }
  };

  if (!read || !choices) return null;
  return (
    // A button in the account panel closes it; saving here keeps it open to show what was saved.
    <details className="notice-choices" onClick={(event) => event.stopPropagation()}>
      <summary>Email notices</summary>
      {!read.emailAvailable && (
        <p className="records-note">
          This Ledger sends no email: it has no mail server configured. Your choices are kept for when it does.
        </p>
      )}
      <form aria-label="Your email notices" onSubmit={(event) => void save(event)}>
        <label className="records-field">
          <span>Your email address</span>
          <input
            type="email"
            value={email}
            autoComplete="email"
            pattern={NOTICE_EMAIL_PATTERN}
            maxLength={254}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        {!email.trim() && <p className="records-note">With no address, you get no email.</p>}
        <fieldset>
          <legend>Send me an email when</legend>
          {(Object.keys(noticeChoiceLabels) as NoticeEmailChoice[]).map((choice) => (
            <label key={choice} className="people-capability">
              <input
                type="checkbox"
                checked={choices[choice]}
                onChange={(event) => setChoices({ ...choices, [choice]: event.target.checked })}
              />
              {noticeChoiceLabels[choice]}
            </label>
          ))}
        </fieldset>
        <label className="records-field">
          <span>Digest</span>
          <select value={digest} onChange={(event) => setDigest(event.target.value as NoticeDigest)}>
            {(Object.keys(noticeDigestLabels) as NoticeDigest[]).map((value) => (
              <option key={value} value={value}>
                {noticeDigestLabels[value]}
              </option>
            ))}
          </select>
        </label>
        <p className="records-note">
          A digest lists what is assigned to you, what is due and overdue, and what waits for your acknowledgement. No
          other notice repeats by itself.
        </p>
        {message && <Notice tone={message.tone}>{message.text}</Notice>}
        <Button kind="primary" type="submit" disabled={busy}>
          {busy ? 'Saving' : 'Save my notices'}
        </Button>
      </form>
    </details>
  );
}

/** The address a person gets email notices at, as an administrator keeps it on the People screen. */
export function PersonNoticeEmail({
  client,
  person,
  onChanged,
}: {
  client: LedgerClient;
  person: PrincipalAuthorityEntry;
  onChanged: (message: string) => void;
}) {
  const [email, setEmail] = useState(person.noticeEmail ?? '');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setFailure(null);
    try {
      const address = email.trim() || null;
      await client.setPersonNoticeEmail(person.id, address);
      onChanged(
        address
          ? `${person.name} gets email notices at ${address}. The change is recorded.`
          : `${person.name} has no address for notices now and gets no email. The change is recorded.`,
      );
    } catch (error) {
      setFailure(plainError(error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="records-form people-form"
      aria-label={`Email notices for ${person.name}`}
      onSubmit={(event) => void save(event)}
    >
      <h3>Email notices</h3>
      <p className="roster-scope-caption">
        {person.noticeEmail
          ? `${person.name} gets email notices at ${person.noticeEmail}, as they choose under their name in the bar.`
          : `No email address is kept for ${person.name}, so they get no email notices.`}
      </p>
      <label className="records-field">
        <span>Email address</span>
        <input
          type="email"
          value={email}
          pattern={NOTICE_EMAIL_PATTERN}
          maxLength={254}
          onChange={(event) => setEmail(event.target.value)}
        />
      </label>
      {failure && (
        <Notice tone="alert" title="Nothing was changed">
          {failure}
        </Notice>
      )}
      <div className="records-actions">
        <Button type="submit" disabled={busy}>
          Save the address
        </Button>
      </div>
    </form>
  );
}
