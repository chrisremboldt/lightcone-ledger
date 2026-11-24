CREATE INDEX claims_flight_picture ON claims(tenant_id,flight_id,kind,occurred_at DESC,id DESC);
CREATE INDEX claims_replacement ON claims(tenant_id,correction_of) WHERE correction_of IS NOT NULL;
CREATE INDEX receipts_unresolved_origination ON receipts(tenant_id,(input_subject->>'originationKey'),received_at)
 WHERE link_status IN ('unresolved','candidate');
CREATE INDEX receipts_unresolved_external ON receipts(tenant_id,source_id,(input_subject->>'externalFlightId'),received_at)
 WHERE link_status IN ('unresolved','candidate');
CREATE INDEX aliases_subject_lookup ON aliases(tenant_id,subject_id,source_id,external_id);
