-- HU-E6-08: lotes_guard from 0036 plus one transition, sending -> pending, for a claim released
-- because the circuit breaker refused the call before anything was sent. It clears send_attempted_at,
-- the only time that write-once column may change; every other change to it still fails.
CREATE OR REPLACE FUNCTION "lotes_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  tenant_env public.tenant_environment;
BEGIN
  -- A tenant row hidden by RLS is left to the row-level security policy.
  SELECT t.environment INTO tenant_env FROM public.tenants t WHERE t.id = NEW.tenant_id;
  IF FOUND AND tenant_env IS DISTINCT FROM NEW.environment THEN
    RAISE EXCEPTION 'lotes: environment must match the tenant''s current environment';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
      OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
      OR NEW.environment IS DISTINCT FROM OLD.environment
      OR NEW.document_type IS DISTINCT FROM OLD.document_type
      OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'lotes: identity columns are immutable';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
      (OLD.status = 'pending' AND NEW.status = 'sending')
      -- HU-E6-08: nothing was sent (the breaker refused), so the claim is released with no attempt on record.
      OR (OLD.status = 'sending' AND NEW.status = 'pending' AND NEW.send_attempted_at IS NULL)
      OR (OLD.status = 'sending' AND NEW.status IN ('sent', 'rejected', 'unknown'))
      -- HU-E6-04 recovery of a lote whose answer was lost.
      OR (OLD.status = 'unknown' AND NEW.status IN ('sent', 'rejected'))
      -- HU-E6-03: the result query settled the lote or handed it to recovery; `processed` is terminal; `recovery` only ends in `processed`.
      OR (OLD.status = 'sent' AND NEW.status IN ('processed', 'recovery'))
      -- HU-E6-04: querying each CDC settled every document of a lote handed to recovery.
      OR (OLD.status = 'recovery' AND NEW.status = 'processed')
      -- HU-E6-04: an unanswered send whose documents were all found approved by CDC query.
      OR (OLD.status = 'unknown' AND NEW.status = 'processed')
    ) THEN
      RAISE EXCEPTION 'lotes: invalid status transition % -> %', OLD.status, NEW.status;
    END IF;
    -- The instant the 48 h recovery window counts from is set once, by the claim (HU-E6-04).
    IF OLD.send_attempted_at IS NOT NULL AND NEW.send_attempted_at IS DISTINCT FROM OLD.send_attempted_at
      AND NOT (OLD.status = 'sending' AND NEW.status = 'pending' AND NEW.send_attempted_at IS NULL) THEN
      RAISE EXCEPTION 'lotes: send_attempted_at is write-once';
    END IF;
    IF (OLD.sent_at IS NOT NULL AND NEW.sent_at IS DISTINCT FROM OLD.sent_at)
      OR (OLD.sifen_protocol IS NOT NULL AND NEW.sifen_protocol IS DISTINCT FROM OLD.sifen_protocol) THEN
      RAISE EXCEPTION 'lotes: sent_at and sifen_protocol are write-once';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
