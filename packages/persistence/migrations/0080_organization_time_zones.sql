-- Each organization keeps the IANA time zone its screens show times in. Existing organizations are the fictional
-- seeded ones, which declare America/Chicago; one inserted without a zone gets UTC.
CREATE OR REPLACE FUNCTION ledger_is_time_zone(p_zone text) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT p_zone IS NOT NULL AND p_zone ~ '^[A-Za-z][A-Za-z0-9_+/-]{0,63}$'
  AND EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=p_zone);
$$;
ALTER TABLE tenants ADD COLUMN time_zone text NOT NULL DEFAULT 'America/Chicago';
ALTER TABLE tenants ALTER COLUMN time_zone SET DEFAULT 'UTC';
ALTER TABLE tenants ADD CONSTRAINT tenants_time_zone_known CHECK (ledger_is_time_zone(time_zone));
