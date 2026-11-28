import type { ObservationV1 } from '@ledger/contracts';
import type { LedgerClient } from '@ledger/contracts/client';
import { sha256 } from '@ledger/integrity';
import {
  type CurrentRecordOptions,
  type ObservationEnvelope,
  type ObservationSink,
  type RetainOriginalRequest,
  keepsOneCurrent,
} from './adapter-contract.js';

export interface HttpObservationSinkConfig extends CurrentRecordOptions {
  /**
   * Authenticated as the principal that holds the observation grants for sourceId. With oneCurrentPerSubject it
   * also needs evidence:read, to read what is on file before it submits.
   */
  ledger: LedgerClient;
  sourceId: string;
}

/** Ledger refused a step. Nothing is retried: the caller decides whether the refusal is worth another attempt. */
export class ObservationSinkRefusal extends Error {
  constructor(
    readonly step: 'retain_original' | 'read_on_file' | 'submit_observation',
    readonly status: number,
    readonly code: string,
    detail: string,
  ) {
    super(`Ledger refused ${step.replaceAll('_', ' ')} with ${status} ${code}: ${detail}`);
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

  /**
   * What this source has on file, not replaced and not withdrawn, of the observation's type about its subject: the
   * one stating the same source event, or else the one received last, which a new observation replaces.
   */
  private async onFile(observation: O): Promise<{ same?: { receiptId: string }; replaces?: string }> {
    const { subject, sourceEventId } = observation as O & {
      subject: { kind: ObservationV1['subject']['kind']; id: string; scope: 'ledger' | 'source' };
      sourceEventId?: string;
    };
    try {
      const { observations } = await this.config.ledger.observations({
        subjectKind: subject.kind,
        subjectId: subject.id,
        subjectScope: subject.scope,
        ...(subject.scope === 'source' ? { sourceId: this.config.sourceId } : {}),
        type: observation.type,
        from: '1970-01-01T00:00:00.000Z',
        to: '9999-12-31T23:59:59.000Z',
        order: 'newest_first',
        limit: 100,
      });
      const own = observations.filter((entry) => entry.sourceId === this.config.sourceId);
      const same = own.find((entry) => entry.sourceEventId === sourceEventId);
      if (same) return { same: { receiptId: same.receiptId } };
      const latest = own.reduce<(typeof own)[number] | undefined>(
        (last, entry) => (!last || Date.parse(entry.receivedAt) > Date.parse(last.receivedAt) ? entry : last),
        undefined,
      );
      return latest ? { replaces: latest.id } : {};
    } catch (error) {
      throw refusal('read_on_file', error);
    }
  }

  async submitObservation(observation: O, idempotencyKey: string): Promise<{ receiptId: string }> {
    const payload = observation as unknown as Record<string, unknown>;
    if (typeof payload.occurredAt !== 'string') throw new Error('An observation needs occurredAt');
    const onFile = keepsOneCurrent(this.config, observation) ? await this.onFile(observation) : {};
    if (onFile.same) return onFile.same;
    try {
      const { receipt } = await this.config.ledger.input(
        {
          sourceId: this.config.sourceId,
          kind: 'observation',
          occurredAt: payload.occurredAt,
          payload,
          ...(onFile.replaces ? { replaces: onFile.replaces } : {}),
        },
        boundedKey(idempotencyKey),
      );
      return { receiptId: receipt.id };
    } catch (error) {
      throw refusal('submit_observation', error);
    }
  }
}
