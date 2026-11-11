-- Manual rollback for 0053: drops the table with its policies and index. The pause history it holds is lost.
DROP TABLE IF EXISTS "ruc_blocks";
