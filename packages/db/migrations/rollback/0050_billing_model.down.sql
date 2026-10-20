-- Manual rollback for 0050 (RLS and grants hand-written there; tables dropped in FK order).
DROP TABLE IF EXISTS "payments";
DROP TABLE IF EXISTS "plan_price_tiers";
DROP TABLE IF EXISTS "plan_prices";
DROP TABLE IF EXISTS "subscriptions";
DROP TABLE IF EXISTS "plans";
