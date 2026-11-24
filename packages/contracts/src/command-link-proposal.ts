import { Type, type Static } from '@sinclair/typebox';

const Id = Type.String({ minLength: 1, maxLength: 200 });
const Time = Type.String({
  format: 'date-time',
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:[0-5]\\d(?:\\.\\d{1,3})?Z$',
});
const Position = Type.Object(
  {
    longitude: Type.Number({ minimum: -180, maximum: 180 }),
    latitude: Type.Number({ minimum: -90, maximum: 90 }),
  },
  { additionalProperties: false },
);
const Fields = {
  sourceEventId: Id,
  incidentId: Id,
  aircraftId: Id,
  status: Type.Union([Type.Literal('lost'), Type.Literal('restored')]),
  position: Type.Optional(Position),
};
export const CommandLinkSourceSchema = Type.Object(
  { sourceSessionId: Id, occurredAt: Time, ...Fields },
  {
    additionalProperties: false,
    description: 'Synthetic command-link source JSON; exact original bytes are retained.',
  },
);
export type CommandLinkSource = Static<typeof CommandLinkSourceSchema>;
export const CommandLinkInputSchema = Type.Object(
  {
    sourceId: Id,
    sourceSessionId: Id,
    kind: Type.Literal('command-link.status'),
    occurredAt: Time,
    subject: Type.Object({ flightId: Id }, { additionalProperties: false }),
    artifactId: Id,
    fidelity: Type.Literal('synthetic_contract'),
    payload: Type.Object(Fields, { additionalProperties: false }),
  },
  {
    additionalProperties: false,
    description: 'A reported link state on one exact existing flight; no site or mission applicability is implied.',
  },
);
export type CommandLinkInput = Static<typeof CommandLinkInputSchema>;
export const CommandLinkAuthoritySchema = Type.Object(
  {
    version: Type.Literal('ledger.command-link-authority.1'),
    principalId: Id,
    tenantId: Id,
    principalRevision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    inputKind: Type.Literal('command-link.status'),
    sourceId: Id,
    requiredCapabilities: Type.Tuple([Type.Literal('input:write'), Type.Literal('command-link:write')]),
    grantedSources: Type.Array(Id, { uniqueItems: true, maxItems: 100 }),
  },
  { additionalProperties: false },
);
export type CommandLinkAuthority = Static<typeof CommandLinkAuthoritySchema>;
export const ProposedCommandLinkSourceSchema = CommandLinkSourceSchema;
export const ProposedCommandLinkInputSchema = CommandLinkInputSchema;
export type ProposedCommandLinkSource = CommandLinkSource;
export type ProposedCommandLinkInput = CommandLinkInput;

/** What a timeline item or receipt says about one reported command-link loss or restoration. */
export interface CommandLinkReportFields {
  sourceSessionId?: unknown;
  sourceEventId: unknown;
  incidentId: unknown;
  aircraftId: unknown;
  status: 'lost' | 'restored';
  position?: unknown;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/**
 * Reads a report from a recorded command-link.status payload, or from a link.status observation of the command and
 * control link that reports a transition, as Ledger now receives them. Anything else gives null.
 */
export function commandLinkReportFields(kind: string, payload: unknown): CommandLinkReportFields | null {
  const body = record(payload);
  if (!body) return null;
  if (kind === 'command-link.status')
    return body.status === 'lost' || body.status === 'restored'
      ? ({ ...body, status: body.status } as CommandLinkReportFields)
      : null;
  const values = record(body.values);
  const aircraft = record(body.secondarySubject);
  if (
    kind !== 'observation' ||
    body.type !== 'link.status' ||
    !values ||
    values.link !== 'command_control' ||
    values.report !== 'transition' ||
    (values.state !== 'down' && values.state !== 'up') ||
    aircraft?.kind !== 'aircraft'
  )
    return null;
  const position = record(body.position);
  return {
    sourceSessionId: body.sourceSessionId,
    sourceEventId: body.sourceEventId,
    incidentId: values.sourceEpisodeId,
    aircraftId: aircraft.id,
    status: values.state === 'down' ? 'lost' : 'restored',
    ...(position ? { position: { latitude: position.latitudeDegrees, longitude: position.longitudeDegrees } } : {}),
  };
}
