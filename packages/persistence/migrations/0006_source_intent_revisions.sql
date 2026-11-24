-- Retained logical source revisions are derivations of immutable input events.
-- Existing operational rows remain unverified until successful journal history
-- supplies an unambiguous baseline; this migration rewrites no prior history.
CREATE TABLE source_intent_revisions (
 tenant_id text NOT NULL,source_id text NOT NULL,origination_key text NOT NULL,
 revision bigint NOT NULL CHECK(revision BETWEEN 0 AND 9007199254740991),
 payload_digest text NOT NULL CHECK(payload_digest ~ '^[0-9a-f]{64}$'),event_id text NOT NULL,
 retention_origin text NOT NULL CHECK(retention_origin IN ('projected_input','legacy_projected_input')),
 PRIMARY KEY(tenant_id,source_id,origination_key,revision),
 FOREIGN KEY(tenant_id,event_id) REFERENCES journal_events(tenant_id,id)
);
ALTER TABLE source_intent_revisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON source_intent_revisions USING(tenant_id=current_setting('ledger.tenant_id',true)) WITH CHECK(tenant_id=current_setting('ledger.tenant_id',true));
CREATE TRIGGER immutable_source_intent_revisions BEFORE UPDATE OR DELETE ON source_intent_revisions FOR EACH ROW EXECUTE FUNCTION ledger_forbid_history_mutation();
GRANT SELECT,INSERT ON source_intent_revisions TO ledger_app;
-- The current source pin is a projection, separate from retained revision claims.
ALTER TABLE flight_views ADD COLUMN intent_source_id text;
