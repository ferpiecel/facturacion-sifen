-- Manual rollback for 0071: drops the lift columns (a lifted pause becomes active again if its window is still open).
DROP TRIGGER IF EXISTS "ruc_blocks_lift_write_once" ON "ruc_blocks";
DROP FUNCTION IF EXISTS "ruc_blocks_lift_write_once"();
REVOKE UPDATE ("lifted_at", "lifted_by", "lift_reason") ON "ruc_blocks" FROM platform_admin;
ALTER TABLE "ruc_blocks" DROP CONSTRAINT IF EXISTS "ruc_blocks_lift_complete";
ALTER TABLE "ruc_blocks" DROP COLUMN IF EXISTS "lift_reason";
ALTER TABLE "ruc_blocks" DROP COLUMN IF EXISTS "lifted_by";
ALTER TABLE "ruc_blocks" DROP COLUMN IF EXISTS "lifted_at";
