ALTER TABLE "documents" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
-- The instant SIFEN approved the document (HU-E8-02): the 48 h (FE) and 168 h (other types) cancellation
-- windows of MT v150 11.6.1 (4009, 4010) count from it. A separate guard keeps documents_guard (0034) untouched.
-- Rules: write-once; only on an approved or approved_with_observations document; stamped with now() when the
-- status moves into an approval and the writer gave no instant (the processing time SIFEN reported wins when
-- it is supplied). A row approved before this column keeps NULL until the lazy refresh stamps it.
CREATE FUNCTION "documents_approved_at_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.approved_at IS NOT NULL AND NEW.status NOT IN ('approved', 'approved_with_observations') THEN
      RAISE EXCEPTION 'documents: approved_at can only be set on an approved document';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.approved_at IS NOT NULL THEN
    IF NEW.approved_at IS DISTINCT FROM OLD.approved_at THEN
      RAISE EXCEPTION 'documents: approved_at is write-once';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status IN ('approved', 'approved_with_observations') THEN
    IF NEW.approved_at IS NULL AND OLD.status IS DISTINCT FROM NEW.status THEN
      NEW.approved_at := now();
    END IF;
  ELSIF NEW.approved_at IS NOT NULL THEN
    RAISE EXCEPTION 'documents: approved_at can only be set on an approved document';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "documents_approved_at_guard" BEFORE INSERT OR UPDATE ON "documents"
FOR EACH ROW EXECUTE FUNCTION "documents_approved_at_guard"();
