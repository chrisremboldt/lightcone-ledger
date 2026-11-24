CREATE TABLE mission_avoidance_register (
 tenant_id text PRIMARY KEY REFERENCES tenants(id),revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0)
);
ALTER TABLE mission_avoidance_register ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON mission_avoidance_register
 USING(tenant_id=current_setting('ledger.tenant_id',true))
 WITH CHECK(tenant_id=current_setting('ledger.tenant_id',true));
GRANT SELECT ON mission_avoidance_register TO ledger_app;
INSERT INTO mission_avoidance_register(tenant_id) SELECT id FROM tenants;
CREATE INDEX mission_avoidance_intervals ON hazard_controls(tenant_id,effective_from,effective_until);

CREATE FUNCTION ledger_lock_mission_avoidance_register() RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE current_revision bigint;
BEGIN
 SELECT revision INTO current_revision FROM mission_avoidance_register
  WHERE tenant_id=current_setting('ledger.tenant_id',true) FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Mission avoidance tenant scope is unavailable' USING ERRCODE='42501'; END IF;
 RETURN current_revision;
END $$;
REVOKE ALL ON FUNCTION ledger_lock_mission_avoidance_register() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ledger_lock_mission_avoidance_register() TO ledger_app;

CREATE FUNCTION ledger_provision_mission_avoidance_register() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 INSERT INTO mission_avoidance_register(tenant_id) VALUES(NEW.id);
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ledger_provision_mission_avoidance_register() FROM PUBLIC,ledger_app;
CREATE TRIGGER provision_mission_avoidance_register AFTER INSERT ON tenants
 FOR EACH ROW EXECUTE FUNCTION ledger_provision_mission_avoidance_register();

CREATE FUNCTION ledger_publish_mission_avoidance_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE relevant boolean:=false;
BEGIN
 IF TG_TABLE_NAME='hazard_risk_acceptances' THEN
  relevant:=true;
 ELSIF TG_TABLE_NAME='hazard_assessments' THEN
  relevant:=EXISTS(SELECT 1 FROM hazard_risk_acceptances a WHERE a.tenant_id=NEW.tenant_id AND a.hazard_id=NEW.hazard_id);
 ELSIF TG_TABLE_NAME='command_link_source_events' THEN
  relevant:=EXISTS(SELECT 1 FROM hazard_openings o JOIN hazard_risk_acceptances a
   ON a.tenant_id=o.tenant_id AND a.hazard_id=o.hazard_id
   WHERE o.tenant_id=NEW.tenant_id AND o.origin_flight_id=NEW.flight_id);
 ELSIF TG_TABLE_NAME='finding_views' THEN
  relevant:=EXISTS(SELECT 1 FROM findings f JOIN hazard_openings o
   ON o.tenant_id=f.tenant_id AND o.origin_finding_id=f.id
   JOIN hazard_risk_acceptances a ON a.tenant_id=o.tenant_id AND a.hazard_id=o.hazard_id
   WHERE f.tenant_id=NEW.tenant_id AND f.id=NEW.id AND f.leaf_id='ledger.demo.command-link-loss-review');
 ELSIF TG_TABLE_NAME='flight_rule_selection_views' THEN
  IF TG_OP='UPDATE' AND OLD.current_id IS NOT DISTINCT FROM NEW.current_id THEN RETURN NEW; END IF;
  relevant:=EXISTS(SELECT 1 FROM hazard_openings o JOIN hazard_risk_acceptances a
   ON a.tenant_id=o.tenant_id AND a.hazard_id=o.hazard_id
   WHERE o.tenant_id=NEW.tenant_id AND o.origin_flight_id=NEW.flight_id);
 ELSIF TG_TABLE_NAME='organization_pack_adoptions' THEN
  relevant:=NEW.pack_id='ledger.demo-procedures' AND NEW.record->'pack'->>'version'='3'
   AND NEW.record->'pack'->>'digest'='46f777c1c391b696cffc45b450cb61b8563b28417f67ac087522b57e34e56188'
   AND EXISTS(SELECT 1 FROM hazard_openings o JOIN hazard_risk_acceptances a
    ON a.tenant_id=o.tenant_id AND a.hazard_id=o.hazard_id
    WHERE o.tenant_id=NEW.tenant_id AND o.organization_id=NEW.organization_id);
 ELSIF TG_TABLE_NAME='organization_pack_adoption_views' THEN
  relevant:=EXISTS(SELECT 1 FROM organization_pack_adoptions p JOIN hazard_openings o
   ON o.tenant_id=p.tenant_id AND o.organization_id=p.organization_id
   JOIN hazard_risk_acceptances a ON a.tenant_id=o.tenant_id AND a.hazard_id=o.hazard_id
   WHERE p.tenant_id=NEW.tenant_id AND p.id=NEW.id AND p.pack_id='ledger.demo-procedures'
   AND p.record->'pack'->>'version'='3'
   AND p.record->'pack'->>'digest'='46f777c1c391b696cffc45b450cb61b8563b28417f67ac087522b57e34e56188');
 ELSIF TG_TABLE_NAME='work_items' THEN
  relevant:=EXISTS(SELECT 1 FROM hazard_risk_acceptances a
   WHERE a.tenant_id=NEW.tenant_id AND (a.id=NEW.event_id OR a.assessment_id=NEW.event_id
    OR EXISTS(SELECT 1 FROM hazard_controls c WHERE c.tenant_id=a.tenant_id AND c.hazard_id=a.hazard_id
      AND c.control_id=a.control_id AND c.control_version=a.control_version AND c.id=NEW.event_id)))
   OR EXISTS(SELECT 1 FROM hazard_assessments h JOIN hazard_risk_acceptances a
    ON a.tenant_id=h.tenant_id AND a.hazard_id=h.hazard_id WHERE h.tenant_id=NEW.tenant_id AND h.id=NEW.event_id)
   OR EXISTS(SELECT 1 FROM command_link_source_events c JOIN hazard_openings o
    ON o.tenant_id=c.tenant_id AND o.origin_flight_id=c.flight_id
    JOIN hazard_risk_acceptances a ON a.tenant_id=o.tenant_id AND a.hazard_id=o.hazard_id
    WHERE c.tenant_id=NEW.tenant_id AND c.event_id=NEW.event_id)
   OR EXISTS(SELECT 1 FROM finding_views v JOIN hazard_openings o
    ON o.tenant_id=v.tenant_id AND o.origin_finding_id=v.id
    JOIN hazard_risk_acceptances a ON a.tenant_id=o.tenant_id AND a.hazard_id=o.hazard_id
    WHERE v.tenant_id=NEW.tenant_id AND v.latest_evaluation_id=NEW.event_id);
 END IF;
 IF relevant THEN
  UPDATE mission_avoidance_register SET revision=revision+1 WHERE tenant_id=NEW.tenant_id;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ledger_publish_mission_avoidance_change() FROM PUBLIC,ledger_app;

CREATE TRIGGER mission_avoidance_acceptance AFTER INSERT ON hazard_risk_acceptances
 FOR EACH ROW EXECUTE FUNCTION ledger_publish_mission_avoidance_change();
CREATE TRIGGER mission_avoidance_assessment AFTER INSERT ON hazard_assessments
 FOR EACH ROW EXECUTE FUNCTION ledger_publish_mission_avoidance_change();
CREATE TRIGGER mission_avoidance_source AFTER INSERT ON command_link_source_events
 FOR EACH ROW EXECUTE FUNCTION ledger_publish_mission_avoidance_change();
CREATE TRIGGER mission_avoidance_evaluation AFTER UPDATE OF latest_evaluation_id ON finding_views
 FOR EACH ROW WHEN(OLD.latest_evaluation_id IS DISTINCT FROM NEW.latest_evaluation_id)
 EXECUTE FUNCTION ledger_publish_mission_avoidance_change();
CREATE TRIGGER mission_avoidance_selection AFTER INSERT OR UPDATE OF current_id ON flight_rule_selection_views
 FOR EACH ROW EXECUTE FUNCTION ledger_publish_mission_avoidance_change();
CREATE TRIGGER mission_avoidance_adoption AFTER INSERT ON organization_pack_adoptions
 FOR EACH ROW EXECUTE FUNCTION ledger_publish_mission_avoidance_change();
CREATE TRIGGER mission_avoidance_adoption_projection AFTER INSERT ON organization_pack_adoption_views
 FOR EACH ROW EXECUTE FUNCTION ledger_publish_mission_avoidance_change();
CREATE TRIGGER mission_avoidance_pending AFTER UPDATE OF state ON work_items
 FOR EACH ROW WHEN(OLD.state IS DISTINCT FROM NEW.state AND (OLD.state='completed' OR NEW.state='completed'))
 EXECUTE FUNCTION ledger_publish_mission_avoidance_change();
