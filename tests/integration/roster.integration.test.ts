import { randomUUID } from 'node:crypto';
import { afterAll, expect, test, vi } from 'vitest';
import type { FlightQuery, FlightSummary, MissionRevisionRecord, TelemetrySegment } from '@ledger/contracts';
import { missionRecord } from '../../packages/contracts/fixtures/demo/v1/missions.js';
import { getFlight, getFlights } from '../../packages/domain/src/roster.js';
import { canonicalDigest, sha256 } from '../../packages/integrity/src/index.js';
import { appendEvent, createPool, withScope } from '../../packages/persistence/src/index.js';
import { settleOwnedWork } from './worker-queue.js';

const pool = createPool();
const admin = createPool(process.env.DATABASE_ADMIN_URL);
afterAll(async () => {
  await settleOwnedWork(['tenant-alpha']);
  await pool.end();
  await admin.end();
});

test('pages scoped operational records with bounded batch reads and retains terminal issues separately until resolution', async () => {
  const prefix = `roster-${randomUUID()}`;
  const active = Array.from({ length: 205 }, (_, index) => `${prefix}-active-${String(index).padStart(3, '0')}`);
  const closed = `${prefix}-closed`;
  const conflict = `${prefix}-conflict`;
  const denied = `${prefix}-denied`;
  const unlinked = `${prefix}-unlinked`;
  const resolved = `${prefix}-resolved`;
  const ids = [...active, closed, conflict, denied, unlinked, resolved];
  const rollback = new Error('Roll back roster read fixtures');
  await expect(
    withScope(pool, { id: 'principal-alpha-operator', tenantId: 'tenant-alpha' }, async (client, who) => {
      await client.query(
        `INSERT INTO subjects(id,tenant_id,kind,label)
      SELECT id,$1,'flight',id FROM unnest($2::text[]) id`,
        [who.tenantId, ids],
      );
      for (const id of ids)
        await appendEvent(client, who, {
          type: 'flight.created',
          stream: `flight:${id}`,
          payload: { flightId: id, originationKey: id, label: id },
        });
      await client.query(
        `INSERT INTO flight_views(id,tenant_id,origination_key,label,activity,conflict_count,scheduled_end)
      SELECT id,$1,id,id,CASE WHEN id=ANY($3::text[]) THEN 'active' ELSE 'landed' END,
        CASE WHEN id=ANY($4::text[]) THEN 1 ELSE 0 END,clock_timestamp()+interval '1 hour'
        FROM unnest($2::text[]) id`,
        [who.tenantId, ids, active, [conflict, resolved]],
      );

      async function report(id: string, receivedAt: string, kind = 'flight.observation', unlinkedInput = false) {
        const payload = kind === 'airspace.status' ? { status: 'STATUS_DENIED' } : { landingTime: receivedAt };
        const event = await appendEvent(client, who, { type: kind, stream: prefix, payload });
        const receiptId = randomUUID();
        await client.query(
          `INSERT INTO receipts(id,tenant_id,event_id,source_id,kind,occurred_at,received_at,
        flight_id,link_status,payload,input_subject) VALUES($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10)`,
          [
            receiptId,
            who.tenantId,
            event.id,
            prefix,
            kind,
            receivedAt,
            unlinkedInput ? null : id,
            unlinkedInput ? 'unresolved' : 'linked',
            payload,
            { originationKey: id },
          ],
        );
        if (!unlinkedInput)
          await client.query(
            `INSERT INTO claims(id,tenant_id,event_id,receipt_id,flight_id,kind,payload,occurred_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
            [randomUUID(), who.tenantId, event.id, receiptId, id, kind, payload, receivedAt],
          );
      }
      async function resolve(id: string, recordedAt = '2026-10-01T12:01:00Z') {
        const event = await appendEvent(client, who, {
          type: 'decision.record',
          stream: prefix,
          payload: { flightId: id },
        });
        await client.query(
          `INSERT INTO decisions(id,tenant_id,flight_id,actor_id,kind,note,recorded_at,
        rendered_input_cut,accepted_input_cut,accepted_basis_revision)
        VALUES($1,$2,$3,$4,'resolve','Handled',$5,'{"streams":{}}','{"streams":{}}',1)`,
          [event.id, who.tenantId, id, who.id, recordedAt],
        );
      }
      await report(conflict, '2026-10-01T12:00:00Z');
      await report(resolved, '2026-10-01T12:00:00Z');
      await report(denied, '2026-10-01T12:00:00Z', 'airspace.status');
      await report(unlinked, '2026-10-01T12:00:00Z', 'flight.observation', true);
      await resolve(resolved);
      await resolve(unlinked);

      async function queueWork(payload: { flightId?: string }, receiptFlightId?: string, state = 'pending') {
        const event = await appendEvent(client, who, { type: 'flight.observation', stream: prefix, payload });
        if (receiptFlightId)
          await client.query(
            `INSERT INTO receipts(id,tenant_id,event_id,source_id,kind,received_at,flight_id,link_status,payload,input_subject)
            VALUES($1,$2,$3,$4,'flight.observation',$5,$6,'linked','{}','{}')`,
            [randomUUID(), who.tenantId, event.id, prefix, event.received_at, receiptFlightId],
          );
        await client.query('UPDATE work_items SET state=$1 WHERE event_id=$2', [state, event.id]);
      }
      await queueWork({ flightId: active[0] }, active[0], 'failed');
      await queueWork({}, active[0]);
      await queueWork({ flightId: active[0] }, undefined, 'completed');

      async function pages(view: FlightQuery['view'], limit = 200) {
        const flights: FlightSummary[] = [];
        const seen = new Set<string>();
        let cursor: string | undefined = view === 'all' ? prefix : undefined;
        do {
          const spy = vi.spyOn(client, 'query');
          const page = await getFlights(client, who, { view, limit, cursor, search: prefix });
          expect(spy.mock.calls.length).toBeGreaterThanOrEqual(1);
          expect(spy.mock.calls.length).toBeLessThanOrEqual(2);
          spy.mockRestore();
          flights.push(...page.flights.filter((flight) => flight.id.startsWith(prefix)));
          cursor = page.nextCursor ?? undefined;
          if (cursor) {
            expect(seen.has(cursor)).toBe(false);
            seen.add(cursor);
          }
        } while (cursor);
        return flights;
      }
      const monitored = await pages('monitor');
      expect(monitored.map((flight) => flight.id).sort()).toEqual(active);
      expect(monitored.map((flight) => flight.id)).toEqual([...active].reverse());
      expect(monitored.find((flight) => flight.id === active[0])?.outstandingWork).toBe(3);
      expect(monitored.find((flight) => flight.id === active[1])?.outstandingWork).toBe(1);
      expect((await pages('historical-issues')).map((flight) => flight.id).sort()).toEqual([conflict, denied].sort());
      expect((await pages('all')).map((flight) => flight.id)).toEqual([...ids].sort());
      for (const flight of monitored.slice(0, 2)) {
        const exact = await getFlight(client, flight.id);
        expect({ ...exact, operation: undefined }).toEqual({ ...flight, operation: undefined });
        expect(exact.operation).toMatchObject({ scope: 'current', reason: 'plan-window' });
      }
      expect((await pages('history', 1)).map((flight) => flight.id).sort()).toEqual(
        [closed, resolved, unlinked].sort(),
      );

      await report(resolved, '2026-10-01T12:02:00Z');
      await report(unlinked, '2026-10-01T12:02:00Z', 'flight.observation', true);
      const reopened = await pages('historical-issues');
      expect(reopened.map((flight) => flight.id)).toEqual(expect.arrayContaining([resolved, unlinked]));
      expect(reopened.find((flight) => flight.id === unlinked)?.picture?.unresolvedReceivedAt).toBe(
        '2026-10-01T12:02:00.000Z',
      );
      expect((await pages('history', 1)).map((flight) => flight.id)).toEqual([closed]);
      await client.query("UPDATE flight_views SET label='Needle_% archive' WHERE id=$1", [closed]);
      await client.query("UPDATE flight_views SET label='Needle-other' WHERE id=$1", [resolved]);
      expect(
        (await getFlights(client, who, { view: 'history', search: '  nEEdle_%  ' })).flights.map((flight) => flight.id),
      ).toEqual([closed]);
      await client.query(
        `INSERT INTO fulfillments(id,tenant_id,flight_id,source_id,order_external_id,order_revision)
        VALUES($1,$2,$3,$4,$5,1)`,
        [randomUUID(), who.tenantId, closed, prefix, `${prefix}-order`],
      );
      expect(
        (await getFlights(client, who, { view: 'history', search: `${prefix}-order` })).flights.map(
          (flight) => flight.id,
        ),
      ).toEqual([closed]);

      await resolve(resolved, '2026-10-01T12:03:00Z');
      await resolve(denied, '2026-10-01T12:03:00Z');
      const beforeCorrection = (await pages('historical-issues')).map((flight) => flight.id);
      expect(beforeCorrection).not.toContain(resolved);
      expect(beforeCorrection).not.toContain(denied);
      async function correct(id: string, kind: string) {
        const original = (
          await client.query<{ id: string }>(
            'SELECT id FROM claims WHERE flight_id=$1 AND kind=$2 ORDER BY occurred_at,id LIMIT 1',
            [id, kind],
          )
        ).rows[0]!;
        const occurredAt = '2026-10-01T12:00:00Z';
        const payload = kind === 'airspace.status' ? { status: 'STATUS_REVOKED' } : { landingTime: occurredAt };
        const event = await appendEvent(client, who, {
          type: 'evidence.correct',
          stream: prefix,
          occurredAt,
          payload: { flightId: id, correctionOf: original.id, ...payload },
        });
        await client.query(
          `INSERT INTO claims(id,tenant_id,event_id,flight_id,kind,payload,occurred_at,correction_of)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [randomUUID(), who.tenantId, event.id, id, kind, payload, occurredAt, original.id],
        );
        return event.received_at.toISOString();
      }
      const conflictCorrectedAt = await correct(resolved, 'flight.observation');
      const authorizationCorrectedAt = await correct(denied, 'airspace.status');
      const corrected = await pages('historical-issues');
      expect(corrected.map((flight) => flight.id)).toEqual(expect.arrayContaining([resolved, denied]));
      expect(corrected.find((flight) => flight.id === resolved)?.picture?.conflictReceivedAt).toBe(conflictCorrectedAt);
      expect(corrected.find((flight) => flight.id === denied)?.picture?.authorizationReceivedAt).toBe(
        authorizationCorrectedAt,
      );
      throw rollback;
    }),
  ).rejects.toBe(rollback);
});

test('counts each unresolved receipt once across origin and valid aliases without reopening history for other receipts', async () => {
  const id = `roster-alias-${randomUUID()}`;
  const rollback = new Error('Roll back unresolved roster fixtures');
  await expect(
    withScope(pool, { id: 'principal-alpha-operator', tenantId: 'tenant-alpha' }, async (client, who) => {
      await client.query("INSERT INTO subjects(id,tenant_id,kind,label) VALUES($1,$2,'flight',$1)", [id, who.tenantId]);
      await appendEvent(client, who, {
        type: 'flight.created',
        stream: `flight:${id}`,
        payload: { flightId: id, originationKey: id },
      });
      await client.query(
        "INSERT INTO flight_views(id,tenant_id,origination_key,label,activity) VALUES($1,$2,$1,$1,'landed')",
        [id, who.tenantId],
      );
      for (let index = 0; index < 2; index++)
        await client.query(
          `INSERT INTO aliases(id,tenant_id,subject_id,source_id,external_id,valid_from,valid_to)
          VALUES($1,$2,$3,$3,$3,'2026-10-01T12:00:00Z','2026-10-01T13:00:00Z')`,
          [randomUUID(), who.tenantId, id],
        );
      async function report(
        occurredAt: string | null,
        receivedAt: string,
        inputSubject: { originationKey?: string; externalFlightId?: string },
        sourceId = id,
        linkStatus = 'unresolved',
      ) {
        const event = await appendEvent(client, who, { type: 'order.revision', stream: id, payload: {} });
        await client.query(
          `INSERT INTO receipts(id,tenant_id,event_id,source_id,kind,occurred_at,received_at,
          link_status,payload,input_subject) VALUES($1,$2,$3,$4,'order.revision',$5,$6,$7,'{}',$8)`,
          [randomUUID(), who.tenantId, event.id, sourceId, occurredAt, receivedAt, linkStatus, inputSubject],
        );
      }
      const external = { externalFlightId: id };
      await report('2026-10-01T11:59:59Z', '2026-10-01T17:00:00Z', external);
      await report('2026-10-01T13:00:00Z', '2026-10-01T17:00:00Z', external);
      await report(null, '2026-10-01T17:00:00Z', external);
      await report('2026-10-01T12:30:00Z', '2026-10-01T17:00:00Z', external, `${id}-other-source`);
      await report('2026-10-01T12:30:00Z', '2026-10-01T17:00:00Z', {});
      await report('2026-10-01T12:30:00Z', '2026-10-01T17:00:00Z', { originationKey: id }, id, 'linked');
      expect((await getFlight(client, id)).unresolvedCount).toBe(0);
      expect((await getFlights(client, who, { view: 'historical-issues', search: id })).flights).toEqual([]);
      expect(
        (await getFlights(client, who, { view: 'history', search: id })).flights.map((flight) => flight.id),
      ).toEqual([id]);

      await report('2026-10-01T12:00:00Z', '2026-10-01T15:00:00Z', { originationKey: id, ...external });
      await report('2026-10-01T12:30:00Z', '2026-10-01T16:00:00Z', external, id, 'candidate');
      const flight = await getFlight(client, id);
      expect(flight.unresolvedCount).toBe(2);
      expect(flight.picture?.unresolvedReceivedAt).toBe('2026-10-01T16:00:00.000Z');
      expect((await getFlights(client, who, { view: 'historical-issues', search: id })).flights).toMatchObject([
        { id, unresolvedCount: 2 },
      ]);
      expect((await getFlights(client, who, { view: 'history', search: id })).flights).toEqual([]);
      throw rollback;
    }),
  ).rejects.toBe(rollback);
});

test('classifies elapsed windows from physical report clocks and never substitutes an older mission for a pending revision', async () => {
  const prefix = `operation-${randomUUID()}`;
  const rollback = new Error('Roll back operation read fixtures');
  await expect(
    withScope(admin, { id: 'principal-alpha-operator', tenantId: 'tenant-alpha' }, async (client, who) => {
      const now = (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0].now.getTime();
      const at = (offset: number) => new Date(now + offset).toISOString();
      const ids = Object.fromEntries(
        ['planned', 'stale', 'fresh', 'future', 'position', 'unplanned', 'mission'].map((key) => [
          key,
          `${prefix}-${key}`,
        ]),
      );
      for (const [key, id] of Object.entries(ids)) {
        await client.query("INSERT INTO subjects(id,tenant_id,kind,label) VALUES($1,$2,'flight',$1)", [
          id,
          who.tenantId,
        ]);
        await appendEvent(client, who, {
          type: 'flight.created',
          stream: `flight:${id}`,
          payload: { flightId: id, originationKey: id },
        });
        await client.query(
          'INSERT INTO flight_views(id,tenant_id,origination_key,label,activity,scheduled_start,scheduled_end) VALUES($1,$2,$1,$1,$3,$4,$5)',
          [
            id,
            who.tenantId,
            ['stale', 'fresh', 'future', 'position'].includes(key) ? 'active' : 'planned',
            key === 'unplanned' ? null : at(-7_200_000),
            key === 'unplanned' ? null : at(-3_600_000),
          ],
        );
      }
      for (const [key, occurredAt] of [
        ['stale', at(-7_200_000)],
        ['fresh', at(-5_000)],
        ['fresh', at(300_000)],
        ['future', at(300_000)],
      ]) {
        const event = await appendEvent(client, who, {
          type: 'flight.observation',
          stream: prefix,
          occurredAt,
          payload: { flightId: ids[key], activity: 'active' },
        });
        await client.query(
          "INSERT INTO claims(id,tenant_id,event_id,flight_id,kind,payload,occurred_at) VALUES($1,$2,$3,$4,'flight.observation',$5,$6)",
          [randomUUID(), who.tenantId, event.id, ids[key], { activity: 'active' }, occurredAt],
        );
      }
      async function artifact(bytes: Buffer) {
        const artifactId = randomUUID();
        const uploadId = randomUUID();
        const digest = sha256(bytes);
        await client.query(
          'INSERT INTO uploads(id,tenant_id,principal_id,content_type,byte_length,object_key) VALUES($1,$2,$3,$4,$5,$1)',
          [uploadId, who.tenantId, who.id, 'application/json', bytes.length],
        );
        await client.query(
          'INSERT INTO artifacts(id,tenant_id,upload_id,object_key,sha256,byte_length,content_type) VALUES($1,$2,$3,$1,$4,$5,$6)',
          [artifactId, who.tenantId, uploadId, digest, bytes.length, 'application/json'],
        );
        return { artifactId, original: { sha256: digest, byteLength: bytes.length } };
      }
      const original = Buffer.from('{}\n');
      const segment = {
        format: 'ledger.telemetry-segment.1',
        sourceId: prefix,
        sourceSessionId: prefix,
        deviceId: prefix,
        gatewayId: prefix,
        decoderVersion: 'dji-osd.synthetic.1',
        fidelity: 'synthetic_contract',
        coordinateReference: 'WGS84',
        sequenceBasis: 'adapter_capture',
        sessionStartSequence: 0,
        samples: [at(-4_000), at(300_000)].map((occurredAt, sequence) => ({
          sequence,
          occurredAt,
          latitude: 41.88,
          longitude: -87.63,
          altitudeMeters: 50,
          altitudeReference: 'relative' as const,
          original: { topic: prefix, bytesBase64: original.toString('base64') },
        })),
      } satisfies TelemetrySegment;
      const positionArtifact = await artifact(Buffer.from(JSON.stringify(segment)));
      const positionEvent = await appendEvent(client, who, {
        type: 'telemetry.segment',
        stream: prefix,
        sourceId: prefix,
        artifactId: positionArtifact.artifactId,
        payload: { flightId: ids.position },
      });
      const positionReceipt = randomUUID();
      await client.query(
        "INSERT INTO receipts(id,tenant_id,event_id,source_id,kind,occurred_at,received_at,flight_id,artifact_id,link_status,payload,input_subject) VALUES($1,$2,$3,$4,'telemetry.segment',$5,$6,$7,$8,'linked',$9,$10)",
        [
          positionReceipt,
          who.tenantId,
          positionEvent.id,
          prefix,
          at(-4_000),
          positionEvent.received_at,
          ids.position,
          positionArtifact.artifactId,
          segment,
          { flightId: ids.position },
        ],
      );
      const segmentId = randomUUID();
      await client.query(
        'INSERT INTO telemetry_segments(id,tenant_id,receipt_id,event_id,artifact_id,principal_id,session_id,source_id,source_session_id,device_id,descriptor,received_at) VALUES($1,$2,$3,$4,$5,$6,$7,$7,$7,$7,$8,$9)',
        [
          segmentId,
          who.tenantId,
          positionReceipt,
          positionEvent.id,
          positionArtifact.artifactId,
          who.id,
          prefix,
          segment,
          positionEvent.received_at,
        ],
      );
      for (const sample of segment.samples)
        await client.query(
          'INSERT INTO telemetry_samples(id,tenant_id,segment_id,session_id,sample_offset,sequence,occurred_at,received_at,sample,original_topic,original_sha256,claim_digest,position) VALUES($1,$2,$3,$4,$5::integer,$5::bigint,$6,$7,$8,$4,$9,$10,ST_SetSRID(ST_MakePoint($11,$12),4326)::geography)',
          [
            randomUUID(),
            who.tenantId,
            segmentId,
            prefix,
            sample.sequence,
            sample.occurredAt,
            positionEvent.received_at,
            sample,
            sha256(original),
            canonicalDigest(sample),
            sample.longitude,
            sample.latitude,
          ],
        );
      async function scoped(view: FlightQuery['view']) {
        const result = await getFlights(client, who, { view, search: prefix, limit: 20 });
        expect(new Set(result.flights.map((flight) => flight.operation?.asOf)).size).toBe(1);
        return result.flights;
      }
      const overdue = await scoped('overdue');
      expect(overdue.map((flight) => flight.id).sort()).toEqual(
        [ids.planned, ids.stale, ids.future, ids.mission].sort(),
      );
      const stale = overdue.find((flight) => flight.id === ids.stale)!;
      expect(stale.activity).toBe('active');
      expect(stale.operation).toMatchObject({
        scope: 'overdue',
        reason: 'status-unconfirmed',
        activityReport: { activity: 'active' },
      });
      expect(Date.parse(stale.operation!.activityReport!.occurredAt)).toBe(Date.parse(at(-7_200_000)));
      expect(Date.parse(stale.operation!.activityReport!.receivedAt)).toBeGreaterThanOrEqual(now);
      const current = await scoped('monitor');
      expect(current.map((flight) => flight.id).sort()).toEqual([ids.fresh, ids.position, ids.unplanned].sort());
      expect(current.find((flight) => flight.id === ids.fresh)?.operation?.reason).toBe('reported-active');
      expect(Date.parse(current.find((flight) => flight.id === ids.fresh)!.operation!.activityReport!.occurredAt)).toBe(
        Date.parse(at(-5_000)),
      );
      const positioned = current.find((flight) => flight.id === ids.position)!;
      expect(positioned.operation?.reason).toBe('reported-active');
      expect(Date.parse(positioned.operation!.positionOccurredAt!)).toBe(Date.parse(at(-4_000)));
      expect(Date.parse(positioned.picture!.lastPosition!.occurredAt)).toBe(Date.parse(at(300_000)));
      expect(current.find((flight) => flight.id === ids.unplanned)?.operation).toMatchObject({
        reason: 'needs-planning',
        window: null,
      });
      const all = (await getFlights(client, who, { view: 'all', search: prefix })).flights;
      expect(all).toHaveLength(Object.keys(ids).length);
      for (const scoped of [...overdue, ...current]) {
        expect(all.find((flight) => flight.id === scoped.id)?.operation).toMatchObject({
          scope: scoped.operation!.scope,
          reason: scoped.operation!.reason,
        });
      }

      const missionId = `${prefix}-mission-record`;
      await client.query("INSERT INTO subjects(id,tenant_id,kind,label) VALUES($1,$2,'mission',$1)", [
        missionId,
        who.tenantId,
      ]);
      async function revision(sourceRevision: number): Promise<MissionRevisionRecord> {
        const receiptId = randomUUID();
        const operatingInterval = { start: at(-60_000), end: at(3_600_000 + sourceRevision * 60_000) };
        const payload = {
          sourceMissionId: missionId,
          aircraftId: missionRecord.aircraftId,
          route: missionRecord.route,
          lateralToleranceMeters: missionRecord.lateralToleranceMeters,
          altitude: missionRecord.altitude,
          operatingInterval,
        };
        const bytes = Buffer.from(`${JSON.stringify({ ...payload, sourceRevision, occurredAt: at(-60_000) })}\n`);
        const digest = canonicalDigest(payload);
        const { artifactId, original } = await artifact(bytes);
        let record!: MissionRevisionRecord;
        const event = await appendEvent(client, who, {
          type: 'mission.revision',
          stream: `mission:${missionId}`,
          artifactId,
          sourceId: prefix,
          occurredAt: at(-60_000),
          payload: ({ id, receivedAt }) => {
            record = {
              ...missionRecord,
              ...payload,
              id,
              missionId,
              flightId: ids.mission,
              sourceId: prefix,
              sourceRevision,
              occurredAt: at(-60_000),
              recordedAt: receivedAt,
              receiptId,
              artifactId,
              contentDigest: digest,
              original,
              authority: {
                ...missionRecord.authority,
                tenantId: who.tenantId,
                principalId: who.id,
                principalRevision: who.revision,
                sourceId: prefix,
                grantedSources: [prefix],
              },
            };
            const { id: _id, recordedAt: _recordedAt, ...acceptance } = record;
            return { flightId: ids.mission, acceptance };
          },
        });
        if (sourceRevision === 1)
          await client.query(
            'INSERT INTO missions(id,tenant_id,source_id,source_mission_id,flight_id,aircraft_id,first_event_id) VALUES($1,$2,$3,$1,$4,$5,$6)',
            [missionId, who.tenantId, prefix, ids.mission, record.aircraftId, event.id],
          );
        await client.query(
          "INSERT INTO receipts(id,tenant_id,event_id,source_id,kind,occurred_at,received_at,source_revision,flight_id,artifact_id,link_status,payload,input_subject) VALUES($1,$2,$3,$4,'mission.revision',$5,$6,$7,$8,$9,'linked',$10,$11)",
          [
            receiptId,
            who.tenantId,
            event.id,
            prefix,
            record.occurredAt,
            record.recordedAt,
            sourceRevision,
            ids.mission,
            artifactId,
            payload,
            { flightId: ids.mission },
          ],
        );
        await client.query(
          'INSERT INTO mission_revisions(id,tenant_id,mission_id,flight_id,source_revision,receipt_id,artifact_id,content_digest,record,recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [
            record.id,
            who.tenantId,
            missionId,
            ids.mission,
            sourceRevision,
            receiptId,
            artifactId,
            digest,
            record,
            record.recordedAt,
          ],
        );
        return record;
      }
      const first = await revision(1);
      await client.query("UPDATE work_items SET state='completed' WHERE event_id=$1", [first.id]);
      await client.query(
        'INSERT INTO mission_projection_views(tenant_id,mission_id,flight_id,current_revision_id) VALUES($1,$2,$3,$4)',
        [who.tenantId, missionId, ids.mission, first.id],
      );
      const exact = () => getFlight(client, ids.mission);
      expect((await exact()).operation).toMatchObject({
        scope: 'current',
        reason: 'plan-window',
        window: { basis: 'mission', ...first.operatingInterval },
        mission: { state: 'current', accepted: { id: first.id }, projected: { id: first.id } },
      });
      const second = await revision(2);
      for (const [state, publicState] of [
        ['pending', 'pending'],
        ['leased', 'processing'],
        ['failed', 'failed'],
      ]) {
        await client.query('UPDATE work_items SET state=$1 WHERE event_id=$2', [state, second.id]);
        expect((await exact()).operation).toMatchObject({
          scope: 'overdue',
          reason: 'plan-unconfirmed',
          window: null,
          mission: { state: publicState, accepted: { id: second.id }, projected: { id: first.id } },
        });
      }
      await client.query("UPDATE work_items SET state='completed' WHERE event_id=$1", [second.id]);
      expect((await exact()).operation).toMatchObject({
        scope: 'overdue',
        window: null,
        mission: { state: 'pending' },
      });
      await client.query('UPDATE mission_projection_views SET current_revision_id=$1 WHERE mission_id=$2', [
        second.id,
        missionId,
      ]);
      expect((await exact()).operation).toMatchObject({
        scope: 'current',
        window: { basis: 'mission', ...second.operatingInterval },
        mission: { state: 'current' },
      });
      throw rollback;
    }),
  ).rejects.toBe(rollback);
});
