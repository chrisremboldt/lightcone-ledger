import { expect, test } from 'vitest';
import type { AcceptedAreaControlResponse } from '@ledger/contracts';
import type { LedgerClient } from '@ledger/contracts/client';
import {
  areaControlBriefingContent,
  areaControlCandidate,
  areaControlHazardId,
  areaControlHazardVersion,
  areaControlVersion,
} from '../../packages/contracts/fixtures/demo/v1/area-control.js';
import { resolveAreaControl } from '../../apps/web/src/area-controls.js';

const clientAnswering = (response: AcceptedAreaControlResponse) =>
  ({ acceptedAreaControl: async () => response }) as unknown as LedgerClient;

const candidate = areaControlCandidate('outside');
const reference = {
  hazardId: candidate.hazardId,
  controlId: candidate.controlId,
  controlVersion: candidate.controlVersion,
  controlEventId: candidate.controlEventId,
  controlDigest: candidate.controlDigest,
};

const recordRead: AcceptedAreaControlResponse['control'] = {
  kind: 'control_record',
  hazard: { id: areaControlHazardId, title: areaControlHazardVersion.title },
  controlEventId: areaControlVersion.id,
  bodyDigest: areaControlVersion.bodyDigest,
  owner: areaControlVersion.owner,
  content: areaControlBriefingContent,
};

test('an accepted control record resolves to its type wording, area, hazard and source', async () => {
  const shown = await resolveAreaControl(clientAnswering({ control: recordRead }), reference);
  expect(shown).toEqual({
    controlId: reference.controlId,
    controlVersion: reference.controlVersion,
    sourceLabel: 'Route avoidance area on the safety record',
    eventId: areaControlVersion.id,
    title: areaControlVersion.title,
    wording: areaControlBriefingContent.description,
    area: areaControlBriefingContent.area,
    hazard: recordRead.hazard,
    effective: { from: areaControlBriefingContent.effectiveFrom, until: areaControlBriefingContent.effectiveUntil },
    owner: areaControlVersion.owner,
  });
});

test('a read that is not exactly the referenced version is refused', async () => {
  const client = clientAnswering({ control: recordRead });
  await expect(resolveAreaControl(client, { ...reference, controlDigest: 'd'.repeat(64) })).rejects.toThrow(
    /could not be matched/,
  );
  await expect(resolveAreaControl(client, { ...reference, controlEventId: 'another-version' })).rejects.toThrow(
    /could not be matched/,
  );
  await expect(resolveAreaControl(client, { ...reference, hazardId: 'another-hazard' })).rejects.toThrow(
    /could not be matched/,
  );
});
