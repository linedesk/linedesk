DROP TABLE "custom_fields" CASCADE;--> statement-breakpoint
ALTER TABLE "calls" DROP COLUMN "caller_name";--> statement-breakpoint
ALTER TABLE "calls" DROP COLUMN "callback_number";--> statement-breakpoint
ALTER TABLE "calls" DROP COLUMN "address";--> statement-breakpoint
ALTER TABLE "calls" DROP COLUMN "job_type";--> statement-breakpoint
ALTER TABLE "calls" DROP COLUMN "tag";--> statement-breakpoint
ALTER TABLE "calls" DROP COLUMN "custom_values";