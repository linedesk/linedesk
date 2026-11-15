ALTER TABLE "workspace_settings" ALTER COLUMN "recording_notice_on" SET DEFAULT true;--> statement-breakpoint
-- Before go-live (no real customers yet): every existing workspace says the notice too.
UPDATE "workspace_settings" SET "recording_notice_on" = true;
