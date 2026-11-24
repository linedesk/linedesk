ALTER TABLE "availability_exceptions" ADD COLUMN "source" text DEFAULT 'own' NOT NULL;--> statement-breakpoint
ALTER TABLE "availability_exceptions" ADD COLUMN "source_key" text;--> statement-breakpoint
ALTER TABLE "availability_exceptions" ADD COLUMN "yearly" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD COLUMN "holidays" jsonb;