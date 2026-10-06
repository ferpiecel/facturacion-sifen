-- Manual rollback for 0042.
DROP FUNCTION IF EXISTS public.mfa_consume_recovery_code(uuid, text);
DROP FUNCTION IF EXISTS public.mfa_advance_step(uuid, bigint);
DROP FUNCTION IF EXISTS public.mfa_find(uuid);
REVOKE SELECT (sealed, confirmed_at, last_used_step, recovery_hashes), UPDATE (last_used_step, recovery_hashes) ON "user_mfa" FROM session_resolver;
