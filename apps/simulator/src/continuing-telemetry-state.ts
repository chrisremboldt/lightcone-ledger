import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  CONTINUING_MODEL,
  ROUTE_DURATION_MS,
  SOURCE_INTERVAL_MS,
  type ContinuingRoute,
  type SimulationTenant,
  type TelemetryFault,
} from './continuing-telemetry-model.js';

export const CONTINUING_STATE_MAX_BYTES = 1024 * 1024;
export interface Publication {
  index: number;
  bytesBase64: string;
  duplicate: boolean;
}
export interface FlightLifecycle {
  route: ContinuingRoute;
  phase: 'capturing' | 'draining';
  checkpointPath: string;
  nextIndex: number;
  emittedIndices: number[];
  skippedIndices: number[];
  publication?: Publication;
  latePublication?: Publication;
  faults: TelemetryFault[];
  duplicateDone: boolean;
  reconnectDone: boolean;
  adapterInitialized: boolean;
  landingReceiptId?: string;
  errorCount: number;
  pause?: { stage: string; code: string; at: string };
}
export interface CompletedLifecycle {
  route: ContinuingRoute;
  checkpointPath: string;
  emittedIndices: number[];
  skippedIndices: number[];
  landingReceiptId: string;
  cleanupPending: boolean;
}
export interface ContinuingState {
  version: 1;
  binding: string;
  active: Partial<Record<SimulationTenant, FlightLifecycle>>;
  recent: CompletedLifecycle[];
}
const validIndices = (value: unknown): value is number[] =>
  Array.isArray(value) &&
  value.length <= 61 &&
  value.every(
    (index) => Number.isSafeInteger(index) && index >= 0 && index <= ROUTE_DURATION_MS / SOURCE_INTERVAL_MS,
  ) &&
  new Set(value).size === value.length;
const validCoordinate = (value: { latitude: number; longitude: number }) =>
  value &&
  Number.isFinite(value.latitude) &&
  Math.abs(value.latitude) <= 90 &&
  Number.isFinite(value.longitude) &&
  Math.abs(value.longitude) <= 180;
const validRoute = (value: ContinuingRoute) =>
  value?.version === CONTINUING_MODEL &&
  ['alpha', 'beta'].includes(value.tenant) &&
  [value.intentId, value.flightId, value.sourceSessionId].every(
    (id) => typeof id === 'string' && id.length > 0 && id.length <= 200,
  ) &&
  Number.isSafeInteger(value.seed) &&
  Number.isFinite(Date.parse(value.startedAt)) &&
  (value.path === undefined ||
    (value.path &&
      typeof value.path.label === 'string' &&
      value.path.label.length > 0 &&
      validCoordinate(value.path.origin) &&
      validCoordinate(value.path.destination)));
const validPublication = (value: Publication | undefined) =>
  !value ||
  (Number.isSafeInteger(value.index) &&
    value.index >= 0 &&
    value.index <= 60 &&
    typeof value.duplicate === 'boolean' &&
    typeof value.bytesBase64 === 'string' &&
    value.bytesBase64.length > 0 &&
    value.bytesBase64.length <= 43_692 &&
    Buffer.from(value.bytesBase64, 'base64').toString('base64') === value.bytesBase64);
export function validateContinuingState(value: ContinuingState, binding: string): ContinuingState {
  if (
    !value ||
    value.version !== 1 ||
    value.binding !== binding ||
    !value.active ||
    typeof value.active !== 'object' ||
    Array.isArray(value.active) ||
    Object.keys(value.active).some((key) => !['alpha', 'beta'].includes(key)) ||
    !Array.isArray(value.recent) ||
    value.recent.length > 32
  )
    throw new Error('Continuing telemetry lifecycle checkpoint is invalid or belongs to another configuration');
  for (const [tenant, flight] of Object.entries(value.active)) {
    if (
      !validRoute(flight.route) ||
      flight.route.tenant !== tenant ||
      !['capturing', 'draining'].includes(flight.phase) ||
      typeof flight.checkpointPath !== 'string' ||
      !Number.isSafeInteger(flight.nextIndex) ||
      flight.nextIndex < 0 ||
      flight.nextIndex > 61 ||
      !validIndices(flight.emittedIndices) ||
      !validIndices(flight.skippedIndices) ||
      !validPublication(flight.publication) ||
      !validPublication(flight.latePublication) ||
      !Array.isArray(flight.faults) ||
      flight.faults.some((fault) => !['duplicate', 'late', 'reconnect'].includes(fault)) ||
      typeof flight.duplicateDone !== 'boolean' ||
      typeof flight.reconnectDone !== 'boolean' ||
      typeof flight.adapterInitialized !== 'boolean' ||
      !Number.isSafeInteger(flight.errorCount) ||
      flight.errorCount < 0
    )
      throw new Error('Continuing telemetry active lifecycle is corrupt');
  }
  for (const flight of value.recent)
    if (
      !validRoute(flight.route) ||
      typeof flight.checkpointPath !== 'string' ||
      !validIndices(flight.emittedIndices) ||
      !validIndices(flight.skippedIndices) ||
      typeof flight.landingReceiptId !== 'string' ||
      typeof flight.cleanupPending !== 'boolean'
    )
      throw new Error('Continuing telemetry completed lifecycle is corrupt');
  return value;
}
export async function readContinuingState(path: string, binding: string): Promise<ContinuingState | undefined> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('Continuing telemetry checkpoint cannot be opened');
  }
  try {
    if ((await handle.stat()).size > CONTINUING_STATE_MAX_BYTES)
      throw new Error('Continuing telemetry checkpoint exceeds its byte bound');
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 65_536 })) {
      length += chunk.byteLength;
      if (length > CONTINUING_STATE_MAX_BYTES)
        throw new Error('Continuing telemetry checkpoint exceeds its byte bound');
      chunks.push(Buffer.from(chunk));
    }
    return validateContinuingState(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length))),
      binding,
    );
  } finally {
    await handle.close();
  }
}
export async function writeContinuingState(path: string, value: ContinuingState): Promise<void> {
  const bytes = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(bytes) > CONTINUING_STATE_MAX_BYTES)
    throw new Error('Continuing telemetry checkpoint exceeds its byte bound');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`,
    handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    const parent = await open(dirname(path), 'r');
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    await unlink(temporary).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }
}
