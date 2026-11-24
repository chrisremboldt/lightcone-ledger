import { useEffect, useId, useState } from 'react';
import { LedgerClient } from '@ledger/contracts/client';
import { TELEMETRY_MAX_BYTES, type Receipt } from '@ledger/contracts';
import { Button, Notice, Spinner } from '@ledger/ui';
import { dayTime, errorMessage } from './format.js';
import { coordinateLabel } from './geography.js';
import { parseTelemetryRecord, type TelemetryRecordSample } from './telemetry-record.js';

const altitudeReferences: Record<TelemetryRecordSample['altitudeReference'], string> = {
  ellipsoid: 'Ellipsoidal',
  relative: 'Relative to source reference',
  unknown: 'Datum unknown',
};

interface Props {
  active: boolean;
  client: LedgerClient;
  receiptId: string;
  artifactId: string;
  sourceId: string;
  descriptor: Record<string, unknown>;
  processingStatus?: Receipt['processing']['status'];
}

interface Read {
  client: LedgerClient;
  key: string;
  samples?: TelemetryRecordSample[];
  error?: string;
}

export function TelemetryRecordInspection({
  active,
  client,
  receiptId,
  artifactId,
  sourceId,
  descriptor,
  processingStatus,
}: Props) {
  const [read, setRead] = useState<Read | null>(null);
  const [sequence, setSequence] = useState<number | null>(null);
  const [reload, setReload] = useState(0);
  const pickerId = useId();
  const descriptorKey = JSON.stringify(descriptor);
  const key = JSON.stringify([receiptId, artifactId, sourceId, descriptorKey]);
  const shown = read?.client === client && read.key === key ? read : null;

  useEffect(() => {
    if (!active || processingStatus !== 'completed') return;
    let stopped = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('The telemetry read timed out. Retry it.')), 15000);
    setRead({ client, key });
    client
      .readBytes(`/v1/artifacts/${encodeURIComponent(artifactId)}/content`, {
        maxBytes: TELEMETRY_MAX_BYTES,
        signal: controller.signal,
      })
      .then((bytes) => {
        if (stopped) return;
        const samples = parseTelemetryRecord(bytes, { sourceId, descriptor: JSON.parse(descriptorKey) });
        setRead({ client, key, samples });
        setSequence((previous) =>
          samples.some((sample) => sample.sequence === previous) ? previous : samples.at(-1)!.sequence,
        );
      })
      .catch((failure) => {
        if (!stopped) setRead({ client, key, error: errorMessage(failure) });
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      stopped = true;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [active, client, key, artifactId, sourceId, descriptorKey, processingStatus, reload]);

  const samples = processingStatus === 'completed' ? shown?.samples : undefined;
  const selected = samples?.find((sample) => sample.sequence === sequence) ?? samples?.at(-1);
  return (
    <section
      className="telemetry-record-inspection"
      data-testid="telemetry-record-inspection"
      aria-label="Recorded telemetry"
    >
      <div className="telemetry-record-heading">
        <h4>Recorded telemetry</h4>
        {samples && (
          <span>
            {samples.length} position sample{samples.length === 1 ? '' : 's'} · WGS84
          </span>
        )}
      </div>
      {processingStatus !== 'completed' ? (
        <p className="trace-note">
          {processingStatus === 'failed'
            ? 'Measurements are unavailable because this segment failed to process. Its original bytes remain below.'
            : 'Measurements appear when this segment finishes processing.'}
        </p>
      ) : shown?.error ? (
        <Notice tone="attention" title="Telemetry measurements could not be read">
          {shown.error}
          <Button kind="quiet" onClick={() => setReload((value) => value + 1)}>
            Retry telemetry
          </Button>
        </Notice>
      ) : !selected ? (
        <Spinner label="Reading recorded telemetry" />
      ) : (
        <>
          {samples && samples.length > 1 ? (
            <div className="telemetry-record-picker">
              <label htmlFor={pickerId}>Position sample</label>
              <select
                id={pickerId}
                value={selected.sequence}
                onChange={(event) => setSequence(Number(event.target.value))}
              >
                {samples.map((sample) => (
                  <option key={sample.sequence} value={sample.sequence}>
                    Capture {sample.sequence} · {dayTime(sample.occurredAt)}
                  </option>
                ))}
              </select>
              <p className="telemetry-record-capture">
                Sample happened <time dateTime={selected.occurredAt}>{dayTime(selected.occurredAt)}</time>
              </p>
            </div>
          ) : (
            <p className="telemetry-record-capture">
              Capture {selected.sequence} · {dayTime(selected.occurredAt)}
            </p>
          )}
          <dl className="inspection-facts telemetry-record-facts">
            <div>
              <dt>Latitude</dt>
              <dd className="mono">{coordinateLabel(selected.latitude, 'latitude', 6)}</dd>
            </div>
            <div>
              <dt>Longitude</dt>
              <dd className="mono">{coordinateLabel(selected.longitude, 'longitude', 6)}</dd>
            </div>
            <div>
              <dt>Altitude</dt>
              <dd className="mono">
                {selected.altitudeMeters === null ? 'Not reported' : `${Number(selected.altitudeMeters.toFixed(3))} m`}
                <span className="telemetry-record-datum">{altitudeReferences[selected.altitudeReference]}</span>
              </dd>
            </div>
            <div>
              <dt>Horizontal speed</dt>
              <dd className="mono">
                {selected.speedMetersPerSecond === undefined
                  ? 'Not reported'
                  : `${Number(selected.speedMetersPerSecond.toFixed(1))} m/s`}
              </dd>
            </div>
          </dl>
        </>
      )}
    </section>
  );
}
