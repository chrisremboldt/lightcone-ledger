import { CommandLinkSourceSchema, type CommandLinkSource } from '@ledger/contracts';
import {
  type AdapterDescriptor,
  type ObservationAdapter,
  type TranslateFunction,
  decodeStrictJson,
  jsonPointer,
  rejected,
  subjectFor,
} from './adapter-contract.js';
import { schemaValidator } from './source-contract.js';

/** The capture session and aircraft one adapter instance reports for. A report naming others is refused. */
export interface CommandLinkStatusBinding {
  readonly sourceSessionId: string;
  readonly aircraftId: string;
}

const SOURCE_BYTES_LIMIT = 64 * 1024;
const validateSource = schemaValidator().compile<CommandLinkSource>(CommandLinkSourceSchema);

/** One synthetic command-link report (loss or restoration) becomes one link.status@1 transition. */
export const commandLinkStatusDescriptor: AdapterDescriptor = {
  id: 'synthetic-command-link-status',
  version: '1.0.0',
  source: {
    vendor: 'Ledger simulator',
    product: 'Synthetic command-link report',
    interface: 'One UTF-8 JSON report per HTTP callback, at most 64 KiB',
  },
  produces: [{ type: 'link.status', version: 1 }],
  fidelity: 'synthetic_contract',
  limitations: [
    'Built from a synthetic source contract, not from a real aircraft or ground station.',
    'The source reports only transitions of the command and control link: lost becomes down and restored becomes up. It sends no samples between them.',
    'The incident id is the source’s own grouping of a loss with its restoration; it is carried as the episode id.',
    'The reported aircraft is the source’s own identifier, not a Ledger aircraft.',
    'Position, when present, is the source’s reported longitude and latitude in WGS84 degrees, without altitude.',
  ],
  documentation: [
    {
      reference:
        'Ledger command-link source contract: CommandLinkSourceSchema in packages/contracts/src/command-link-proposal.ts.',
    },
  ],
};

export const translateCommandLinkStatus: TranslateFunction<CommandLinkStatusBinding> = (message, context) => {
  if (message.contentType !== 'application/json') return rejected('A command-link report must be application/json');
  const decoded = decodeStrictJson(message.bytes, SOURCE_BYTES_LIMIT);
  if (!decoded.ok) return rejected(`Invalid or ambiguous JSON: ${decoded.reason}`);
  if (!validateSource(decoded.value))
    return rejected('The report does not match the command-link source contract (unknown or missing fields)');
  const source = decoded.value;
  if (source.sourceSessionId !== context.binding.sourceSessionId)
    return rejected('The report names another capture session than the bound one', jsonPointer('sourceSessionId'));
  if (source.aircraftId !== context.binding.aircraftId)
    return rejected('The report names another aircraft than the bound one', jsonPointer('aircraftId'));
  const flight = subjectFor(context.subjects, 'flight', source.sourceSessionId);
  if (!flight) return rejected('No Ledger flight is bound to this capture session');
  return {
    drafts: [
      {
        type: 'link.status',
        version: 1,
        subject: flight,
        secondarySubject: { kind: 'aircraft', id: source.aircraftId, scope: 'source' },
        occurredAt: source.occurredAt,
        sourceEventId: source.sourceEventId,
        sourceSessionId: source.sourceSessionId,
        ...(source.position
          ? {
              position: { latitudeDegrees: source.position.latitude, longitudeDegrees: source.position.longitude },
            }
          : {}),
        values: {
          link: 'command_control',
          state: source.status === 'lost' ? 'down' : 'up',
          report: 'transition',
          sourceEpisodeId: source.incidentId,
        },
      },
    ],
    rejections: [],
    unmapped: [],
  };
};

export const commandLinkStatusAdapter: ObservationAdapter<CommandLinkStatusBinding> = {
  descriptor: commandLinkStatusDescriptor,
  translate: translateCommandLinkStatus,
};
