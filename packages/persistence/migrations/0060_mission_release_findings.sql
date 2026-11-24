-- Release policy version 2 records the open findings the person releasing saw. Releases recorded under
-- version 1 keep their rows and checks; a new release is version 2 and carries a findings section with its digest.
-- Redefines the record identity check of 0028 with one change: either record version, each with its policy version.
DO $$ DECLARE c text; BEGIN
 SELECT conname INTO STRICT c FROM pg_constraint WHERE conrelid='mission_releases'::regclass AND contype='c'
  AND pg_get_constraintdef(oid) LIKE '%flight.mission-release.1%';
 EXECUTE format('ALTER TABLE mission_releases DROP CONSTRAINT %I',c);
END $$;
ALTER TABLE mission_releases ADD CONSTRAINT mission_releases_record_identity CHECK(
 ((record->>'version' IS NOT DISTINCT FROM 'flight.mission-release.1'
   AND record#>'{policy,version}' IS NOT DISTINCT FROM '1'::jsonb AND record#>'{basis,findings}' IS NULL)
  OR (record->>'version' IS NOT DISTINCT FROM 'flight.mission-release.2'
   AND record#>'{policy,version}' IS NOT DISTINCT FROM '2'::jsonb
   AND jsonb_typeof(record#>'{basis,findings,findings}') IS NOT DISTINCT FROM 'array'
   AND record#>>'{basis,findings,digest}' ~ '^[a-f0-9]{64}$'))
 AND record->>'id' IS NOT DISTINCT FROM id AND record->>'flightId' IS NOT DISTINCT FROM flight_id
 AND record->>'organizationId' IS NOT DISTINCT FROM organization_id
 AND record->>'aircraftId' IS NOT DISTINCT FROM aircraft_id
 AND record#>>'{actor,id}' IS NOT DISTINCT FROM actor_id
 AND record#>>'{basis,mission,id}' IS NOT DISTINCT FROM mission_revision_id
 AND record#>>'{basis,mission,missionId}' IS NOT DISTINCT FROM mission_id
 AND jsonb_typeof(record->'acceptedRevision') IS NOT DISTINCT FROM 'number'
 AND (record->>'acceptedRevision')::bigint IS NOT DISTINCT FROM accepted_revision
 AND (record->>'recordedAt')::timestamptz IS NOT DISTINCT FROM recorded_at
);
