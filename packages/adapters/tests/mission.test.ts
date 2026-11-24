import { describe, expect, it } from 'vitest';
import { LedgerClient } from '@ledger/contracts/client';
import { InputSchema, type Principal } from '@ledger/contracts';
import { canonicalDigest, sha256 } from '@ledger/integrity';
import { openApiDocument } from '../../contracts/src/openapi.js';
import {
  missionAuthority,
  missionRevision2Input,
  missionRevision2SourceText,
  missionSource,
} from '../../contracts/fixtures/demo/v1/missions.js';
import {
  missionAdapterBinding,
  missionAdapterConfig,
  missionAdapterOriginalText,
  missionAdapterResult,
  preparedMissionInput,
} from '../fixtures/mission.js';
import { MissionAdapter, type PreparedMissionInput } from '../src/index.js';

const original = Buffer.from(missionAdapterOriginalText, 'utf8');

interface Request {
  path: string;
  method: string;
  key: string | null;
  body: string | Uint8Array | undefined;
}

function fixture() {
  const requests: Request[] = [];
  const principal: Principal = {
    id: missionAuthority.principalId,
    tenantId: missionAdapterBinding.tenantId,
    name: 'Fictional mission source',
    revision: missionAuthority.principalRevision,
    capabilities: ['input:write', 'mission:write'],
    commandLinkSources: [],
    missionSources: [missionAdapterBinding.sourceId],
  };
  const state = {
    principal,
    document: openApiDocument as unknown,
    response: structuredClone(missionAdapterResult.receipt),
    loseNextInputResponse: false,
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
      return Response.json({ upload: { id: 'mission-upload', status: 'pending', ...uploadMetadata } });
    }
    if (path === '/v1/uploads/mission-upload/content' && method === 'PUT') {
      uploaded = Buffer.from(options!.body as Uint8Array);
      return Response.json({
        upload: { id: 'mission-upload', status: 'stored', ...uploadMetadata, sha256: sha256(uploaded) },
      });
    }
    if (path === '/v1/uploads/mission-upload/finalize' && method === 'POST')
      return Response.json({
        artifact: {
          id: preparedMissionInput.input.artifactId,
          uploadId: 'mission-upload',
          sha256: sha256(uploaded),
          byteLength: uploaded.byteLength,
          contentType: uploadMetadata.contentType,
          key: `${missionAdapterBinding.tenantId}/uploads/mission-upload`,
        },
        meta: state.response.meta,
      });
    if (path === '/v1/inputs' && method === 'POST') {
      if (state.loseNextInputResponse) {
        state.loseNextInputResponse = false;
        throw new Error('Injected lost response after intake accepted');
      }
      return Response.json(state.response, { status: 201 });
    }
    throw new Error(`Unexpected mission HTTP request: ${method} ${path}`);
  });
  const adapter = new MissionAdapter(missionAdapterConfig(ledger));
  const writes = () => requests.filter((request) => request.method !== 'GET');
  const inputs = () => requests.filter((request) => request.path === '/v1/inputs');
  return { adapter, ledger, state, requests, writes, inputs };
}

function reanchor(prepared: PreparedMissionInput): PreparedMissionInput {
  const { submissionDigest: _submissionDigest, ...content } = prepared;
  return { ...content, submissionDigest: canonicalDigest(content) };
}

describe('bounded mission adapter', () => {
  it('preserves the shared exact-byte mapping and rejects invalid geometry or reanchored bindings before writes', async () => {
    const f = fixture();
    for (const raw of [
      Buffer.from([0xff, 0xfe]),
      Buffer.from(`{"sourceRevision":2,${JSON.stringify(missionSource).slice(1)}`),
      Buffer.concat([original, Buffer.alloc(64 * 1024, ' ')]),
      Buffer.from(
        JSON.stringify({
          ...missionSource,
          route: {
            ...missionSource.route,
            geometry: { type: 'LineString', coordinates: Array.from({ length: 257 }, () => [-87.63, 41.88]) },
          },
        }),
      ),
      Buffer.from(JSON.stringify({ ...missionSource, altitude: { ...missionSource.altitude, minimum: 61 } })),
      Buffer.from(
        JSON.stringify({
          ...missionSource,
          operatingInterval: { start: missionSource.operatingInterval.end, end: missionSource.operatingInterval.start },
        }),
      ),
      Buffer.from(JSON.stringify({ ...missionSource, sourceMissionId: 'another-mission' })),
      Buffer.from(JSON.stringify({ ...missionSource, aircraftId: 'another-aircraft' })),
    ])
      await expect(f.adapter.prepare(raw)).rejects.toThrow();
    expect(f.writes()).toEqual([]);

    const prepared = await f.adapter.prepare(original);
    expect(prepared).toEqual(preparedMissionInput);
    expect(f.inputs()).toEqual([]);
    expect(Buffer.from(f.requests.find((request) => request.method === 'PUT')!.body as Uint8Array)).toEqual(original);
    expect(JSON.parse(f.requests.find((request) => request.path === '/v1/uploads')!.body as string)).toMatchObject({
      byteLength: original.length,
      contentType: 'application/json',
    });
    expect(JSON.stringify(prepared)).not.toContain('never-retain-this-token');

    const writes = f.writes().length;
    const retargeted = structuredClone(prepared);
    retargeted.input.subject.flightId = 'another-flight';
    await expect(f.adapter.send(reanchor(retargeted))).rejects.toThrow();
    const changedSource = structuredClone(prepared);
    changedSource.input.sourceId = 'another-source';
    await expect(f.adapter.send(reanchor(changedSource))).rejects.toThrow();
    const changedRevision = reanchor({
      ...prepared,
      input: { ...missionRevision2Input, artifactId: prepared.input.artifactId },
      bytesBase64: Buffer.from(missionRevision2SourceText).toString('base64'),
      sha256: sha256(missionRevision2SourceText),
    });
    await expect(f.adapter.send(changedRevision)).rejects.toThrow();
    const changedArtifact = structuredClone(prepared);
    changedArtifact.input.artifactId = 'another-artifact';
    await expect(f.adapter.recover(changedArtifact)).rejects.toThrow();
    expect(f.writes()).toHaveLength(writes);

    await f.adapter.send(prepared);
    expect(f.inputs()).toHaveLength(1);
    expect(f.inputs()[0]!.key).toBe(preparedMissionInput.key);
    expect(JSON.parse(f.inputs()[0]!.body as string)).toEqual(preparedMissionInput.input);
  });

  it('keeps missing capability, mission source scope and incompatible served constraints pending before upload', async () => {
    const missingCapability = fixture();
    missingCapability.state.principal.capabilities = ['input:write'];
    const missingSource = fixture();
    missingSource.state.principal.missionSources = [];
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
                      properties: { sourceId: { const: missionAdapterBinding.sourceId } },
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

  it('recovers a JSON checkpoint after an ambiguous response with its original key and artifact after grant revocation', async () => {
    const f = fixture();
    const prepared = await f.adapter.prepare(original);
    const checkpoint = JSON.parse(JSON.stringify(prepared)) as PreparedMissionInput;
    expect(checkpoint).toEqual(preparedMissionInput);
    f.state.loseNextInputResponse = true;
    await expect(f.adapter.send(checkpoint)).rejects.toThrow('Injected lost response');
    expect(f.inputs()).toHaveLength(1);
    const first = f.inputs()[0]!;

    f.state.principal.capabilities = ['input:write'];
    f.state.principal.missionSources = [];
    f.state.principal.revision += 1;
    const resumed = new MissionAdapter(missionAdapterConfig(f.ledger));
    await expect(resumed.send(checkpoint)).rejects.toMatchObject({ code: 'capability_required' });
    expect(f.inputs()).toHaveLength(1);
    f.state.document = {};
    const before = f.requests.length;
    expect(await resumed.recover(checkpoint)).toEqual(missionAdapterResult);
    expect(f.inputs()).toHaveLength(2);
    expect(f.inputs()[1]).toEqual(first);
    expect(
      f.requests
        .slice(before)
        .some((request) => request.path === '/openapi.json' || request.path.startsWith('/v1/uploads')),
    ).toBe(false);

    f.state.principal.id = 'another-principal';
    await expect(resumed.recover(checkpoint)).rejects.toThrow();
    f.state.principal.id = checkpoint.principalId;
    f.state.principal.capabilities = [];
    await expect(resumed.recover(checkpoint)).rejects.toMatchObject({ code: 'capability_required' });
    expect(f.inputs()).toHaveLength(2);
  });

  it('preserves an earlier canonical receipt independently of the new upload and current issuer', async () => {
    const f = fixture();
    f.state.principal.id = 'replacement-authorized-principal';
    const prepared = await f.adapter.prepare(original);
    expect(prepared.principalId).toBe('replacement-authorized-principal');
    const result = await f.adapter.send(prepared);
    expect(result).toEqual(missionAdapterResult);
    expect(result.receipt.receipt.artifactId).not.toBe(prepared.input.artifactId);
    expect(result.submittedUploadArtifactId).toBe(preparedMissionInput.input.artifactId);
  });
});
