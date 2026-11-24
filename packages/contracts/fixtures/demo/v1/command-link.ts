import { identity } from './ready.js';
import type { Command, CommandLinkInput, CommandLinkSource, Input, Principal } from '../../../src/index.js';

export const commandLinkLossSource = {
  sourceSessionId: 'demo-71031:link:capture:1',
  sourceEventId: 'link-event:1',
  incidentId: 'demo-71031:incident:regional-link:1',
  aircraftId: 'demo-71031:aircraft:1',
  occurredAt: '2026-10-15T14:12:00Z',
  status: 'lost',
  position: { longitude: -87.622, latitude: 41.884 },
} satisfies CommandLinkSource;
export const commandLinkRestorationSource = {
  ...commandLinkLossSource,
  sourceEventId: 'link-event:2',
  occurredAt: '2026-10-15T14:12:30Z',
  status: 'restored',
} satisfies CommandLinkSource;

/**
 * RETAINED: the record the retired command-link intake kept for a report. Ledger no longer accepts this input kind;
 * records of this shape stay in retained evidence, which the fixtures below describe.
 */
function commandLinkInput(source: CommandLinkSource, artifactId: string): CommandLinkInput {
  const { sourceSessionId, occurredAt, ...payload } = source;
  return {
    sourceId: 'command-link',
    sourceSessionId,
    kind: 'command-link.status',
    occurredAt,
    subject: { flightId: identity.flightId },
    artifactId,
    fidelity: 'synthetic_contract',
    payload,
  };
}
export const commandLinkLoss = commandLinkInput(commandLinkLossSource, 'resolved-link-loss-artifact');
export const commandLinkRestoration = commandLinkInput(
  commandLinkRestorationSource,
  'resolved-link-restoration-artifact',
);

/** The limitations the command-link adapter's descriptor states for every report it translates. */
export const commandLinkStatusLimitations = [
  'Built from a synthetic source contract, not from a real aircraft or ground station.',
  'The source reports only transitions of the command and control link: lost becomes down and restored becomes up. It sends no samples between them.',
  'The incident id is the source’s own grouping of a loss with its restoration; it is carried as the episode id.',
  'The reported aircraft is the source’s own identifier, not a Ledger aircraft.',
  'Position, when present, is the source’s reported longitude and latitude in WGS84 degrees, without altitude.',
];

/**
 * What a link monitor sends for a report now: after uploading the original bytes, the link.status observation the
 * command-link adapter (packages/adapters/src/command-link-status.ts) makes of them, as an observation input.
 */
export function commandLinkObservationInput(
  source: CommandLinkSource,
  artifactId: string,
  flightId: string = identity.flightId,
  sourceId = 'command-link',
): Input {
  return {
    sourceId,
    kind: 'observation',
    occurredAt: source.occurredAt,
    payload: {
      type: 'link.status',
      version: 1,
      subject: { kind: 'flight', id: flightId, scope: 'ledger' },
      secondarySubject: { kind: 'aircraft', id: source.aircraftId, scope: 'source' },
      occurredAt: source.occurredAt,
      sourceEventId: source.sourceEventId,
      sourceSessionId: source.sourceSessionId,
      ...(source.position
        ? { position: { latitudeDegrees: source.position.latitude, longitudeDegrees: source.position.longitude } }
        : {}),
      values: {
        link: 'command_control',
        state: source.status === 'lost' ? 'down' : 'up',
        report: 'transition',
        sourceEpisodeId: source.incidentId,
      },
      fidelity: 'synthetic_contract',
      limitations: [...commandLinkStatusLimitations],
      originalArtifactId: artifactId,
    },
  };
}
export const commandLinkLossObservation = commandLinkObservationInput(
  commandLinkLossSource,
  'resolved-link-loss-artifact',
);
export const commandLinkRestorationObservation = commandLinkObservationInput(
  commandLinkRestorationSource,
  'resolved-link-restoration-artifact',
);

/** Grants a link monitor link.status observations under its source id, keeping its other observation grants. */
export function authorizeLinkStatusSource(
  target: Pick<Principal, 'id' | 'revision' | 'capabilities' | 'observationGrants'>,
  sourceId: string,
): Extract<Command, { kind: 'authority.update' }> {
  return {
    kind: 'authority.update',
    principalId: target.id,
    expectedRevision: target.revision,
    capabilities: [...new Set([...target.capabilities, 'input:write' as const])],
    observationGrants: [...(target.observationGrants ?? []), { sourceId, observationType: 'link.status' }],
  };
}
