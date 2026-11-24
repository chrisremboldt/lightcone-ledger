import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { canonicalDigest, sha256 } from '../../integrity/src/index.js';
import { LedgerClient } from '../src/client.js';
import {
  ASSURANCE_HISTORY_DEFAULT_LIMIT,
  ASSURANCE_HISTORY_MAX_LIMIT,
  ASSURANCE_HISTORY_MAX_RESPONSE_BYTES,
  ASSURANCE_HISTORY_MAX_SUMMARY_BYTES,
  AssuranceHistoryQuerySchema,
  HazardMonitoringHistoryQuerySchema,
  HazardMonitoringHistoryResponseSchema,
  MonitoringWindowSummarySchema,
} from '../src/assurance-history.js';
import {
  hazardMonitoringHistory,
  hazardMonitoringHistoryContinuation,
  hazardMonitoringHistoryContinuationQuery,
  hazardMonitoringHistoryQuery,
  monitoringRevision2,
} from '../fixtures/demo/v1/assurance-history.js';
import { monitoringRecordV2 } from '../fixtures/demo/v1/monitoring-window.js';

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

describe('assurance history discovery', () => {
  it('retains bounded exact monitoring summaries and source pins', () => {
    for (const [schema, examples] of [
      [HazardMonitoringHistoryQuerySchema, [hazardMonitoringHistoryQuery, hazardMonitoringHistoryContinuationQuery]],
      [HazardMonitoringHistoryResponseSchema, [hazardMonitoringHistory, hazardMonitoringHistoryContinuation]],
    ] as const) {
      const validate = ajv.compile(schema);
      for (const example of examples) expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
    }
    expect(ASSURANCE_HISTORY_DEFAULT_LIMIT).toBe(25);
    expect(ASSURANCE_HISTORY_MAX_LIMIT).toBe(100);
    for (const response of [hazardMonitoringHistory, hazardMonitoringHistoryContinuation]) {
      expect(response.page).toMatchObject({ order: 'recorded_descending', consistency: 'accepted_history' });
      expect(bytes(response)).toBeLessThanOrEqual(ASSURANCE_HISTORY_MAX_RESPONSE_BYTES);
    }
    const revisions = [hazardMonitoringHistory.monitoring[0], hazardMonitoringHistoryContinuation.monitoring[0]];
    expect(revisions.map((revision) => revision.sourceRevision)).toEqual([2, 1]);
    expect(revisions.map((revision) => revision.digest)).toEqual([
      canonicalDigest(monitoringRevision2.record),
      canonicalDigest(monitoringRecordV2),
    ]);
    expect(hazardMonitoringHistory.page.nextCursor).toBe(hazardMonitoringHistoryContinuationQuery.cursor);
    expect(hazardMonitoringHistoryContinuation.page).toMatchObject({
      selection: 'continuation',
      hasMore: false,
      nextCursor: null,
    });
    expect(monitoringRevision2.record.source.control).toEqual(monitoringRecordV2.source.control);
    expect(monitoringRevision2.record.source.window).toEqual(monitoringRecordV2.source.window);
    const original = Buffer.from(monitoringRevision2.originalBytesBase64, 'base64');
    expect(JSON.parse(original.toString('utf8'))).toEqual(monitoringRevision2.record.source);
    expect(sha256(original)).toBe(monitoringRevision2.record.original.sha256);
    expect(original.byteLength).toBe(monitoringRevision2.record.original.byteLength);
    for (const row of revisions) expect(bytes(row)).toBeLessThanOrEqual(ASSURANCE_HISTORY_MAX_SUMMARY_BYTES);
  });

  it('rejects payloads, currentness, caller scope and proxy fields outside the exact discovery filters', () => {
    for (const [schema, value] of [
      [AssuranceHistoryQuerySchema, { limit: 25 }],
      [HazardMonitoringHistoryQuerySchema, hazardMonitoringHistoryQuery],
    ] as const) {
      const validate = ajv.compile(schema);
      for (const invalid of [
        { ...value, tenantId: 'caller-tenant' },
        { ...value, organizationId: 'caller-organization' },
        { ...value, principalId: 'proxy-reviewer' },
        { ...value, limit: 0 },
        { ...value, limit: 101 },
        { ...value, limit: 1.5 },
        { ...value, cursor: 'x'.repeat(4097) },
      ])
        expect(validate(invalid)).toBe(false);
    }
    expect(ajv.compile(HazardMonitoringHistoryQuerySchema)({ limit: 25 })).toBe(false);
    expect(
      ajv.compile(HazardMonitoringHistoryQuerySchema)({
        ...hazardMonitoringHistoryQuery,
        calculationId: 'fixture-calculation',
      }),
    ).toBe(false);
    const summary = ajv.compile(MonitoringWindowSummarySchema);
    const value = hazardMonitoringHistory.monitoring[0];
    const payload = monitoringRevision2.record;
    for (const invalid of [
      { ...value, record: payload },
      { ...value, payload },
      { ...value, originalBytesBase64: 'e30=' },
      { ...value, currentness: { status: 'current' } },
      { ...value, processing: 'completed' },
      { ...value, actor: { id: 'proxy-reviewer', name: 'Proxy', onBehalfOf: 'actual-reviewer' } },
    ])
      expect(summary(invalid)).toBe(false);
    const response = ajv.compile(HazardMonitoringHistoryResponseSchema);
    for (const invalid of [
      { ...hazardMonitoringHistory, tenantId: 'caller-tenant' },
      {
        ...hazardMonitoringHistory,
        monitoring: Array.from({ length: 101 }, () => hazardMonitoringHistory.monitoring[0]),
      },
      { ...hazardMonitoringHistory, page: { ...hazardMonitoringHistory.page, order: 'recorded_ascending' } },
      { ...hazardMonitoringHistory, page: { ...hazardMonitoringHistory.page, consistency: 'live_projection' } },
    ])
      expect(response(invalid)).toBe(false);
  });

  it('authenticates read-only discovery and encodes exact parent IDs and cursors', async () => {
    const calls: {
      url: string;
      method: string;
      authorization: string | null;
      key: string | null;
      body: unknown;
    }[] = [];
    const ledger = new LedgerClient('https://ledger.invalid/', 'fixture-assurance-reader', async (input, init) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        authorization: headers.get('authorization'),
        key: headers.get('idempotency-key'),
        body: init?.body ?? null,
      });
      return new Response(JSON.stringify(hazardMonitoringHistory), {
        headers: { 'content-type': 'application/json' },
      });
    });
    expect(
      await ledger.hazardMonitoringWindows('hazard / one', {
        controlEventId: 'control / one+&',
        cursor: 'cursor +/=?&',
        limit: 1,
      }),
    ).toEqual(hazardMonitoringHistory);
    expect(calls.map((call) => call.url)).toEqual([
      'https://ledger.invalid/v1/hazards/hazard%20%2F%20one/monitoring-windows?controlEventId=control+%2F+one%2B%26&cursor=cursor+%2B%2F%3D%3F%26&limit=1',
    ]);
    for (const { url: _url, ...request } of calls)
      expect(request).toEqual({
        method: 'GET',
        authorization: 'Bearer fixture-assurance-reader',
        key: null,
        body: null,
      });
  });
});
