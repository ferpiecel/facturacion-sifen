-- Monotonic lote order (hardening E6, ADR-0007/0008): ordering and ownership between lotes stop reading the
-- database clock. `lotes.seq` is an identity sequence; `documents.resent_after_seq` is the watermark of a resend.
ALTER TABLE "documents" ADD COLUMN "resent_after_seq" bigint;--> statement-breakpoint
ALTER TABLE "lotes" ADD COLUMN "seq" bigint;--> statement-breakpoint
-- Backfill as the owner: FORCE RLS would hide every row and the user triggers guard both tables, so both are
-- lifted for this transaction only and restored.
ALTER TABLE "lotes" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "documents" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "lotes" DISABLE TRIGGER USER;--> statement-breakpoint
ALTER TABLE "documents" DISABLE TRIGGER USER;--> statement-breakpoint
UPDATE "lotes" l SET "seq" = o.n
FROM (SELECT id, row_number() OVER (ORDER BY created_at, id) AS n FROM "lotes") o
WHERE l.id = o.id;--> statement-breakpoint
-- A resent document was left behind by every lote created before the stamp: the watermark is the newest of them.
UPDATE "documents" d SET "resent_after_seq" = COALESCE(
  (SELECT max(l.seq) FROM "lotes" l WHERE l.tenant_id = d.tenant_id AND l.created_at < d.resent_at), 0)
WHERE d.resent_at IS NOT NULL;--> statement-breakpoint
ALTER TABLE "lotes" ENABLE TRIGGER USER;--> statement-breakpoint
ALTER TABLE "documents" ENABLE TRIGGER USER;--> statement-breakpoint
ALTER TABLE "lotes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "documents" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "lotes" ALTER COLUMN "seq" SET NOT NULL;--> statement-breakpoint
DO $$
BEGIN
  EXECUTE format(
    'ALTER TABLE public.lotes ALTER COLUMN seq ADD GENERATED ALWAYS AS IDENTITY (SEQUENCE NAME public.lotes_seq_seq START WITH %s)',
    (SELECT COALESCE(max(seq), 0) + 1 FROM public.lotes));
END
$$;--> statement-breakpoint
ALTER TABLE "lotes" ADD CONSTRAINT "lotes_seq_key" UNIQUE("seq");--> statement-breakpoint
-- The watermark is stamped with the resend and never moves: the highest seq among the lotes carrying the
-- document right now (the one the recovery leaves is the newest). Runs next to documents_guard, which
-- already restricts when resent_at may be set.
CREATE FUNCTION "documents_resent_seq"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.resent_at IS NULL AND NEW.resent_at IS NOT NULL THEN
    NEW.resent_after_seq := COALESCE((
      SELECT max(l.seq)
      FROM public.lote_documents ld
      JOIN public.lotes l ON l.tenant_id = ld.tenant_id AND l.id = ld.lote_id
      WHERE ld.tenant_id = NEW.tenant_id AND ld.document_id = NEW.id), 0);
  ELSE
    NEW.resent_after_seq := OLD.resent_after_seq;
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "documents_resent_seq" BEFORE UPDATE ON "documents"
FOR EACH ROW EXECUTE FUNCTION "documents_resent_seq"();
