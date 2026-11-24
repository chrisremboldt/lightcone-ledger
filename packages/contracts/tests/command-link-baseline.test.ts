import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { canonicalDigest, canonicalize } from '../../integrity/src/index.js';
import { LedgerClient } from '../src/client.js';
import {
  COMMAND_LINK_BASELINE_MAX_READ_BYTES,
  CommandLinkBaselineRecordResponseSchema,
  CommandLinkBaselineRecordSchema,
  FlightCommandLinkBaselineParamsSchema,
  type CommandLinkBaselineRecordResponse,
} from '../src/command-link-baseline.js';
import { openApiDocument } from '../src/openapi.js';
import { baselineEvidence, monitoringSourceV2 } from '../fixtures/demo/v1/monitoring-window.js';

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const { originalBytesBase64: _originalBytes, processing: _processing, ...baseline } = baselineEvidence;
const response = {
  baseline,
  digest: canonicalDigest(baseline),
  processing: 'completed',
} satisfies CommandLinkBaselineRecordResponse;

describe('exact retained command-link baseline read', () => {
  it('commits the immutable evidence wrapper separately from current processing and original bytes', () => {
    const record = ajv.compile(CommandLinkBaselineRecordSchema);
    const read = ajv.compile(CommandLinkBaselineRecordResponseSchema);
    expect(record(baseline), JSON.stringify(record.errors)).toBe(true);
    for (const processing of ['pending', 'processing', 'completed', 'failed']) {
      const shown = { ...response, processing };
      expect(read(shown), JSON.stringify(read.errors)).toBe(true);
      expect(shown.digest).toBe(canonicalDigest(shown.baseline));
    }
    expect(monitoringSourceV2.flights[0]!.baseline).toEqual({
      eventId: baseline.eventId,
      receiptId: baseline.receiptId,
      sourceEventId: baseline.input.payload.sourceEventId,
      digest: response.digest,
    });
    expect(Buffer.byteLength(canonicalize(response))).toBeLessThanOrEqual(COMMAND_LINK_BASELINE_MAX_READ_BYTES);
    expect(record({ ...baseline, processing: 'completed' })).toBe(false);
    expect(record({ ...baseline, originalBytesBase64: baselineEvidence.originalBytesBase64 })).toBe(false);
    expect(read({ ...response, meta: {} })).toBe(false);
    expect(read({ ...response, processing: 'unknown' })).toBe(false);
  });

  it('uses the authenticated exact flight-scoped endpoint with both path identities encoded', async () => {
    const params = ajv.compile(FlightCommandLinkBaselineParamsSchema);
    expect(params({ id: 'flight/one', baselineId: 'baseline/#one' })).toBe(true);
    expect(params({ id: 'flight/one' })).toBe(false);
    const paths: string[] = [];
    const client = new LedgerClient('https://ledger.invalid', 'fixture-token', async (input) => {
      paths.push(String(input));
      return Response.json(response);
    });
    expect(await client.commandLinkBaseline('flight/one', 'baseline/#one')).toEqual(response);
    expect(paths).toEqual(['https://ledger.invalid/v1/flights/flight%2Fone/command-link-baselines/baseline%2F%23one']);
    const operation = openApiDocument.paths['/v1/flights/{id}/command-link-baselines/{baselineId}'].get;
    expect(operation.operationId).toBe('commandLinkBaseline');
    expect(operation.security).toEqual([{ bearerAuth: [] }]);
  });
});
