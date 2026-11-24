CREATE INDEX receipts_origination_evidence ON receipts(tenant_id,(input_subject->>'originationKey'));
CREATE INDEX receipts_alias_evidence ON receipts(tenant_id,source_id,(input_subject->>'externalFlightId'),occurred_at);
CREATE INDEX receipts_intent_origination_evidence ON receipts(tenant_id,(COALESCE(payload->'intent'->>'originationKey',payload->>'originationKey')))
 WHERE kind='intent.revision';
CREATE INDEX receipts_order_evidence ON receipts(tenant_id,source_id,(COALESCE(order_id,input_subject->>'orderId',payload->>'externalId')))
 WHERE kind='order.revision';
CREATE INDEX receipts_order_fulfillment_evidence ON receipts USING gin((payload->'fulfillments') jsonb_path_ops)
 WHERE kind='order.revision';
