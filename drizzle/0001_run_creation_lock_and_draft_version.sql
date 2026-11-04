ALTER TABLE "runs" ADD COLUMN "creating_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "draft_version" integer DEFAULT 0 NOT NULL;