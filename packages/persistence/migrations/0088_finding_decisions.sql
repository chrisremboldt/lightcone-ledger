-- One decision a person makes about many findings of one rule is one command record; each finding it names keeps a
-- treatment row of its own, which names that decision. A treatment of one finding names its own command, as before.
ALTER TABLE finding_treatments ADD COLUMN decision_id text;
-- Treatments are append-only; this fills the new column of the rows already recorded and changes nothing else.
ALTER TABLE finding_treatments DISABLE TRIGGER immutable_history;
UPDATE finding_treatments SET decision_id=id;
ALTER TABLE finding_treatments ENABLE TRIGGER immutable_history;
ALTER TABLE finding_treatments
 ALTER COLUMN decision_id SET NOT NULL,
 DROP CONSTRAINT finding_treatments_tenant_id_id_fkey,
 ADD CONSTRAINT finding_treatments_decision FOREIGN KEY(tenant_id,decision_id) REFERENCES command_records(tenant_id,id);
CREATE INDEX finding_treatments_by_decision ON finding_treatments(tenant_id,decision_id);
