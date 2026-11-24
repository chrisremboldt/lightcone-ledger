import { useEffect, useState } from 'react';
import type { LedgerClient } from '@ledger/contracts/client';
import type {
  Principal,
  RecordkeepingPlanDraftResponse,
  RequiredRecordOnFile,
  RequiredRecordsResponse,
  SmsRecordOpenCommand,
} from '@ledger/contracts';
import { readableQuote } from '@ledger/contracts';
import { Button, Notice, Spinner } from '@ledger/ui';
import { ctDay, timeZoneLabel } from './format.js';
import { plainError } from './sms-labels.js';

/** What is on file for one kind of record, in plain words: a count and the days it covers, never a judgment. */
export function onFileWords(onFile: RequiredRecordOnFile): string {
  const corrected = onFile.replaced
    ? ` ${onFile.replaced} earlier ${onFile.replaced === 1 ? 'version' : 'versions'} replaced by a correction ${onFile.replaced === 1 ? 'is' : 'are'} kept.`
    : '';
  if (!onFile.current) return `None on file.${corrected}`;
  const span =
    onFile.earliest && onFile.latest
      ? ctDay(onFile.earliest) === ctDay(onFile.latest)
        ? `, about ${ctDay(onFile.earliest)} (${timeZoneLabel()})`
        : `, about ${ctDay(onFile.earliest)} to ${ctDay(onFile.latest)} (${timeZoneLabel()})`
      : '';
  return `${onFile.current} on file${span}.${corrected}`;
}

/** Whether this person may open a draft controlled document. */
const mayStartPlan = (principal: Principal | null) => Boolean(principal?.capabilities.includes('sms:write'));

/**
 * The records the organization's adopted rule packs say must be kept, each with the words that list it, what holds
 * it, what is on file and how long the text says, and starting a recordkeeping plan from them. Nothing here says a
 * requirement is met.
 */
export function RequiredRecords({
  client,
  principal,
  onOpenDocument,
}: {
  client: LedgerClient;
  principal: Principal | null;
  onOpenDocument?: (id: string) => void;
}) {
  const [read, setRead] = useState<RequiredRecordsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [started, setStarted] = useState<{ id: string; blanks: string[] } | null>(null);
  const [startError, setStartError] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    client
      .requiredRecords()
      .then((response) => !stopped && setRead(response))
      .catch((failure) => !stopped && setError(plainError(failure).message));
    return () => {
      stopped = true;
    };
  }, [client]);

  async function startPlan() {
    if (!principal) return;
    setStarting(true);
    setStartError(null);
    try {
      const draft: RecordkeepingPlanDraftResponse = await client.recordkeepingPlanDraft();
      const command: SmsRecordOpenCommand = {
        kind: 'sms.record.open',
        record: {
          kind: 'document',
          schema: 'sms.document.2',
          title: draft.title,
          ownerId: principal.id,
          body: draft.body,
        },
      };
      const sent = await client.command(command, crypto.randomUUID());
      setStarted({ id: sent.command.subject?.id ?? '', blanks: draft.blanks });
    } catch (failure) {
      setStartError(plainError(failure).message);
    } finally {
      setStarting(false);
    }
  }

  if (error)
    return (
      <Notice tone="alert" title="Required records could not be read">
        {error}
      </Notice>
    );
  if (!read) return <Spinner label="Reading the records your rules require" />;
  return (
    <section className="records-list" aria-label="Records your rules require">
      <h2>
        Records your rules require <span className="roster-count">{read.records.length}</span>
      </h2>
      <p className="records-note">
        The records the rule packs your organization has adopted say must be kept, in their own words, with what is on
        file in Ledger for each. Ledger keeps every record and every correction and removes none. Keeping this
        deployment and its backups for as long as each text asks is your organization’s.
      </p>
      {!read.records.length && (
        <p className="records-note">No rule pack your organization has adopted lists a record it must keep.</p>
      )}
      {mayStartPlan(principal) && (
        <div className="records-actions">
          {started ? (
            <Notice tone="neutral" title="Draft recordkeeping plan opened">
              <p>
                It is a draft controlled document under Safety, Documents.
                {started.blanks.length
                  ? ` Fill its ${started.blanks.length} blanks, each written [To be filled in: …], then review it, have it signed and issue it. Reviewing or issuing it is refused while a blank remains.`
                  : ' Review it, have it signed and issue it.'}
              </p>
              {onOpenDocument && started.id && (
                <Button onClick={() => onOpenDocument(started.id)}>Open the draft plan</Button>
              )}
            </Notice>
          ) : (
            <Button onClick={() => void startPlan()} disabled={starting}>
              {starting ? 'Starting a recordkeeping plan' : 'Start a recordkeeping plan'}
            </Button>
          )}
          {startError && (
            <Notice tone="alert" title="The plan was not started">
              {startError}
            </Notice>
          )}
        </div>
      )}
      <ol className="records-items">
        {read.records.map((record) => (
          <li key={record.id} data-testid="required-record">
            <h3>{record.title}</h3>
            <dl className="records-fields required-record-fields">
              <div className="required-record-wide">
                <dt>What the text lists</dt>
                <dd>
                  <blockquote className="required-record-quote">{readableQuote(record.source.text)}</blockquote>
                  <cite>{record.source.reference}</cite>
                </dd>
              </div>
              <div>
                <dt>Who the text says keeps it</dt>
                <dd>{record.keptBy}</dd>
              </div>
              <div>
                <dt>How long the text says</dt>
                <dd>
                  {record.retention ? (
                    <>
                      <blockquote className="required-record-quote">{readableQuote(record.retention.text)}</blockquote>
                      <cite>{record.retention.reference}</cite>
                    </>
                  ) : (
                    'The text states no period.'
                  )}
                </dd>
              </div>
              <div>
                <dt>On file</dt>
                <dd>
                  <ul className="required-record-holders">
                    {record.heldBy.map((holder) => (
                      <li key={holder.kind === 'operator_record' ? holder.recordType : holder.recordKind}>
                        {holder.title}: {onFileWords(holder.onFile)}
                      </li>
                    ))}
                  </ul>
                </dd>
              </div>
              <div>
                <dt>Declared by</dt>
                <dd>{record.declaredBy.map((pack) => `${pack.packTitle} (version ${pack.version})`).join('; ')}</dd>
              </div>
            </dl>
          </li>
        ))}
      </ol>
    </section>
  );
}
