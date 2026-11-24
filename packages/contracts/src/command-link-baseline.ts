import { Type, type Static } from '@sinclair/typebox';

export const COMMAND_LINK_BASELINE_MAX_BYTES = 64 * 1024;
export const COMMAND_LINK_BASELINE_MAX_READ_BYTES = 64 * 1024;

const Closed = { additionalProperties: false };
const Id = Type.String({ minLength: 1, maxLength: 200 });
const Digest = Type.String({ pattern: '^[a-f0-9]{64}$' });
const Time = Type.String({
  format: 'date-time',
  pattern: '^(?!0000)\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:[0-5]\\d(?:\\.\\d{1,3})?Z$',
});
const Fields = {
  version: Type.Literal('command-link.baseline.1'),
  sourceEventId: Id,
  aircraftId: Id,
  state: Type.Union(['up', 'down', 'unknown'].map((state) => Type.Literal(state))),
};

export const CommandLinkBaselineSourceSchema = Type.Object(
  {
    ...Fields,
    sourceId: Id,
    sourceSessionId: Id,
    flightId: Id,
    occurredAt: Time,
  },
  {
    ...Closed,
    description:
      'Strict UTF-8 source JSON, bounded to 64 KiB of retained original bytes. Report actual state once as the first accepted C2 record of a previously unused exact source/session, permanently bound to one tenant flight and aircraft. The sourceEventId namespace is shared with command-link.status. This is not an incident, restoration, coverage or finality statement; up never closes an incident, and down or unknown cannot establish a rate. Existing sessions cannot acquire a retroactive baseline.',
  },
);
export type CommandLinkBaselineSource = Static<typeof CommandLinkBaselineSourceSchema>;

export const CommandLinkBaselineInputSchema = Type.Object(
  {
    sourceId: Id,
    sourceSessionId: Id,
    kind: Type.Literal('command-link.baseline'),
    occurredAt: Time,
    subject: Type.Object({ flightId: Id }, Closed),
    artifactId: Id,
    fidelity: Type.Literal('synthetic_contract'),
    payload: Type.Object(Fields, Closed),
  },
  {
    ...Closed,
    description:
      'Original sourceId, sourceSessionId, occurredAt and flightId copy the corresponding input fields lexically; payload copies version, sourceEventId, aircraftId and state exactly. Retain and verify the original bytes without manufacturing lost/restored reports. First acceptance requires the existing input:write and command-link:write capabilities and an explicit source grant for this new session.',
  },
);
export type CommandLinkBaselineInput = Static<typeof CommandLinkBaselineInputSchema>;

export const CommandLinkBaselineAuthoritySchema = Type.Object(
  {
    version: Type.Literal('ledger.command-link-baseline-authority.1'),
    principalId: Id,
    tenantId: Id,
    principalRevision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    inputKind: Type.Literal('command-link.baseline'),
    sourceId: Id,
    requiredCapabilities: Type.Tuple([Type.Literal('input:write'), Type.Literal('command-link:write')]),
    grantedSources: Type.Array(Id, { uniqueItems: true, maxItems: 100 }),
  },
  {
    ...Closed,
    description:
      'Retained acceptance-time authority for the one-time new-session baseline. Validate the captured tenant, source, input kind, required capabilities and source grant; later grant or principal-revision changes do not rewrite this snapshot. No new capability is introduced.',
  },
);
export type CommandLinkBaselineAuthority = Static<typeof CommandLinkBaselineAuthoritySchema>;

export const ResolvedCommandLinkBaselineSchema = Type.Object(
  {
    eventId: Id,
    receiptId: Id,
    recordedAt: Time,
    input: CommandLinkBaselineInputSchema,
    authority: CommandLinkBaselineAuthoritySchema,
    original: Type.Object(
      {
        artifactId: Id,
        sha256: Digest,
        byteLength: Type.Integer({ minimum: 1, maximum: COMMAND_LINK_BASELINE_MAX_BYTES }),
      },
      Closed,
    ),
    originalBytesBase64: Type.String({
      minLength: 4,
      maxLength: 4 * Math.ceil(COMMAND_LINK_BASELINE_MAX_BYTES / 3),
      pattern: '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$',
    }),
    processing: Type.Union(['pending', 'completed', 'failed'].map((state) => Type.Literal(state))),
  },
  {
    ...Closed,
    description:
      'Server-resolved exact baseline evidence. Verify strict original JSON, hash/length, lexical source-to-input parity and retained authority. Its immutable evidence digest commits this object excluding originalBytesBase64 and processing. Pending or failed projection cannot establish a supported monitoring rate.',
  },
);
export type ResolvedCommandLinkBaseline = Static<typeof ResolvedCommandLinkBaselineSchema>;

export const CommandLinkBaselineRecordSchema = Type.Omit(
  ResolvedCommandLinkBaselineSchema,
  ['originalBytesBase64', 'processing'],
  { ...Closed, description: 'Immutable retained baseline and original-byte metadata, bounded to 64 KiB of JSON.' },
);
export type CommandLinkBaselineRecord = Static<typeof CommandLinkBaselineRecordSchema>;

export const FlightCommandLinkBaselineParamsSchema = Type.Object({ id: Id, baselineId: Id }, Closed);
export type FlightCommandLinkBaselineParams = Static<typeof FlightCommandLinkBaselineParamsSchema>;

export const CommandLinkBaselineRecordResponseSchema = Type.Object(
  {
    baseline: CommandLinkBaselineRecordSchema,
    digest: Digest,
    processing: Type.Union(['pending', 'processing', 'completed', 'failed'].map((state) => Type.Literal(state))),
  },
  {
    ...Closed,
    description:
      'Exact flight-scoped baseline read, bounded to 64 KiB of JSON. Digest commits baseline only; processing is current worker state. Original bytes remain available through evidence exports.',
  },
);
export type CommandLinkBaselineRecordResponse = Static<typeof CommandLinkBaselineRecordResponseSchema>;
