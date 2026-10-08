-- Manual rollback for 0044.
DROP POLICY IF EXISTS "partner_read" ON "documents";
DROP POLICY IF EXISTS "partner_read" ON "tenant_certificates";
DROP POLICY IF EXISTS "partner_read" ON "tenants";
REVOKE ALL ON "documents", "tenant_certificates", "tenants" FROM partner_viewer;
REVOKE partner_viewer FROM app_login;
DROP ROLE IF EXISTS partner_viewer;
DROP FUNCTION IF EXISTS public.user_in_partner(uuid, uuid);
DROP TABLE IF EXISTS "partner_memberships";
