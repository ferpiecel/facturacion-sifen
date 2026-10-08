-- Manual rollback for 0045.
DROP FUNCTION IF EXISTS public.mfa_confirm(text, bigint, text[], jsonb);
DROP FUNCTION IF EXISTS public.mfa_save_pending(text, jsonb);
DROP FUNCTION IF EXISTS public.mfa_account(text);
REVOKE INSERT (user_id, sealed), UPDATE (sealed, confirmed_at) ON "user_mfa" FROM session_resolver;
