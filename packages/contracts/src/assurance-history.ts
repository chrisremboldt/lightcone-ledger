import { Type, type Static } from '@sinclair/typebox';
import { HistoryPageSchema } from './history.js';
import { MonitoringReportSourceV2Schema } from './monitoring-window.js';

export const ASSURANCE_HISTORY_DEFAULT_LIMIT = 25;
export const ASSURANCE_HISTORY_MAX_LIMIT = 100;
export const ASSURANCE_HISTORY_MAX_SUMMARY_BYTES = 16 * 1024;
export const ASSURANCE_HISTORY_MAX_RESPONSE_BYTES = 256 * 1024;

const Closed = { additionalProperties: false };
const Id = Type.String({ minLength: 1, maxLength: 200 });
const Digest = Type.String({ pattern: '^[a-f0-9]{64}$' });
const Time = Type.String({
  format: 'date-time',
  pattern: '^(?!0000)\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:[0-5]\\d(?:\\.\\d{1,3})?Z$',
});
const Revision = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const Reference = Type.Object({ id: Id, digest: Digest }, Closed);
const Pagination = {
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: ASSURANCE_HISTORY_MAX_LIMIT, default: ASSURANCE_HISTORY_DEFAULT_LIMIT }),
  ),
};

/** A safety-record hazard named in a path. */
export const HazardParamsSchema = Type.Object({ id: Id }, Closed);
export type HazardParams = Static<typeof HazardParamsSchema>;

export const AssuranceHistoryQuerySchema = Type.Object(Pagination, Closed);
export type AssuranceHistoryQuery = Static<typeof AssuranceHistoryQuerySchema>;
export const HazardMonitoringHistoryQuerySchema = Type.Object(
  { ...Pagination, controlEventId: Id },
  {
    ...Closed,
    description:
      'Discover accepted monitoring revisions for one exact retained control event belonging to this hazard. Never substitute the latest control.',
  },
);
export type HazardMonitoringHistoryQuery = Static<typeof HazardMonitoringHistoryQuerySchema>;
export const AssuranceHistoryPageSchema = Type.Object(
  {
    ...HistoryPageSchema.properties,
    limit: Type.Integer({ minimum: 1, maximum: ASSURANCE_HISTORY_MAX_LIMIT }),
    returned: Type.Integer({ minimum: 0, maximum: ASSURANCE_HISTORY_MAX_LIMIT }),
    nextCursor: Type.Union([Type.String({ minLength: 1, maxLength: 4096 }), Type.Null()]),
    order: Type.Literal('recorded_descending'),
    consistency: Type.Literal('accepted_history'),
  },
  {
    ...Closed,
    description:
      'Newest accepted records first, with deterministic recorded_at/id keysets and an initial upper boundary. Cursors bind tenant, current reader/revision, resource and all exact parent/filter IDs. Pages include accepted records independently of projection and are not a frozen snapshot: an earlier-timestamped concurrent transaction may commit between reads. Restart to include newer records. Absence from a page establishes no completeness or currentness.',
  },
);
export type AssuranceHistoryPage = Static<typeof AssuranceHistoryPageSchema>;

export const MonitoringWindowSummarySchema = Type.Object(
  {
    ...Reference.properties,
    occurredAt: Time,
    recordedAt: Time,
    sourceId: Id,
    sourceSessionId: Id,
    sourceWindowId: Id,
    sourceRevision: Revision,
    window: MonitoringReportSourceV2Schema.properties.window,
  },
  {
    ...Closed,
    description:
      'Persisted accepted monitoring identity, source clocks and fixed window only. ID identifies one exact monitoring revision; digest commits its entire retained monitoring record. Source revision is scoped to source/session/window. No sample payload, originals, projection readiness or calculated assurance is embedded.',
  },
);
export type MonitoringWindowSummary = Static<typeof MonitoringWindowSummarySchema>;

const ControlScope = { hazardId: Id, controlEventId: Id, controlDigest: Digest };
const HistoryFields = { page: AssuranceHistoryPageSchema, readAt: Time };
const Description =
  'Active authentication and flight:read, implicit tenant and exact parent ownership; private, no-store caching. Missing or mismatched parents return 404; valid parents with no matching history return an empty page. At most 100 rows, 16 KiB serialized JSON per summary and 256 KiB per complete response. Size errors return 413 without truncating or skipping identities. Read time describes this page, not a completeness cut or decision basis. Selected existing exact reads supply records and processing separately.';

export const HazardMonitoringHistoryResponseSchema = Type.Object(
  {
    ...ControlScope,
    monitoring: Type.Array(MonitoringWindowSummarySchema, { maxItems: ASSURANCE_HISTORY_MAX_LIMIT }),
    ...HistoryFields,
  },
  { ...Closed, description: `Exact hazard/control monitoring-revision discovery. ${Description}` },
);
export type HazardMonitoringHistoryResponse = Static<typeof HazardMonitoringHistoryResponseSchema>;
