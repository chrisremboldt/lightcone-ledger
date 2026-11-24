import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { canonicalDigest } from '../../integrity/src/index.js';
import { CommandSchema, capabilityValues } from '../src/index.js';
import { LedgerClient } from '../src/client.js';
import { openApiDocument } from '../src/openapi.js';
import {
  MissionBriefingCommandSchema,
  MissionBriefingRecordSchema,
  MissionBriefingRecordResponseSchema,
  MissionBriefingAcknowledgementCommandSchema,
  MissionBriefingAcknowledgementRecordSchema,
  MissionBriefingAcknowledgementsResponseSchema,
  FlightMissionBriefingParamsSchema,
  MISSION_BRIEFING_MAX_CONTROLS,
  MISSION_BRIEFING_MAX_RECIPIENTS,
  missionBriefingControls,
} from '../src/mission-briefing.js';
import {
  missionBriefingCommand,
  missionBriefingRecord,
  missionBriefingRecordResponse,
  missionBriefingAcknowledgementCommand,
  missionBriefingAcknowledgementRecord,
  missionBriefingCases,
} from '../fixtures/demo/v1/mission-briefing.js';
import { areaControlBody, areaControlBriefingContent } from '../fixtures/demo/v1/area-control.js';
import { missionReleaseRecord } from '../fixtures/demo/v1/mission-release.js';

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);

describe('informational mission briefing', () => {
  it('pins exact released context, instruction, population and reviewed briefing', () => {
    for (const [schema, value] of [
      [MissionBriefingCommandSchema, missionBriefingCommand],
      [MissionBriefingRecordSchema, missionBriefingRecord],
      [MissionBriefingAcknowledgementCommandSchema, missionBriefingAcknowledgementCommand],
      [MissionBriefingAcknowledgementRecordSchema, missionBriefingAcknowledgementRecord],
      [MissionBriefingRecordSchema, missionBriefingCases.newPopulation.briefing],
      [MissionBriefingRecordResponseSchema, missionBriefingRecordResponse],
      [MissionBriefingAcknowledgementsResponseSchema, missionBriefingCases.historicalAfterReleaseChanged.response],
      [MissionBriefingAcknowledgementsResponseSchema, missionBriefingCases.newPopulation.response],
    ] as const) {
      const validate = ajv.compile(schema);
      expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
    }
    const record = missionBriefingRecord;
    const { digest, ...population } = record.population;
    expect(digest).toBe(canonicalDigest(population));
    expect(population.organizationId).toBe(record.organizationId);
    expect(record.context.release).toEqual({
      id: missionReleaseRecord.id,
      digest: canonicalDigest(missionReleaseRecord),
    });
    expect(record.context.mission).toEqual(missionReleaseRecord.basis.avoidance.mission);
    expect(record.context.contextDigest).toBe(missionReleaseRecord.basis.avoidance.contextDigest);
    const [control] = record.context.controls;
    const [content] = record.content.controls;
    expect(control.controlDigest).toBe(canonicalDigest(areaControlBody));
    expect(control.acceptance).toEqual(missionReleaseRecord.basis.avoidance.candidates[0]!.acceptance);
    expect(content).toEqual(areaControlBriefingContent);
    expect(content.controlType).toMatchObject(areaControlBody.controlType);
    expect(content.parameters).toEqual(areaControlBody.parameters);
    expect(missionBriefingAcknowledgementCommand.briefing).toEqual({ id: record.id, digest: canonicalDigest(record) });
    expect(missionBriefingRecordResponse.digest).toBe(canonicalDigest(missionBriefingRecordResponse.briefing));
  });

  it('lists one or more exact controls in a briefing, bounded like route review candidates', () => {
    const brief = ajv.compile(MissionBriefingCommandSchema);
    const record = ajv.compile(MissionBriefingRecordSchema);
    expect(record(missionBriefingRecord), JSON.stringify(record.errors)).toBe(true);
    const [control] = missionBriefingCommand.controls;
    const listOf = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        ...control!,
        controlEventId: `${control!.controlEventId}-${index}`,
      }));
    expect(brief({ ...missionBriefingCommand, controls: listOf(3) })).toBe(true);
    expect(brief({ ...missionBriefingCommand, controls: listOf(MISSION_BRIEFING_MAX_CONTROLS) })).toBe(true);
    for (const controls of [[], listOf(MISSION_BRIEFING_MAX_CONTROLS + 1)])
      expect(brief({ ...missionBriefingCommand, controls })).toBe(false);
    // The earlier command named one control; that form is no longer a briefing command.
    const { controls: _controls, ...single } = missionBriefingCommand;
    expect(brief({ ...single, control })).toBe(false);
    expect(record({ ...missionBriefingRecord, content: { ...missionBriefingRecord.content, controls: [] } })).toBe(
      false,
    );
    // A record that names one control, as earlier versions did, is no longer a briefing record.
    const { controls: _listed, ...singleContext } = missionBriefingRecord.context;
    expect(record({ ...missionBriefingRecord, context: { ...singleContext, control } })).toBe(false);
    expect(record({ ...missionBriefingRecord, version: 'flight.mission-briefing.1' })).toBe(false);
    expect(missionBriefingControls(missionBriefingRecord)).toEqual([
      { reference: missionBriefingRecord.context.controls[0], content: missionBriefingRecord.content.controls[0] },
    ]);
  });

  it('requires an explicit bounded population and rejects proxy acknowledgement selectors', () => {
    const brief = ajv.compile(MissionBriefingCommandSchema);
    for (const recipients of [
      [],
      ['sam', 'sam'],
      Array.from({ length: MISSION_BRIEFING_MAX_RECIPIENTS + 1 }, (_, index) => `principal-${index}`),
    ])
      expect(brief({ ...missionBriefingCommand, recipientPrincipalIds: recipients })).toBe(false);
    const acknowledge = ajv.compile(MissionBriefingAcknowledgementCommandSchema);
    for (const extra of [
      { recipientPrincipalId: missionBriefingRecord.actor.id },
      { actor: missionBriefingRecord.actor },
    ])
      expect(acknowledge({ ...missionBriefingAcknowledgementCommand, ...extra })).toBe(false);
    const accepted = missionBriefingAcknowledgementRecord;
    expect(accepted.recipientPrincipalId).toBe(accepted.actor.id);
    expect(accepted.actor.principalRevision).toBe(missionBriefingAcknowledgementCommand.expectedPrincipalRevision);
    expect(accepted.actor.principalRevision).not.toBe(
      missionBriefingRecord.population.recipients[0]!.principalRevision,
    );
    expect(accepted.actor.id).not.toBe(missionBriefingRecord.actor.id);
    expect(missionBriefingRecord.population.recipients.map(({ principalId }) => principalId)).toEqual([
      accepted.actor.id,
    ]);
    expect(missionBriefingCases.notMember.status).toBe(403);
    expect(
      missionBriefingRecord.population.recipients.some(
        ({ principalId }) => principalId === missionBriefingCases.notMember.authenticatedPrincipalId,
      ),
    ).toBe(false);
  });

  it('retains historical review without carrying it into a changed population', () => {
    const historical = missionBriefingCases.historicalAfterReleaseChanged;
    expect(historical.currentReleaseValidity.status).toBe('changed');
    expect(historical.acknowledgement).toEqual(missionBriefingAcknowledgementRecord);
    const accepted = historical.response.recipients[0]!.acknowledgement;
    expect(accepted.record).toEqual(missionBriefingAcknowledgementRecord);
    expect(accepted.digest).toBe(canonicalDigest(accepted.record));
    expect(accepted.record.briefing).toEqual(historical.response.briefing);
    expect(accepted.record.populationDigest).toBe(historical.response.population.digest);
    expect(historical.response.recipients[0]!.processing).toBe('completed');
    const replacement = missionBriefingCases.newPopulation;
    const { digest, ...population } = replacement.briefing.population;
    expect(digest).toBe(canonicalDigest(population));
    expect(replacement.priorAcknowledgement.briefing.id).not.toBe(replacement.briefing.id);
    expect(replacement.priorAcknowledgement.briefing.digest).not.toBe(canonicalDigest(replacement.briefing));
    expect(replacement.acknowledgements).toEqual([]);
    expect(replacement.remainingPrincipalIds).toEqual(population.recipients.map(({ principalId }) => principalId));
    for (const read of [historical.response, replacement.response]) {
      expect(read.recipients.map(({ recipientPrincipalId }) => recipientPrincipalId)).toEqual(
        read.population.recipients.map(({ principalId }) => principalId),
      );
      expect(read.releaseValidity.release).toEqual(missionBriefingRecord.context.release);
      expect(read.releaseValidity.evaluatedAt).toBe(read.evaluatedAt);
    }
    expect(accepted.record.recipientPrincipalId).toBe(historical.response.recipients[0]!.recipientPrincipalId);
    expect(
      replacement.response.recipients.every((row) => row.acknowledgement === null && row.processing === null),
    ).toBe(true);
  });

  it('serves explicit briefing commands and exact scoped reads through the client', async () => {
    const command = ajv.compile(CommandSchema);
    expect(command(missionBriefingCommand), JSON.stringify(command.errors)).toBe(true);
    expect(command(missionBriefingAcknowledgementCommand), JSON.stringify(command.errors)).toBe(true);
    expect(capabilityValues).toContain('briefing:write');
    expect(capabilityValues).toContain('briefing:ack');
    expect(Object.keys(openApiDocument.paths).filter((path) => path.includes('briefing'))).toEqual([
      '/v1/flights/{id}/briefings/{briefingId}',
      '/v1/flights/{id}/briefings/{briefingId}/acknowledgements',
    ]);
    const params = ajv.compile(FlightMissionBriefingParamsSchema);
    expect(params({ id: 'flight/one', briefingId: 'briefing/one' })).toBe(true);
    expect(params({ id: 'flight/one' })).toBe(false);
    const paths: string[] = [];
    const client = new LedgerClient('https://ledger.invalid', 'fixture-token', async (input) => {
      const url = String(input);
      paths.push(url);
      return Response.json(
        url.endsWith('/acknowledgements')
          ? missionBriefingCases.historicalAfterReleaseChanged.response
          : missionBriefingRecordResponse,
      );
    });
    expect(await client.missionBriefing('flight/one', 'briefing/one')).toEqual(missionBriefingRecordResponse);
    expect(await client.missionBriefingAcknowledgements('flight/one', 'briefing/one')).toEqual(
      missionBriefingCases.historicalAfterReleaseChanged.response,
    );
    expect(paths).toEqual([
      'https://ledger.invalid/v1/flights/flight%2Fone/briefings/briefing%2Fone',
      'https://ledger.invalid/v1/flights/flight%2Fone/briefings/briefing%2Fone/acknowledgements',
    ]);
  });
});
