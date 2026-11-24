import { describe, expect, it } from 'vitest';
import { LedgerClient } from '@ledger/contracts/client';
import { InputSchema, type Principal } from '@ledger/contracts';
import { canonicalDigest, sha256 } from '@ledger/integrity';
import { openApiDocument } from '../../contracts/src/openapi.js';
import { monitoringRecordV2, monitoringSourceV2 } from '../../contracts/fixtures/demo/v1/monitoring-window.js';
import {
  monitoringWindowAdapterBinding,
  monitoringWindowAdapterConfig,
  monitoringWindowAdapterOriginalText,
  monitoringWindowAdapterResult,
  preparedMonitoringWindowInput,
} from '../fixtures/monitoring-window.js';
import { MonitoringWindowAdapter, type PreparedMonitoringWindowInput } from '../src/index.js';

const original = Buffer.from(monitoringWindowAdapterOriginalText, 'utf8');
interface Request {
  path: string;
  method: string;
  key: string | null;
  body: string | Uint8Array | undefined;
}
function fixture() {
  const requests: Request[] = [];
  const principal: Principal = {
    id: monitoringRecordV2.authority.principalId,
    tenantId: monitoringWindowAdapterBinding.tenantId,
    name: 'Fictional monitoring source',
    revision: monitoringRecordV2.authority.principalRevision,
    capabilities: ['input:write', 'monitoring:write'],
    commandLinkSources: [],
    missionSources: [],
    monitoringSources: [monitoringWindowAdapterBinding.sourceId],
  };
  const state = {
    principal,
    document: openApiDocument as unknown,
    response: structuredClone(monitoringWindowAdapterResult.receipt),
    loseNextInputResponse: false,
    inputConflict: false,
  };
  let uploaded = Buffer.alloc(0);
  let uploadMetadata = { byteLength: 0, contentType: '' };
  const ledger = new LedgerClient('https://ledger.invalid', 'never-retain-this-token', async (url, options) => {
    const path = new URL(String(url)).pathname;
    const method = options?.method ?? 'GET';
    const key = new Headers(options?.headers).get('idempotency-key');
    requests.push({ path, method, key, body: options?.body as string | Uint8Array | undefined });
    if (path === '/openapi.json') return Response.json(state.document);
    if (path === '/v1/me') return Response.json({ principal: state.principal });
    if (path === '/v1/uploads' && method === 'POST') {
      const declared = JSON.parse(options!.body as string) as { byteLength: number; contentType: string };
      uploadMetadata = { byteLength: declared.byteLength, contentType: declared.contentType };
      return Response.json({ upload: { id: 'monitoring-upload', status: 'pending', ...uploadMetadata } });
    }
    if (path === '/v1/uploads/monitoring-upload/content' && method === 'PUT') {
      uploaded = Buffer.from(options?.body as Uint8Array);
      return Response.json({
        upload: { id: 'monitoring-upload', status: 'stored', ...uploadMetadata, sha256: sha256(uploaded) },
      });
    }
    if (path === '/v1/uploads/monitoring-upload/finalize' && method === 'POST')
      return Response.json({
        artifact: {
          id: preparedMonitoringWindowInput.input.artifactId,
          uploadId: 'monitoring-upload',
          sha256: sha256(uploaded),
          byteLength: uploaded.byteLength,
          contentType: uploadMetadata.contentType,
          key: `${monitoringWindowAdapterBinding.tenantId}/uploads/monitoring-upload`,
        },
        meta: state.response.meta,
      });
    if (path === '/v1/inputs' && method === 'POST') {
      if (state.loseNextInputResponse) {
        state.loseNextInputResponse = false;
        throw new Error('Injected lost response after monitoring acceptance');
      }
      if (state.inputConflict)
        return Response.json(
          { error: { code: 'source_revision_conflict', message: 'This source revision has different content' } },
          { status: 409 },
        );
      return Response.json(state.response, { status: 201 });
    }
    throw new Error(`Unexpected monitoring HTTP request: ${method} ${path}`);
  });
  const adapter = new MonitoringWindowAdapter(monitoringWindowAdapterConfig(ledger));
  const writes = () => requests.filter((request) => request.method !== 'GET');
  const inputs = () => requests.filter((request) => request.path === '/v1/inputs');
  return { adapter, ledger, state, requests, writes, inputs };
}
function reanchor(prepared: PreparedMonitoringWindowInput): PreparedMonitoringWindowInput {
  const { submissionDigest: _submissionDigest, ...content } = prepared;
  return { ...content, submissionDigest: canonicalDigest(content) };
}

describe('bounded monitoring-window V2 adapter', () => {
  it('pins exact originals, window and revision while preserving partial reports within local bounds', async () => {
    const f = fixture();
    const flight = monitoringSourceV2.flights[0]!;
    const future = new Date(Date.parse(monitoringSourceV2.occurredAt) + 1000).toISOString();
    for (const raw of [
      Buffer.from([0xff, 0xfe]),
      Buffer.from(`{"sourceRevision":2,${JSON.stringify(monitoringSourceV2).slice(1)}`),
      Buffer.concat([original, Buffer.alloc(128 * 1024, ' ')]),
      ...(['sourceSessionId', 'sourceWindowId'] as const).map((field) =>
        Buffer.from(JSON.stringify({ ...monitoringSourceV2, [field]: 'another-binding' })),
      ),
      Buffer.from(JSON.stringify({ ...monitoringSourceV2, completeThrough: future })),
      Buffer.from(
        JSON.stringify({
          ...monitoringSourceV2,
          window: {
            start: monitoringSourceV2.window.start,
            end: new Date(Date.parse(monitoringSourceV2.window.start) + 3600001).toISOString(),
          },
        }),
      ),
      Buffer.from(
        JSON.stringify({
          ...monitoringSourceV2,
          flights: [{ ...flight, declaredC2SourceEventIds: Array.from({ length: 128 }, (_, i) => `status-${i}`) }],
        }),
      ),
      ...(['observedIntervals', 'coverageIntervals', 'gaps'] as const).map((field) =>
        Buffer.from(
          JSON.stringify({
            ...monitoringSourceV2,
            flights: [
              {
                ...flight,
                [field]:
                  field === 'gaps'
                    ? [{ interval: { start: monitoringSourceV2.window.start, end: future }, kind: 'c2_monitor' }]
                    : [{ start: monitoringSourceV2.window.start, end: future }],
              },
            ],
          }),
        ),
      ),
    ])
      await expect(f.adapter.prepare(raw)).rejects.toThrow();
    expect(f.writes()).toEqual([]);
    const prepared = await f.adapter.prepare(original);
    expect(prepared).toEqual(preparedMonitoringWindowInput);
    expect(f.inputs()).toEqual([]);
    expect(Buffer.from(f.requests.find((request) => request.method === 'PUT')!.body as Uint8Array)).toEqual(original);
    expect(JSON.stringify(prepared)).not.toContain('never-retain-this-token');
    const writes = f.writes().length;
    for (const field of ['sourceId', 'sourceSessionId'] as const) {
      const changed = structuredClone(prepared);
      changed.input[field] = 'another-binding';
      await expect(f.adapter.send(reanchor(changed))).rejects.toThrow();
    }
    for (const field of ['sourceWindowId', 'sourceRevision'] as const) {
      const changed = structuredClone(prepared);
      if (field === 'sourceRevision') changed.input.payload.sourceRevision += 1;
      else changed.input.payload.sourceWindowId = 'another-window';
      await expect(f.adapter.recover(reanchor(changed))).rejects.toThrow();
    }
    const artifact = structuredClone(prepared);
    artifact.input.artifactId = 'another-artifact';
    await expect(f.adapter.recover(artifact)).rejects.toThrow();
    expect(f.writes()).toHaveLength(writes);
    await f.adapter.send(prepared);
    expect(f.inputs()).toHaveLength(1);
    expect(f.inputs()[0]!.key).toBe(preparedMonitoringWindowInput.key);
    expect(JSON.parse(f.inputs()[0]!.body as string)).toEqual(preparedMonitoringWindowInput.input);
    const partial = fixture();
    const checkpoint = await partial.adapter.prepare(
      Buffer.from(
        JSON.stringify({
          ...monitoringSourceV2,
          populationComplete: false,
          completeThrough: monitoringSourceV2.window.start,
          window: { ...monitoringSourceV2.window, end: future },
          flights: [{ ...flight, observedIntervals: [], coverageIntervals: null, gaps: [] }],
        }),
      ),
    );
    expect(checkpoint.input.payload.populationComplete).toBe(false);
    expect(partial.inputs()).toEqual([]);
  });

  it('keeps new delivery pending before upload without served parent support, capabilities or an explicit monitoring grant', async () => {
    const missingCapability = fixture();
    missingCapability.state.principal.capabilities = ['input:write'];
    const missingSource = fixture();
    missingSource.state.principal.monitoringSources = [];
    const unsupported = fixture();
    unsupported.state.document = {};
    const constrained = fixture();
    constrained.state.document = {
      ...openApiDocument,
      paths: {
        ...openApiDocument.paths,
        '/v1/inputs': {
          post: {
            ...openApiDocument.paths['/v1/inputs'].post,
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    ...InputSchema,
                    not: {
                      required: ['sourceId'],
                      properties: { sourceId: { const: monitoringWindowAdapterBinding.sourceId } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    for (const [f, code] of [
      [missingCapability, 'capability_required'],
      [missingSource, 'source_grant_required'],
      [unsupported, 'unsupported_contract'],
      [constrained, 'unsupported_contract'],
    ] as const) {
      await expect(f.adapter.prepare(original)).rejects.toMatchObject({ code });
      expect(f.writes()).toEqual([]);
    }
  });

  it('recovers an exact JSON checkpoint after an ambiguous acceptance and source-authority revocation', async () => {
    const f = fixture();
    const checkpoint = JSON.parse(JSON.stringify(await f.adapter.prepare(original))) as PreparedMonitoringWindowInput;
    f.state.loseNextInputResponse = true;
    await expect(f.adapter.send(checkpoint)).rejects.toThrow('Injected lost response');
    const first = f.inputs()[0]!;
    f.state.principal.capabilities = ['input:write'];
    f.state.principal.monitoringSources = [];
    f.state.principal.revision += 1;
    const resumed = new MonitoringWindowAdapter(monitoringWindowAdapterConfig(f.ledger));
    await expect(resumed.send(checkpoint)).rejects.toMatchObject({ code: 'capability_required' });
    expect(f.inputs()).toHaveLength(1);
    f.state.document = {};
    const before = f.requests.length;
    expect(await resumed.recover(checkpoint)).toEqual(monitoringWindowAdapterResult);
    expect(f.inputs()).toHaveLength(2);
    expect(f.inputs()[1]).toEqual(first);
    expect(f.requests.slice(before).map((request) => request.path)).toEqual(['/v1/me', '/v1/inputs']);
    f.state.principal.id = 'another-principal';
    await expect(resumed.recover(checkpoint)).rejects.toThrow('principal or tenant');
    expect(f.inputs()).toHaveLength(2);
  });

  it('preserves the canonical org-linked receipt and propagates a revision conflict without manufacturing another delivery', async () => {
    const f = fixture();
    f.state.principal.id = 'replacement-authorized-principal';
    const prepared = await f.adapter.prepare(original);
    expect(prepared.principalId).toBe(f.state.principal.id);
    const result = await f.adapter.send(prepared);
    expect(result).toEqual(monitoringWindowAdapterResult);
    expect(result.receipt.receipt.artifactId).not.toBe(result.submittedUploadArtifactId);
    expect(result.receipt.receipt.flightId).toBeUndefined();
    const conflicting = fixture();
    conflicting.state.inputConflict = true;
    const checkpoint = await conflicting.adapter.prepare(original);
    const writes = conflicting.writes().length;
    await expect(conflicting.adapter.send(checkpoint)).rejects.toMatchObject({ status: 409 });
    expect(conflicting.inputs()).toHaveLength(1);
    expect(conflicting.writes()).toHaveLength(writes + 1);
    expect(conflicting.inputs()[0]!.key).toBe(checkpoint.key);
  });
});
