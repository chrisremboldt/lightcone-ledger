import type { ObservationV1 } from '@ledger/contracts';
import type { LedgerClient } from '@ledger/contracts/client';
import { sha256 } from '@ledger/integrity';
import type { ObservationEnvelope, ObservationSink, RetainOriginalRequest } from './adapter-contract.js';

export interface HttpObservationSinkConfig {
  /** Authenticated as the principal that holds the observation grants for sourceId. */
  ledger: LedgerClient;
  sourceId: string;
}

/** Ledger refused a step. Nothing is retried: the caller decides whether the refusal is worth another attempt. */
export class ObservationSinkRefusal extends Error {
  constructor(
    readonly step: 'retain_original' | 'submit_observation',
    readonly status: number,
    readonly code: string,
    detail: string,
  ) {
    super(`Ledger refused ${step.replace('_', ' ')} with ${status} ${code}: ${detail}`);
    this.name = 'ObservationSinkRefusal';
  }
}

const MAX_KEY_LENGTH = 150;
const boundedKey = (value: string): string => (value.length > MAX_KEY_LENGTH ? `sink:${sha256(value)}` : value);

// Read by shape rather than instanceof: a caller may hold a LedgerClient from another copy of the contracts module.
const isApiError = (error: unknown): error is Error & { status: number; body: unknown } =>
  error instanceof Error && typeof (error as { status?: unknown }).status === 'number' && 'body' in error;

function refusal(step: ObservationSinkRefusal['step'], error: unknown): unknown {
  if (!isApiError(error)) return error;
  const body = error.body as { error?: { code?: unknown; message?: unknown } } | string | undefined;
  const detail = typeof body === 'object' ? body?.error : undefined;
  return new ObservationSinkRefusal(
    step,
    error.status,
    typeof detail?.code === 'string' ? detail.code : 'unknown',
    typeof detail?.message === 'string' ? detail.message : typeof body === 'string' ? body : error.message,
  );
}

/**
 * Sends what an adapter produced to Ledger's public API: original bytes through the upload endpoints (create, put
 * content, finalize) and each observation to `POST /v1/inputs` as input kind `observation`. Retaining is keyed by
 * the bytes' SHA-256 and content type, so the same bytes give the same artifact however many observations cite them,
 * across adapters and restarts.
 */
export class HttpObservationSink<O extends ObservationEnvelope = ObservationV1> implements ObservationSink<O> {
  private readonly retained = new Map<string, string>();
  constructor(private readonly config: HttpObservationSinkConfig) {
    if (!config.sourceId) throw new Error('HttpObservationSink needs a sourceId');
  }

  async retainOriginal(request: RetainOriginalRequest): Promise<{ artifactId: string }> {
    const digest = sha256(request.bytes);
    if (digest !== request.sha256) throw new Error('Original bytes do not match the stated SHA-256');
    const cacheKey = `${request.contentType}\n${digest}`;
    const known = this.retained.get(cacheKey);
    if (known) return { artifactId: known };
    const key = boundedKey(`${this.config.sourceId}:original:${sha256(request.contentType)}:${digest}`);
    try {
      const { artifact } = await this.config.ledger.upload(request.bytes, request.contentType, key);
      this.retained.set(cacheKey, artifact.id);
      return { artifactId: artifact.id };
    } catch (error) {
      throw refusal('retain_original', error);
    }
  }

  async submitObservation(observation: O, idempotencyKey: string): Promise<{ receiptId: string }> {
    const payload = observation as unknown as Record<string, unknown>;
    if (typeof payload.occurredAt !== 'string') throw new Error('An observation needs occurredAt');
    try {
      const { receipt } = await this.config.ledger.input(
        { sourceId: this.config.sourceId, kind: 'observation', occurredAt: payload.occurredAt, payload },
        boundedKey(idempotencyKey),
      );
      return { receiptId: receipt.id };
    } catch (error) {
      throw refusal('submit_observation', error);
    }
  }
}
