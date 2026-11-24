-- Manual rollback for 0084 (tables, RLS and grants).
DROP POLICY IF EXISTS "platform_admin_all" ON "reception_ekuatia_solve_usage";
DROP POLICY IF EXISTS "tenant_isolation" ON "reception_ekuatia_solve_usage";
REVOKE ALL ON "reception_ekuatia_solve_usage" FROM app_user, platform_admin;
REVOKE ALL ON "reception_ekuatia_global_usage" FROM app_user, platform_admin;
DROP TABLE "reception_ekuatia_solve_usage";
DROP TABLE "reception_ekuatia_global_usage";
