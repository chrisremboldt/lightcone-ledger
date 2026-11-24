ALTER TABLE decisions DROP CONSTRAINT decisions_target;
ALTER TABLE decisions ADD CONSTRAINT decisions_target CHECK(
 (flight_id IS NOT NULL AND subject_id IS NULL AND adoption_id IS NULL AND accepted_revision IS NULL AND record IS NULL)
 OR (flight_id IS NULL AND subject_id IS NOT NULL AND adoption_id IS NOT NULL AND accepted_revision IS NOT NULL
  AND accepted_revision>0 AND record IS NOT NULL AND jsonb_typeof(record)='object' AND kind='adoption.review')
 OR (flight_id IS NULL AND subject_id IS NOT NULL AND adoption_id IS NULL AND accepted_revision IS NOT NULL
  AND accepted_revision>0 AND record IS NOT NULL AND jsonb_typeof(record)='object'
  AND ((kind='risk.assess' AND record->>'version' IS NOT DISTINCT FROM 'hazard.assessment.1')
   OR (kind='risk.accept' AND record->>'version' IS NOT DISTINCT FROM 'hazard.risk-acceptance.1')
   OR (kind='control.effectiveness-review' AND record->>'version' IS NOT DISTINCT FROM 'hazard.effectiveness-review.2')
   OR (kind='hazard.disposition' AND record->>'version' IS NOT DISTINCT FROM 'hazard.disposition.1'))
  AND record->>'hazardId' IS NOT DISTINCT FROM subject_id)
 OR (flight_id IS NULL AND subject_id IS NOT NULL AND adoption_id IS NULL AND accepted_revision IS NOT NULL
  AND accepted_revision>0 AND record IS NOT NULL AND jsonb_typeof(record)='object'
  AND kind IN ('risk.assess','risk.accept','matrix.adopt')
  AND record->>'version' IS NOT DISTINCT FROM 'sms.decision.1'
  AND record->>'subjectId' IS NOT DISTINCT FROM subject_id
  AND record->>'kind' IS NOT DISTINCT FROM kind)
);
CREATE INDEX sms_decision_kinds ON decisions(tenant_id,kind,recorded_at DESC)
 WHERE record->>'version'='sms.decision.1';

-- Restricted bytes never become rows in artifacts, so no journal event, export or artifact route can reach them.
ALTER TABLE uploads ADD COLUMN confidentiality text NOT NULL DEFAULT 'ordinary'
 CHECK(confidentiality IN ('ordinary','safety_report','restricted_asset_information'));
ALTER TABLE uploads ADD CONSTRAINT uploads_confidential_identity UNIQUE(tenant_id,id,confidentiality);
ALTER TABLE uploads ADD CONSTRAINT uploads_confidential_storage CHECK(
 (confidentiality='ordinary' AND left(object_key,length(tenant_id)+12)<>tenant_id||'/restricted/')
 OR (confidentiality<>'ordinary' AND object_key=tenant_id||'/restricted/'||id||'/content')
);
CREATE FUNCTION ledger_fix_upload_storage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.confidentiality IS DISTINCT FROM NEW.confidentiality OR OLD.object_key IS DISTINCT FROM NEW.object_key THEN
  RAISE EXCEPTION 'upload confidentiality and storage are fixed at creation';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER fixed_upload_storage BEFORE UPDATE ON uploads FOR EACH ROW EXECUTE FUNCTION ledger_fix_upload_storage();
CREATE FUNCTION ledger_ordinary_artifact() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM uploads WHERE tenant_id=NEW.tenant_id AND id=NEW.upload_id AND confidentiality='ordinary') THEN
  RAISE EXCEPTION 'confidential uploads cannot become ordinary artifacts';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ordinary_artifact_upload BEFORE INSERT ON artifacts FOR EACH ROW EXECUTE FUNCTION ledger_ordinary_artifact();

CREATE TABLE restricted_artifacts (
 id text PRIMARY KEY,tenant_id text NOT NULL REFERENCES tenants(id),upload_id text NOT NULL UNIQUE,
 object_key text NOT NULL UNIQUE,sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 byte_length integer NOT NULL CHECK(byte_length>0),content_type text NOT NULL,
 confidentiality text NOT NULL CHECK(confidentiality IN ('safety_report','restricted_asset_information')),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,id,confidentiality),
 FOREIGN KEY(tenant_id,upload_id,confidentiality) REFERENCES uploads(tenant_id,id,confidentiality)
);

CREATE TABLE sms_records (
 id text PRIMARY KEY,tenant_id text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('hazard','risk_matrix')),
 record_class text NOT NULL CHECK(record_class IN
  ('srm_output','safety_assurance_output','training_record','safety_communication','sms_documentation')),
 confidentiality text NOT NULL CHECK(confidentiality IN ('ordinary','safety_report','restricted_asset_information')),
 revision bigint NOT NULL CHECK(revision>0),
 projected_revision bigint NOT NULL DEFAULT 0 CHECK(projected_revision>=0 AND projected_revision<=revision),
 version_number integer NOT NULL CHECK(version_number>0),
 status text NOT NULL CHECK(status ~ '^[a-z_]{1,40}$'),
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
 owner_id text NOT NULL,due_at timestamptz CHECK(due_at IS NULL OR isfinite(due_at)),
 opened_by text NOT NULL,opened_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,
 latest_assessment_id text,latest_acceptance_id text,
 UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,id) REFERENCES subjects(tenant_id,id),
 FOREIGN KEY(tenant_id,owner_id) REFERENCES principals(tenant_id,id),
 FOREIGN KEY(tenant_id,opened_by) REFERENCES principals(tenant_id,id),
 FOREIGN KEY(tenant_id,id,latest_assessment_id) REFERENCES decisions(tenant_id,subject_id,id),
 FOREIGN KEY(tenant_id,id,latest_acceptance_id) REFERENCES decisions(tenant_id,subject_id,id)
);
CREATE INDEX sms_record_register ON sms_records(tenant_id,kind,updated_at DESC,id);

-- Bodies of safety-report and restricted records need their own restricted store before those kinds land.
CREATE TABLE sms_record_versions (
 id text PRIMARY KEY,tenant_id text NOT NULL,record_id text NOT NULL,
 version_number integer NOT NULL CHECK(version_number>0),revision bigint NOT NULL CHECK(revision>0),
 schema text NOT NULL CHECK(schema ~ '^sms\.[a-z-]+\.[0-9]+$'),
 record_class text NOT NULL,confidentiality text NOT NULL CHECK(confidentiality='ordinary'),
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
 body jsonb NOT NULL CHECK(jsonb_typeof(body)='object'),body_canonical text NOT NULL,
 body_digest text NOT NULL CHECK(body_digest ~ '^[a-f0-9]{64}$'),
 owner_id text NOT NULL,due_at timestamptz,links jsonb NOT NULL CHECK(jsonb_typeof(links)='array'),
 actor_id text NOT NULL,recorded_at timestamptz NOT NULL,
 CHECK(body_canonical::jsonb=body AND body_digest=encode(sha256(convert_to(body_canonical,'UTF8')),'hex')),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,record_id,version_number),UNIQUE(tenant_id,record_id,revision),
 FOREIGN KEY(tenant_id,id) REFERENCES journal_events(tenant_id,id),
 FOREIGN KEY(tenant_id,record_id) REFERENCES sms_records(tenant_id,id),
 FOREIGN KEY(tenant_id,owner_id) REFERENCES principals(tenant_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES principals(tenant_id,id)
);

CREATE TABLE sms_attachments (
 id text PRIMARY KEY,tenant_id text NOT NULL,record_id text NOT NULL,revision bigint NOT NULL CHECK(revision>1),
 label text NOT NULL CHECK(length(label) BETWEEN 1 AND 200),
 confidentiality text NOT NULL CHECK(confidentiality IN ('ordinary','safety_report','restricted_asset_information')),
 artifact_id text,restricted_artifact_id text,
 sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),byte_length integer NOT NULL CHECK(byte_length>0),
 content_type text NOT NULL,actor_id text NOT NULL,recorded_at timestamptz NOT NULL,
 CHECK((confidentiality='ordinary' AND artifact_id IS NOT NULL AND restricted_artifact_id IS NULL)
  OR (confidentiality<>'ordinary' AND artifact_id IS NULL AND restricted_artifact_id IS NOT NULL)),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,record_id,revision),
 FOREIGN KEY(tenant_id,id) REFERENCES journal_events(tenant_id,id),
 FOREIGN KEY(tenant_id,record_id) REFERENCES sms_records(tenant_id,id),
 FOREIGN KEY(tenant_id,artifact_id) REFERENCES artifacts(tenant_id,id),
 FOREIGN KEY(tenant_id,restricted_artifact_id,confidentiality) REFERENCES restricted_artifacts(tenant_id,id,confidentiality),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES principals(tenant_id,id)
);
CREATE INDEX sms_record_attachments ON sms_attachments(tenant_id,record_id,revision);

CREATE TABLE sms_signatures (
 id text PRIMARY KEY,tenant_id text NOT NULL,subject_id text NOT NULL,subject_revision bigint NOT NULL CHECK(subject_revision>0),
 decision_id text NOT NULL,signer_id text NOT NULL,meaning text NOT NULL,
 intent text NOT NULL CHECK(length(intent) BETWEEN 1 AND 2000),
 content jsonb NOT NULL CHECK(jsonb_typeof(content)='object'),content_canonical text NOT NULL,
 content_digest text NOT NULL CHECK(content_digest ~ '^[a-f0-9]{64}$'),
 authority jsonb NOT NULL CHECK(jsonb_typeof(authority)='object'),
 reauthentication jsonb NOT NULL CHECK(jsonb_typeof(reauthentication)='object'),
 signed_at timestamptz NOT NULL,
 CHECK(content_canonical::jsonb=content AND content_digest=encode(sha256(convert_to(content_canonical,'UTF8')),'hex')),
 CHECK(content->>'intent' IS NOT DISTINCT FROM intent AND content->>'meaning' IS NOT DISTINCT FROM meaning),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,decision_id),
 FOREIGN KEY(tenant_id,subject_id,decision_id) REFERENCES decisions(tenant_id,subject_id,id),
 FOREIGN KEY(tenant_id,subject_id) REFERENCES sms_records(tenant_id,id),
 FOREIGN KEY(tenant_id,signer_id) REFERENCES principals(tenant_id,id)
);
CREATE INDEX sms_record_signatures ON sms_signatures(tenant_id,subject_id,signed_at);

CREATE TABLE reauthentication_grants (
 id text PRIMARY KEY,tenant_id text NOT NULL,principal_id text NOT NULL,
 method text NOT NULL CHECK(method='local_fixture'),secret_sha256 text NOT NULL UNIQUE CHECK(secret_sha256 ~ '^[a-f0-9]{64}$'),
 issued_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,used_at timestamptz,
 CHECK(expires_at>issued_at AND expires_at<=issued_at+interval '10 minutes'),
 CHECK(used_at IS NULL OR (used_at>=issued_at AND used_at<=expires_at)),
 UNIQUE(tenant_id,id),FOREIGN KEY(tenant_id,principal_id) REFERENCES principals(tenant_id,id)
);
CREATE FUNCTION ledger_spend_reauthentication_once() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.used_at IS NOT NULL OR NEW.id<>OLD.id OR NEW.tenant_id<>OLD.tenant_id OR NEW.principal_id<>OLD.principal_id
  OR NEW.method<>OLD.method OR NEW.secret_sha256<>OLD.secret_sha256 OR NEW.issued_at<>OLD.issued_at OR NEW.expires_at<>OLD.expires_at THEN
  RAISE EXCEPTION 'a re-authentication grant is spent once';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER spend_reauthentication_once BEFORE UPDATE ON reauthentication_grants
 FOR EACH ROW EXECUTE FUNCTION ledger_spend_reauthentication_once();

CREATE TABLE sms_restricted_disclosures (
 id text PRIMARY KEY,tenant_id text NOT NULL,principal_id text NOT NULL,attachment_id text NOT NULL,
 capability text NOT NULL,disclosed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES principals(tenant_id,id),
 FOREIGN KEY(tenant_id,attachment_id) REFERENCES sms_attachments(tenant_id,id)
);

CREATE TABLE sms_exports (
 id text PRIMARY KEY,tenant_id text NOT NULL REFERENCES tenants(id),record_id text NOT NULL,
 format text NOT NULL CHECK(format='ledger.sms-export.1'),issued_by text NOT NULL,issued_at timestamptz NOT NULL,
 object_key text NOT NULL UNIQUE,bundle_sha256 text NOT NULL CHECK(bundle_sha256 ~ '^[a-f0-9]{64}$'),
 manifest_digest text NOT NULL CHECK(manifest_digest ~ '^[a-f0-9]{64}$'),
 byte_length integer NOT NULL CHECK(byte_length>0 AND byte_length<=33554432),metadata jsonb NOT NULL,
 UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,record_id) REFERENCES sms_records(tenant_id,id),
 FOREIGN KEY(tenant_id,issued_by) REFERENCES principals(tenant_id,id)
);
CREATE INDEX sms_record_exports ON sms_exports(tenant_id,record_id,issued_at DESC);

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['restricted_artifacts','sms_records','sms_record_versions','sms_attachments','sms_signatures',
  'reauthentication_grants','sms_restricted_disclosures','sms_exports'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_scope ON %I USING(tenant_id=current_setting(''ledger.tenant_id'',true)) WITH CHECK(tenant_id=current_setting(''ledger.tenant_id'',true))',t);
  EXECUTE format('GRANT SELECT,INSERT ON %I TO ledger_app',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['restricted_artifacts','sms_record_versions','sms_attachments','sms_signatures',
  'sms_restricted_disclosures','sms_exports'] LOOP
  EXECUTE format('CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION ledger_forbid_history_mutation()',t);
 END LOOP;
END $$;
CREATE TRIGGER retained_records BEFORE DELETE ON sms_records FOR EACH ROW EXECUTE FUNCTION ledger_forbid_history_mutation();
GRANT UPDATE(revision,version_number,status,title,owner_id,due_at,updated_at,latest_assessment_id,latest_acceptance_id)
 ON sms_records TO ledger_app;
GRANT UPDATE(projected_revision) ON sms_records TO ledger_worker;
GRANT UPDATE(used_at) ON reauthentication_grants TO ledger_app;
