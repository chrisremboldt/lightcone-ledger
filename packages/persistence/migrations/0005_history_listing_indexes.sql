-- Add read indexes without changing or rewriting immutable operational history.
-- Each bounded keyset query keeps tenant scope first and a deterministic ID tie-break.
CREATE INDEX IF NOT EXISTS decisions_history_listing ON decisions(tenant_id,flight_id,recorded_at,id);
CREATE INDEX IF NOT EXISTS receipts_link_history_listing ON receipts(tenant_id,link_status,received_at,id);
CREATE INDEX IF NOT EXISTS receipts_flight_history_listing ON receipts(tenant_id,flight_id,received_at,id);
CREATE INDEX IF NOT EXISTS receipts_source_history_listing ON receipts(tenant_id,source_id,received_at,id);
CREATE INDEX IF NOT EXISTS orders_history_listing ON operational_orders(tenant_id,id);
