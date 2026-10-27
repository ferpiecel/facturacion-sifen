-- Manual rollback for 0064: drops the synchronous transmission flag.
ALTER TABLE "tenant_fiscal_profiles" DROP COLUMN "sync_transmission";
