-- Accepted controls as the organization's rules. The safety decision that changes an organization's accepted controls
-- adopts the next version of its accepted-controls pack in its own transaction; the adoption row is the pack's home.
-- Each version is recorded once per organization, whichever API process assembles it.
CREATE UNIQUE INDEX organization_accepted_control_pack_versions ON organization_pack_adoptions
 (tenant_id,organization_id,((record->'pack'->>'version')::bigint)) WHERE pack_id='ledger.accepted-controls';
