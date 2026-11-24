import { useState, type FormEvent } from 'react';
import { ApiError, type LedgerClient } from '@ledger/contracts/client';
import type { Principal, SmsExportCreate, SmsExportRecord } from '@ledger/contracts';
import { Button, Notice } from '@ledger/ui';
import { confidentialityLabels, plainError, saveBytes } from './sms-labels.js';

const PROGRAM_OFFSET = '-06:00';

function count(value: number, noun: string) {
  return `${value} ${noun}${value === 1 ? '' : 's'}`;
}

export function useSmsExport(client: LedgerClient) {
  const [record, setRecord] = useState<SmsExportRecord | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  async function create(input: SmsExportCreate) {
    setPending(true);
    setFailure(null);
    try {
      const result = await client.request<{ export: SmsExportRecord }>(
        '/v1/sms/exports',
        { method: 'POST', body: JSON.stringify(input) },
        crypto.randomUUID(),
      );
      setRecord(result.export);
    } catch (error) {
      setFailure(error instanceof ApiError ? plainError(error).message : 'Export failed; try again.');
    } finally {
      setPending(false);
    }
  }
  return { record, pending, failure, setFailure, create };
}

export function ExportReady({
  client,
  record,
  onFailure,
}: {
  client: LedgerClient;
  record: SmsExportRecord;
  onFailure: (message: string) => void;
}) {
  async function save(path: string, filename: string, contentType: string) {
    try {
      const { bytes } = await client.download(path);
      saveBytes(bytes, filename, contentType);
    } catch (error) {
      onFailure(plainError(error).message);
    }
  }
  return (
    <div className="safety-acceptance-summary" data-testid="sms-export">
      <strong>Export ready</strong>
      <span>
        {[
          count(record.counts.records, 'record'),
          count(record.counts.decisions, 'decision'),
          count(record.counts.signatures, 'signature'),
          count(record.counts.attachments, 'file'),
        ].join(' · ')}{' '}
        included
      </span>
      {record.withheld.length > 0 && (
        <span>
          {record.withheld.length} withheld:{' '}
          {[...new Set(record.withheld.map((item) => confidentialityLabels[item.confidentiality]))].join(', ')}
        </span>
      )}
      <span>Save this manifest digest separately to verify the file later:</span>
      <code className="mono sms-digest">{record.manifestDigest}</code>
      <Button
        kind="next"
        type="button"
        onClick={() =>
          void save(`/v1/sms/exports/${record.id}/content`, `ledger-sms-export-${record.id}.json`, 'application/json')
        }
      >
        Download export
      </Button>
      <Button
        type="button"
        onClick={() =>
          void save(`/v1/sms/exports/${record.id}/packet`, `ledger-sms-packet-${record.id}.html`, 'text/html')
        }
      >
        Download reading copy
      </Button>
      <small className="rail-muted">
        The reading copy is for people; the export file is the record. Verify it offline: node
        tools/verifier/sms-cli.mjs FILE --expected-manifest-sha256 DIGEST
      </small>
    </div>
  );
}

function dayStart(day: string): string {
  return new Date(`${day}T00:00:00${PROGRAM_OFFSET}`).toISOString();
}
function nextDayStart(day: string): string {
  const start = new Date(`${day}T00:00:00${PROGRAM_OFFSET}`);
  start.setUTCDate(start.getUTCDate() + 1);
  return start.toISOString();
}
function quarterStart(today: Date): string {
  const month = Math.floor(today.getMonth() / 3) * 3;
  return `${today.getFullYear()}-${String(month + 1).padStart(2, '0')}-01`;
}
const isoDay = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

export function PeriodExportForm({ client, principal }: { client: LedgerClient; principal: Principal }) {
  const today = new Date();
  const [period, setPeriod] = useState({ from: quarterStart(today), through: isoDay(today) });
  const exporter = useSmsExport(client);
  if (!principal.capabilities.includes('evidence:read')) return null;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (period.through < period.from) {
      exporter.setFailure('The end date is before the start date.');
      return;
    }
    await exporter.create({ period: { from: dayStart(period.from), to: nextDayStart(period.through) } });
  }
  return (
    <div className="sms-period-export">
      <form className="action-form safety-form" onSubmit={(event) => void submit(event)} aria-label="Export a period">
        <h3>Export a period</h3>
        <p className="safety-form-note">
          Every SMS record that changed in these dates, the records they depend on, and their decisions and signatures.
          Safety report content stays withheld.
        </p>
        <div className="safety-form-grid">
          <label>
            From
            <input
              type="date"
              value={period.from}
              onChange={(event) => setPeriod((previous) => ({ ...previous, from: event.target.value }))}
              required
            />
          </label>
          <label>
            Through
            <input
              type="date"
              value={period.through}
              onChange={(event) => setPeriod((previous) => ({ ...previous, through: event.target.value }))}
              required
            />
          </label>
        </div>
        {exporter.failure && (
          <Notice tone="alert" title="Export not created">
            {exporter.failure}
          </Notice>
        )}
        <Button type="submit" disabled={exporter.pending}>
          {exporter.pending ? 'Exporting…' : 'Export period'}
        </Button>
        {exporter.record && <ExportReady client={client} record={exporter.record} onFailure={exporter.setFailure} />}
      </form>
    </div>
  );
}
