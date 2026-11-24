import { Type, type Static } from '@sinclair/typebox';
import type { Input } from './index.js';

export const HistoryPageSchema = Type.Object(
  {
    limit: Type.Integer({ minimum: 1, maximum: 500 }),
    returned: Type.Integer({ minimum: 0, maximum: 500 }),
    hasMore: Type.Boolean(),
    nextCursor: Type.Union([Type.String(), Type.Null()]),
    selection: Type.Union([Type.Literal('initial'), Type.Literal('continuation')]),
    order: Type.Union([
      Type.Literal('received_ascending'),
      Type.Literal('recorded_ascending'),
      Type.Literal('id_ascending'),
    ]),
    consistency: Type.Literal('live_projection'),
  },
  { additionalProperties: false },
);
export type HistoryPage = Static<typeof HistoryPageSchema>;
export interface HistoryQuery {
  cursor?: string;
  limit?: number;
}
export interface FlightQuery extends HistoryQuery {
  view?: 'all' | 'monitor' | 'overdue' | 'historical-issues' | 'history';
  search?: string;
}
export interface TimelineQuery extends HistoryQuery {
  decisionCursor?: string;
  decisionLimit?: number;
  selectedItemId?: string;
}
export interface OrderQuery extends HistoryQuery {
  flightId?: string;
  sourceId?: string;
  view?: 'all' | 'awaiting-flight' | 'awaiting-current' | 'awaiting-overdue';
}
export interface ReceiptQuery extends HistoryQuery {
  flightId?: string;
  sourceId?: string;
  linkStatus?: 'unresolved' | 'candidate' | 'linked' | 'unlinked';
  excludeKind?: Input['kind'] | 'command-link.status';
}
const Id = Type.String({ minLength: 1, maxLength: 200 });
const Cursor = Type.String({ minLength: 1, maxLength: 4096 });
const pagination = { cursor: Type.Optional(Cursor), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })) };
export const FlightQuerySchema = Type.Object(
  {
    ...pagination,
    cursor: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 4096,
        description:
          'For a scoped view, use the opaque nextCursor from the same tenant, authenticated principal, authority revision, view and trimmed case-preserved search. It retains the initial upper creation-receipt-time/flight-ID position while membership remains a live projection. Restart from the first page after cursor_scope_mismatch. All retains raw flight-ID cursors.',
      }),
    ),
    view: Type.Optional(
      Type.Union(
        ['all', 'monitor', 'overdue', 'historical-issues', 'history'].map((value) => Type.Literal(value)),
        {
          description:
            'Monitor contains current work; overdue contains elapsed nonterminal plans or unconfirmed outcomes; historical-issues contains terminal flights with unresolved findings or record signals; history contains terminal flights without outstanding issues. These scopes filter before pagination and order by immutable flight creation receipt time descending, then flight ID under C collation descending. All retains ID order. No view changes recorded activity or resolves findings.',
        },
      ),
    ),
    search: Type.Optional(
      Type.String({
        maxLength: 200,
        description:
          'Trimmed, literal, case-insensitive search across flight ID, label, aircraft and linked external order IDs. History cursors pin the trimmed search string, preserving its case; empty search is unfiltered.',
      }),
    ),
  },
  {
    additionalProperties: false,
    description:
      'Scoped views use opaque continuation cursors scoped to tenant, authenticated principal, authority revision, view, search and resource, with an initial upper position. Ordering uses original flight creation receipt time, never later evidence arrival. Membership and read-time operation context remain live, not a frozen snapshot; restart from the first page after cursor_scope_mismatch.',
  },
);
export const TimelineQuerySchema = Type.Object(
  {
    ...pagination,
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    decisionCursor: Type.Optional(Cursor),
    decisionLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    selectedItemId: Type.Optional(Id),
  },
  { additionalProperties: false },
);
export const OrderQuerySchema = Type.Object(
  {
    ...pagination,
    flightId: Type.Optional(Id),
    sourceId: Type.Optional(Id),
    view: Type.Optional(
      Type.Union(
        ['all', 'awaiting-flight', 'awaiting-current', 'awaiting-overdue'].map((value) => Type.Literal(value)),
        {
          description:
            'Awaiting views contain accepted orders without a linked flight. Awaiting-current excludes elapsed valid requested ends and keeps unrecorded windows explicit; awaiting-overdue contains elapsed requested windows. Time never changes accepted status or infers cancellation. Awaiting-flight contains both.',
        },
      ),
    ),
  },
  { additionalProperties: false },
);
export const ReceiptQuerySchema = Type.Object(
  {
    ...pagination,
    flightId: Type.Optional(Id),
    sourceId: Type.Optional(Id),
    linkStatus: Type.Optional(
      Type.Union(['unresolved', 'candidate', 'linked', 'unlinked'].map((value) => Type.Literal(value))),
    ),
    excludeKind: Type.Optional(
      Type.Union(
        [
          'order.revision',
          'intent.revision',
          'flight.observation',
          'airspace.status',
          'source.observation',
          'telemetry.segment',
          'command-link.status',
          'command-link.baseline',
          'mission.revision',
          'monitoring.window',
          'observation',
        ].map((value) => Type.Literal(value)),
      ),
    ),
  },
  { additionalProperties: false },
);
