-- Adoption modes. A shadow adoption's rules are evaluated and their findings recorded, but never counted in what a
-- person attests to; an active adoption's findings are. Adoptions accepted before modes existed behaved as active,
-- so they are recorded as active. New adoptions must state a mode: the default is dropped after the backfill.
-- Changing mode is a new adoption that revises an earlier one; history is linear, so each adoption is revised at
-- most once.
ALTER TABLE organization_pack_adoptions
 ADD COLUMN mode text NOT NULL DEFAULT 'active' CHECK(mode IN ('shadow','active')),
 ADD COLUMN revises_id text,
 ADD CONSTRAINT organization_pack_adoption_revises FOREIGN KEY(tenant_id,organization_id,revises_id)
  REFERENCES organization_pack_adoptions(tenant_id,organization_id,id),
 ADD CONSTRAINT organization_pack_adoption_revised_once UNIQUE(tenant_id,revises_id),
 ADD CONSTRAINT organization_pack_adoption_mode_record CHECK(
  COALESCE(record->>'mode','active')=mode AND record->>'revises' IS NOT DISTINCT FROM revises_id);
ALTER TABLE organization_pack_adoptions ALTER COLUMN mode DROP DEFAULT;
