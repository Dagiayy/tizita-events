-- 004_cost_allocation_setting.sql
-- Spec 17.2 "Storage cost per event (storage + processing + egress cost allocated to event)".
INSERT INTO system_settings (key, value, description) VALUES
 ('cost.storage_etb_per_gb_month', '0'::jsonb, 'Internal storage cost in ETB per GB-month, used by Admin -> Storage for per-event cost allocation. Set from the hosting contract.')
ON CONFLICT (key) DO NOTHING;
