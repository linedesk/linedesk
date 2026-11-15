ALTER TABLE "workspace_settings" ADD COLUMN "country_hint" text;--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD COLUMN "country_hint_source" text;--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD CONSTRAINT "workspace_settings_country_hint" CHECK ("workspace_settings"."country_hint" ~ '^[A-Z]{2}$');--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD CONSTRAINT "workspace_settings_country_hint_source" CHECK ("workspace_settings"."country_hint_source" in ('sign_up_location', 'time_zone', 'browser_language'));