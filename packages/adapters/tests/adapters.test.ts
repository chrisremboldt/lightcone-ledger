import { describe, expect, it } from 'vitest';
import { assertOperationalBody, defaultOrderMapping, mapPartnerOrder, PartnerOrderAdapter } from '../src/index.js';
import { LedgerClient } from '@ledger/contracts/client';
import { sha256 } from '@ledger/integrity';
import { createWorld } from '../../simulation-models/src/index.js';

describe('source mapping and evidence boundary', () => {
  it('keeps order identity, flight intent and attempt separate for split and consolidated fulfillment', () => {
    const world = createWorld();
    const split = mapPartnerOrder(
      world.orders.alpha.find((order) => order.order_id === 'order-alpha-split'),
      'partner-orders',
    );
    expect(split.fulfillments).toHaveLength(2);
    expect(new Set(split.fulfillments.map((flight) => flight.originationKey)).size).toBe(2);
    expect(split.fulfillments.map((flight) => flight.label)).toEqual([
      'Pharmacy run · Eastside Clinic · 1 of 2',
      'Pharmacy run · Eastside Clinic · 2 of 2',
    ]);
    const consolidated = mapPartnerOrder(
      world.orders.alpha.find((order) => order.order_id === 'order-alpha-consolidated-a'),
      'partner-orders',
    );
    expect(consolidated.fulfillments[0]!.orderRefs).toHaveLength(2);
    expect(consolidated.fulfillments[0]!.label).toBe('Lab samples · Mercy North');
    expect(consolidated.fulfillments[0]!.originationKey).toBe('intent-alpha-03:attempt:1');
    expect(consolidated.fulfillments[0]!.aliases).toEqual([
      { sourceId: 'partner-orders', externalId: 'intent-alpha-03' },
    ]);
  });
  it('supports a declarative proprietary mapping without executable code', () => {
    const raw = {
      id: 'custom-order',
      v: 2,
      state: 'OK',
      at: '2026-10-01T13:00:00Z',
      name: 'Custom',
      start: '2026-10-01T14:00:00Z',
      end: '2026-10-01T14:30:00Z',
      rows: [],
    };
    const value = mapPartnerOrder(raw, 'custom', {
      ...defaultOrderMapping,
      id: 'id',
      revision: 'v',
      occurredAt: 'at',
      label: 'name',
      start: 'start',
      end: 'end',
      fulfillments: 'rows',
      statusValues: { OK: 'accepted' },
    });
    expect(value.externalId).toBe('custom-order');
    expect(value.revision).toBe(2);
    expect(() => mapPartnerOrder(raw, 'custom', { ...defaultOrderMapping, id: '__proto__.id' })).toThrow(
      'mapping path',
    );
  });
  it('rejects credential-bearing operational bodies before uploads', async () => {
    expect(() => assertOperationalBody({ nested: { client_secret: 'sensitive' } })).toThrow('Credential field');
    const calls: string[] = [];
    const ledger = new LedgerClient('http://ledger.invalid', 'ledger-source', async (input) => {
      calls.push(String(input));
      throw new Error('unexpected upload');
    });
    const adapter = new PartnerOrderAdapter({
      ledger,
      sourceId: 'partner-orders',
      baseUrl: 'http://partner.invalid',
      apiKey: 'external-secret',
    });
    await expect(
      adapter.ingest(new TextEncoder().encode(JSON.stringify({ client_secret: 'sensitive' }))),
    ).rejects.toThrow('Credential field');
    expect(calls).toHaveLength(0);
  });
  it('keeps a dispatcher cancellation and its original requested window in the order revision', () => {
    const cancellation = {
      reason: 'requested_window_unreachable',
      note: 'The medical delivery cannot meet its requested completion window.',
      decidedAt: '2026-10-17T14:02:00.001Z',
      dispatcher: { id: 'demo-dispatcher-alpha', name: 'Alpha dispatch' },
    };
    const order = {
      order_id: 'missed-medical-delivery',
      version: 2,
      updated_at: cancellation.decidedAt,
      state: 'cancelled',
      schedule: { start: '2026-10-17T14:00:00.000Z', end: '2026-10-17T14:06:00.000Z' },
      requested_work: { name: 'Medical courier' },
      cancellation,
      flights: [],
    };
    expect(mapPartnerOrder(order, 'partner-orders')).toMatchObject({
      externalId: order.order_id,
      revision: 2,
      status: 'cancelled',
      scheduledStart: order.schedule.start,
      scheduledEnd: order.schedule.end,
      fulfillments: [],
      cancellation,
    });
    expect(() => mapPartnerOrder({ ...order, state: 'accepted' }, 'partner-orders')).toThrow('cancelled order');
    expect(() =>
      mapPartnerOrder(
        { ...order, cancellation: { ...cancellation, decidedAt: order.schedule.start } },
        'partner-orders',
      ),
    ).toThrow('revision clock');
  });
  it('retains exact polling batch bytes while excluding HTTP credentials from retained input', async () => {
    const order = createWorld().orders.beta[0]!;
    const original = '{ "orders": [' + JSON.stringify(order) + '] }\n';
    const uploads: string[] = [];
    const inputs: Array<Record<string, unknown>> = [];
    let uploadMetadata = { byteLength: 0, contentType: '' };
    let uploaded = new Uint8Array();
    const ledger = new LedgerClient('http://ledger.invalid', 'ledger-source', async (url, options) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/uploads') {
        const declared = JSON.parse(options!.body as string) as { byteLength: number; contentType: string };
        uploadMetadata = { byteLength: declared.byteLength, contentType: declared.contentType };
        return Response.json({ upload: { id: 'upload-1', status: 'pending', ...uploadMetadata } });
      }
      if (path.endsWith('/content')) {
        uploaded = Uint8Array.from(options!.body as Uint8Array);
        uploads.push(new TextDecoder().decode(uploaded));
        return Response.json({
          upload: { id: 'upload-1', status: 'stored', ...uploadMetadata, sha256: sha256(uploaded) },
        });
      }
      if (path.endsWith('/finalize'))
        return Response.json({
          artifact: {
            id: 'artifact-1',
            uploadId: 'upload-1',
            sha256: sha256(uploaded),
            byteLength: uploaded.byteLength,
            contentType: uploadMetadata.contentType,
            key: 'tenant-alpha/uploads/upload-1',
          },
        });
      if (path === '/v1/inputs') {
        inputs.push(JSON.parse(options!.body as string));
        return Response.json({ receipt: { id: 'receipt-1' } });
      }
      throw new Error(`Unexpected ${path}`);
    });
    const adapter = new PartnerOrderAdapter({
      ledger,
      sourceId: 'partner-orders',
      baseUrl: 'http://partner.invalid',
      apiKey: 'never-retain-me',
      fetcher: async (_url, init) => {
        expect(new Headers(init?.headers).get('x-partner-key')).toBe('never-retain-me');
        return new Response(original, { headers: { 'content-type': 'application/json' } });
      },
    });
    await adapter.poll();
    expect(uploads).toEqual([original]);
    expect(JSON.stringify(inputs)).not.toContain('never-retain-me');
    expect(inputs[0]!.artifactId).toBe('artifact-1');
  });
});
