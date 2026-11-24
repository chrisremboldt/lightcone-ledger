import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/index.js';
import type {
  OrganizationCoverageResponse,
  PackAdoptionCommand,
  RuleEvaluationRecord,
  RulePackVersion,
  SubjectFindingRecord,
} from '../../packages/contracts/src/index.js';
import { adoptShownPack } from '../../packages/contracts/fixtures/demo/v1/ready.js';
import {
  defineCheckedRule,
  findCheckKind,
  registerObservationTypes,
  registerRulePack,
} from '../../packages/domain/src/index.js';
import { canonicalDigest, sha256 } from '../../packages/integrity/src/index.js';
import { createPool, MemoryObjectStore, type AuthContext } from '../../packages/persistence/src/index.js';
import { rotorIcingObservation, rotorIcingType } from '../unit/rotor-icing-observation.js';
import { drainOwnedWork, settleOwnedWork } from './worker-queue.js';

// The rules, their observation type and both versions of their pack exist only in this test.
describe.runIf(process.env.LEDGER_ENV !== 'staging')(
  'Successor adoptions of a newer pack version on PostgreSQL',
  () => {
    const prefix = `adoption-successor-${randomUUID()}`;
    const tenantId = `${prefix}:tenant`;
    const pool = createPool();
    const admin = createPool(process.env.DATABASE_ADMIN_URL);
    const workerPool = createPool(process.env.WORKER_DATABASE_URL);
    const sourceId = `${prefix}-sensor`;
    const type = 'rotor.successor-reading';
    let app: Awaited<ReturnType<typeof createApp>>;
    let artifactId: string;

    function floorRule(
      id: string,
      version: number,
      limit: number,
      adoptionParameters: { name: string; title: string; valueType: 'number' }[] = [],
    ) {
      return defineCheckedRule({
        id,
        version,
        title: `Outside air stays above ${limit} Celsius`,
        source: {
          kind: 'operator_procedure',
          reference: `Fictional procedure ${id} ${version}`,
          text: 'Stop while the outside air is at or below the floor.',
        },
        target: { subjectKind: 'aircraft' },
        reads: [{ name: 'subject', type, versions: [1], about: 'target', required: true, select: 'latest' }],
        check: {
          kind: findCheckKind('value.within-limit', 1)!,
          // A parameter the adopter supplies is not fixed here.
          params: {
            field: 'values.outsideAirTemperatureCelsius',
            comparison: 'above',
            ...(adoptionParameters.length ? {} : { limit }),
          },
        },
        ...(adoptionParameters.length ? { adoptionParameters } : {}),
      });
    }
    function packVersion(version: number, leaves: RulePackVersion['leaves']): RulePackVersion {
      const content = {
        packId: `${prefix}.pack`,
        version,
        title: 'Fictional floor procedures',
        status: 'draft' as const,
        review: 'ai_drafted' as const,
        adopted: false as const,
        bindings: [],
        leaves,
      };
      return { ...content, digest: canonicalDigest(content) };
    }
    const floor = 'test.successor-floor';
    const dropped = 'test.successor-dropped';
    const added = 'test.successor-added';
    const first = packVersion(1, [floorRule(floor, 1, 0), floorRule(dropped, 1, 5)]);
    const second = packVersion(2, [
      floorRule(floor, 2, 0, [{ name: 'limit', title: 'Floor (Celsius)', valueType: 'number' }]),
      floorRule(added, 1, -10),
    ]);

    const base = { tenantId, revision: 1, kind: 'human', name: 'Fictional adopter' };
    const actor: AuthContext = {
      ...base,
      id: `${tenantId}:actor`,
      capabilities: ['flight:read', 'evidence:read', 'authority:write', 'pack:adopt', 'input:write'],
    };
    const worker: AuthContext = {
      ...base,
      id: `${tenantId}:worker`,
      kind: 'worker',
      capabilities: ['flight:read', 'evidence:read'],
    };
    const source: AuthContext = {
      ...base,
      id: `${tenantId}:source`,
      kind: 'source',
      capabilities: ['input:write', 'flight:read', 'evidence:read'],
    };
    const firstInterval = {
      start: new Date(Date.now() - 60_000).toISOString(),
      end: new Date(Date.now() + 3_600_000).toISOString(),
    };

    function call(principal: AuthContext, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
      return app.inject({
        method,
        url,
        headers: { authorization: `Bearer ledger-dev-${principal.id}`, 'idempotency-key': randomUUID() },
        ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
      });
    }
    async function coverage(): Promise<OrganizationCoverageResponse> {
      const response = await call(actor, 'GET', '/v1/organization/coverage');
      expect(response.statusCode, response.body).toBe(200);
      return response.json();
    }
    async function retained(version: number): Promise<RulePackVersion> {
      const response = await call(
        actor,
        'GET',
        `/v1/rule-packs/${encodeURIComponent(first.packId)}/versions/${version}`,
      );
      expect(response.statusCode, response.body).toBe(200);
      return response.json().pack;
    }
    async function draft(
      version: number,
      interval: PackAdoptionCommand['effectiveInterval'],
      extra: Partial<PackAdoptionCommand> = {},
    ): Promise<PackAdoptionCommand> {
      const shown = await retained(version);
      return {
        ...adoptShownPack(await coverage(), shown, interval, 'Fictional procedure review.', 'active'),
        ...extra,
      };
    }
    async function settle(): Promise<void> {
      await drainOwnedWork(admin, workerPool, [prefix]);
    }
    async function upload(): Promise<string> {
      const bytes = Buffer.from(JSON.stringify({ entered: 'fictional reading log' }));
      const created = await call(source, 'POST', '/v1/uploads', {
        contentType: 'application/json',
        byteLength: bytes.byteLength,
      });
      expect(created.statusCode, created.body).toBe(201);
      const id = created.json().upload.id as string;
      const stored = await app.inject({
        method: 'PUT',
        url: `/v1/uploads/${id}/content`,
        headers: {
          authorization: `Bearer ledger-dev-${source.id}`,
          'idempotency-key': randomUUID(),
          'content-type': 'application/octet-stream',
        },
        payload: bytes,
      });
      expect(stored.statusCode, stored.body).toBe(200);
      const finalized = await call(source, 'POST', `/v1/uploads/${id}/finalize`);
      expect(finalized.statusCode, finalized.body).toBe(201);
      return finalized.json().artifact.id as string;
    }
    async function report(sourceEventId: string, celsius: number): Promise<void> {
      const observation = rotorIcingObservation(
        {
          subject: { kind: 'aircraft', id: 'tail-12', scope: 'source' },
          sourceEventId,
          occurredAt: new Date(Date.now() - 1000).toISOString(),
          values: { severity: 'light', outsideAirTemperatureCelsius: celsius },
        },
        type,
      );
      const response = await call(source, 'POST', '/v1/inputs', {
        sourceId,
        kind: 'observation',
        occurredAt: observation.occurredAt,
        payload: { ...observation, originalArtifactId: artifactId },
      });
      expect(response.statusCode, response.body).toBe(201);
      await settle();
    }
    const subjectQuery = new URLSearchParams({
      subjectKind: 'aircraft',
      subjectId: 'tail-12',
      subjectScope: 'source',
      sourceId,
    }).toString();
    async function evaluations(ruleId: string): Promise<RuleEvaluationRecord[]> {
      const response = await call(actor, 'GET', `/v1/evaluations?${subjectQuery}`);
      expect(response.statusCode, response.body).toBe(200);
      return (response.json().evaluations as RuleEvaluationRecord[]).filter((item) => item.rule.id === ruleId);
    }
    async function findings(): Promise<SubjectFindingRecord[]> {
      const response = await call(actor, 'GET', `/v1/findings?${subjectQuery}`);
      expect(response.statusCode, response.body).toBe(200);
      return response.json().findings;
    }
    async function refused(command: PackAdoptionCommand, status: number, code: string): Promise<void> {
      const response = await call(actor, 'POST', '/v1/commands', command);
      expect(response.statusCode, response.body).toBe(status);
      expect(response.json().error.code).toBe(code);
    }

    beforeAll(async () => {
      registerObservationTypes(rotorIcingType(type));
      registerRulePack({ packId: first.packId, versions: [first, second] });
      app = await createApp({ pool, env: 'test', objectStore: new MemoryObjectStore() });
      await app.ready();
      await admin.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenantId, 'Fictional successor operator']);
      for (const principal of [actor, worker, source]) {
        await admin.query('INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,$3,$4,$5)', [
          principal.id,
          tenantId,
          principal.name,
          principal.kind,
          principal.capabilities,
        ]);
        await admin.query('INSERT INTO api_credentials(token_hash,principal_id) VALUES($1,$2)', [
          sha256(`ledger-dev-${principal.id}`),
          principal.id,
        ]);
      }
      const current = await call(actor, 'GET', `/v1/authority/principals/${encodeURIComponent(source.id)}`);
      expect(current.statusCode, current.body).toBe(200);
      const granted = await call(actor, 'POST', '/v1/commands', {
        kind: 'authority.update',
        principalId: source.id,
        expectedRevision: current.json().principal.revision,
        capabilities: current.json().principal.capabilities,
        observationGrants: [{ sourceId, observationType: type }],
      });
      expect(granted.statusCode, granted.body).toBe(201);
      artifactId = await upload();
    });
    afterAll(async () => {
      await settleOwnedWork([prefix]);
      if (app) await app.close();
      await pool.end();
      await admin.end();
      await workerPool.end();
    });

    it('adopts version 2 over version 1 from a stated time; evaluations before keep 1, those after carry 2', async () => {
      const adopted = await call(actor, 'POST', '/v1/commands', await draft(1, firstInterval));
      expect(adopted.statusCode, adopted.body).toBe(201);
      const firstId = adopted.json().command.id as string;
      await settle();
      await report('reading-1', -3);
      const [floorBefore] = await evaluations(floor);
      const [droppedBefore] = await evaluations(dropped);
      expect(floorBefore).toMatchObject({ outcome: 'attention', pack: { version: 1 }, adoption: { id: firstId } });
      expect(droppedBefore).toMatchObject({ outcome: 'attention', pack: { version: 1 } });
      const firstRow = (
        await admin.query('SELECT record,succeeds_id FROM organization_pack_adoptions WHERE tenant_id=$1 AND id=$2', [
          tenantId,
          firstId,
        ])
      ).rows[0];

      const start = new Date().toISOString();
      const interval = { start, end: new Date(Date.now() + 7_200_000).toISOString() };
      const parameters = { [floor]: { limit: 10 } };
      await refused(await draft(2, interval, { parameters }), 409, 'adoption_interval_overlap');
      await refused(await draft(1, interval, { succeeds: firstId }), 400, 'invalid_adoption_successor');
      await refused(
        await draft(
          2,
          // From before version 1's start it replaces version 1 whole, so it may not end before version 1 does.
          {
            start: new Date(Date.parse(firstInterval.start) - 1000).toISOString(),
            end: new Date(Date.parse(firstInterval.end) - 1000).toISOString(),
          },
          {
            parameters,
            succeeds: firstId,
          },
        ),
        400,
        'invalid_adoption_successor',
      );
      await refused(
        await draft(2, interval, { parameters, succeeds: firstId, revises: firstId }),
        400,
        'invalid_adoption_successor',
      );
      await refused(await draft(2, interval, { succeeds: firstId }), 400, 'invalid_adoption_parameters');

      const succeeded = await call(
        actor,
        'POST',
        '/v1/commands',
        await draft(2, interval, { parameters, succeeds: firstId }),
      );
      expect(succeeded.statusCode, succeeded.body).toBe(201);
      const secondId = succeeded.json().command.id as string;
      await settle();

      const shown = (await coverage()).adoptions;
      expect(shown.find((item) => item.id === firstId)).toMatchObject({
        state: 'succeeded',
        succeededBy: { id: secondId, version: 2, start },
        effectiveInterval: firstInterval,
      });
      expect(shown.find((item) => item.id === secondId)).toMatchObject({
        state: 'effective',
        succeeds: firstId,
        pack: { version: 2 },
        parameters,
      });
      await refused(
        { ...(await draft(1, firstInterval)), mode: 'shadow', revises: firstId },
        409,
        'adoption_succeeded',
      );
      await refused(await draft(2, interval, { parameters, succeeds: firstId }), 409, 'adoption_already_succeeded');

      // The new version's rules are evaluated for the subject the earlier version evaluated, without new data.
      const [floorAfter, floorEarlier] = await evaluations(floor);
      expect(floorAfter).toMatchObject({
        outcome: 'attention',
        pack: { version: 2 },
        rule: { version: 2 },
        adoption: { id: secondId },
        parameters: { limit: 10 },
        trigger: { kind: 'adoption', eventId: secondId },
      });
      expect(floorEarlier).toEqual(floorBefore);
      const [addedAfter] = await evaluations(added);
      expect(addedAfter).toMatchObject({ outcome: 'pass', pack: { version: 2 }, trigger: { kind: 'adoption' } });
      expect(await evaluations(dropped)).toEqual([droppedBefore]);

      // The removed rule's finding stays open and says its rule is no longer adopted.
      const byRule = new Map((await findings()).map((finding) => [finding.ruleId, finding]));
      expect(byRule.get(dropped)).toMatchObject({ status: 'open', ruleNoLongerAdopted: true });
      expect(byRule.get(floor)).toMatchObject({ status: 'open', latestEvaluation: { id: floorAfter!.id } });
      expect(byRule.get(floor)).not.toHaveProperty('ruleNoLongerAdopted');

      await report('reading-2', -5);
      const [latest] = await evaluations(floor);
      expect(latest).toMatchObject({ pack: { version: 2 }, trigger: { kind: 'observation' } });
      expect(await evaluations(dropped)).toEqual([droppedBefore]);

      // Nothing recorded about the earlier adoption changed; the successor names it.
      const rows = await admin.query(
        'SELECT id,record,succeeds_id FROM organization_pack_adoptions WHERE tenant_id=$1 ORDER BY accepted_revision',
        [tenantId],
      );
      expect(rows.rows.map((row) => [row.id, row.succeeds_id])).toEqual([
        [firstId, null],
        [secondId, firstId],
      ]);
      expect(rows.rows[0].record).toEqual(firstRow.record);
    });
  },
);
