import { useEffect, useState } from 'react';
import { LedgerClient } from '@ledger/contracts/client';
import type { ReceiptResponse, TelemetryResponse, TimelineResponse } from '@ledger/contracts';
import { citedValueRows, readCitedObservations, ruleExplanation, type CitedValueRow } from './evaluation-reads.js';
import { errorMessage } from './format.js';
import {
  OCCURRENCE_REPORT_LIMIT,
  OCCURRENCE_WINDOW_SECONDS,
  occurrenceReferences,
  resolveOccurrenceLocations,
  type OccurrenceEvaluation,
  type OccurrenceLocations,
  type OccurrenceReportRead,
} from './occurrence-location.js';
import { readFailureOutcome } from './read-failure.js';

interface Props {
  active: boolean;
  client?: LedgerClient;
  /** Without a flight and its evaluation there is no occurrence to place, and nothing is read. */
  flightId?: string;
  evaluation?: OccurrenceEvaluation;
}
interface LocationRead {
  client: LedgerClient;
  key: string;
  data: OccurrenceLocations | null;
  error: string | null;
}

export function useOccurrenceLocations({ active, client, flightId, evaluation }: Props) {
  const key = JSON.stringify([flightId, evaluation]);
  const [read, setRead] = useState<LocationRead | null>(null);
  const [revision, setRevision] = useState(0);
  const shown = read !== null && read.client === client && read.key === key ? read : null;

  useEffect(() => {
    if (!active || !client || !flightId || !evaluation) return;
    const reader: LedgerClient = client;
    let stopped = false;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error('The occurrence evidence read timed out. Retry it.')),
      15_000,
    );
    const pinned = JSON.parse(key) as [string, OccurrenceEvaluation];
    let cited: CitedValueRow[] = [];
    let references = occurrenceReferences(pinned[1]).slice(0, OCCURRENCE_REPORT_LIMIT);
    const reports: OccurrenceReportRead[] = [];
    const telemetry: TelemetryResponse[] = [];
    const errors: string[] = [];
    let accessChanged = false;
    function recordFailure(error: unknown) {
      // Each read is of evidence the evaluation cites, not of the flight the map is about.
      if (readFailureOutcome(error, false) === 'access_lost') {
        accessChanged = true;
        controller.abort();
      }
      errors.push(errorMessage(error));
    }
    const readJson = <T>(path: string, maxBytes: number) =>
      reader.readJson<T>(path, { maxBytes, signal: controller.signal });
    setRead((previous) =>
      previous?.client === reader && previous.key === key
        ? { ...previous, error: null }
        : { client: reader, key, data: null, error: null },
    );

    async function loadReport(reference: (typeof references)[number]) {
      const { report } = reference;
      try {
        const query = new URLSearchParams({ limit: '1', decisionLimit: '1', selectedItemId: report.eventId });
        const [timeline, receipt] = await Promise.all([
          readJson<TimelineResponse>(`/v1/flights/${encodeURIComponent(pinned[0])}/timeline?${query}`, 512 * 1024),
          report.receiptId
            ? readJson<ReceiptResponse>(`/v1/receipts/${encodeURIComponent(report.receiptId)}`, 32 * 1024)
            : Promise.resolve(null),
        ]);
        if (timeline.flight.id !== pinned[0]) throw new Error('The source report read returned another flight.');
        reports.push({ eventId: report.eventId, item: timeline.selectedItem, receipt: receipt?.receipt });
      } catch (error) {
        const message = errorMessage(error);
        reports.push({ eventId: report.eventId, error: message });
        recordFailure(error);
      }
    }
    async function loadWindow(around: string) {
      try {
        const query = new URLSearchParams({ around, windowSeconds: String(OCCURRENCE_WINDOW_SECONDS) });
        const snapshot = await readJson<TelemetryResponse>(
          `/v1/flights/${encodeURIComponent(pinned[0])}/telemetry?${query}`,
          512 * 1024,
        );
        if (
          snapshot.flightId !== pinned[0] ||
          !snapshot.window.occurrence ||
          Date.parse(snapshot.window.occurrence.around) !== Date.parse(around)
        )
          throw new Error('The historical telemetry response does not match the selected occurrence.');
        telemetry.push(snapshot);
      } catch (error) {
        recordFailure(error);
      }
    }
    async function collect() {
      // A finding from an adopted rule cites observations; read them before placing the reports they state.
      if (ruleExplanation(pinned[1])) {
        const observations = await readCitedObservations(reader, { kind: 'flight', id: pinned[0] }, pinned[1]);
        cited = citedValueRows(pinned[1], observations);
        references = occurrenceReferences(pinned[1], cited).slice(0, OCCURRENCE_REPORT_LIMIT);
      }
      const tasks = [
        ...references.map((reference) => () => loadReport(reference)),
        ...[...new Set(references.map((reference) => reference.eventTime))].map((around) => () => loadWindow(around)),
      ];
      for (let index = 0; index < tasks.length && !controller.signal.aborted; index += 3)
        await Promise.all(tasks.slice(index, index + 3).map((task) => task()));
      if (stopped) return;
      if (accessChanged) {
        setRead({
          client: reader,
          key,
          data: null,
          error: 'Access to occurrence evidence changed. Return to the safety record and refresh your session.',
        });
        return;
      }
      const data = resolveOccurrenceLocations({
        flightId: pinned[0],
        evaluation: pinned[1],
        reports,
        telemetry,
        cited,
      });
      setRead({ client: reader, key, data, error: errors.length ? [...new Set(errors)].join(' ') : null });
    }
    void collect()
      .catch((error) => {
        if (!stopped) setRead({ client: reader, key, data: null, error: errorMessage(error) });
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      stopped = true;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [active, client, key, revision]);

  return {
    status: !active
      ? ('idle' as const)
      : shown?.data
        ? ('ready' as const)
        : shown?.error
          ? ('error' as const)
          : ('loading' as const),
    data: shown?.data ?? null,
    error: shown?.error ?? null,
    reload: () => setRevision((previous) => previous + 1),
  };
}
