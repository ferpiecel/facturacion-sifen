CREATE TABLE "ruc_lookup_cache" (
	"environment" "tenant_environment" NOT NULL,
	"ruc" text NOT NULL,
	"found" boolean NOT NULL,
	"razon_social" text,
	"estado" text,
	"facturador_electronico" boolean,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ruc_lookup_cache_environment_ruc_pk" PRIMARY KEY("environment","ruc"),
	CONSTRAINT "ruc_lookup_cache_ruc_format" CHECK ("ruc_lookup_cache"."ruc" ~ '^[0-9]{5,8}$'),
	CONSTRAINT "ruc_lookup_cache_found_shape" CHECK (("ruc_lookup_cache"."found" AND "ruc_lookup_cache"."razon_social" IS NOT NULL AND "ruc_lookup_cache"."estado" IS NOT NULL AND "ruc_lookup_cache"."facturador_electronico" IS NOT NULL) OR (NOT "ruc_lookup_cache"."found" AND "ruc_lookup_cache"."razon_social" IS NULL AND "ruc_lookup_cache"."estado" IS NULL AND "ruc_lookup_cache"."facturador_electronico" IS NULL))
);

--> statement-breakpoint
-- Global registry data, no tenant_id and no RLS: the API role reads and refreshes entries.
GRANT SELECT, INSERT, UPDATE ON "ruc_lookup_cache" TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "ruc_lookup_cache" TO platform_admin;
