ALTER TABLE "app_connections" ADD COLUMN "channel" text;--> statement-breakpoint
ALTER TABLE "app_credentials" ADD COLUMN "webhook_url_encrypted" text;