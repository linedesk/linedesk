ALTER TABLE "appointment_types" ADD COLUMN "buffer_before_min" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "appointment_types" ADD COLUMN "buffer_after_min" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "appointment_types" ADD COLUMN "book_when" text DEFAULT 'business_hours' NOT NULL;--> statement-breakpoint
ALTER TABLE "appointment_types" ADD CONSTRAINT "appointment_types_buffer_before" CHECK ("appointment_types"."buffer_before_min" >= 0);--> statement-breakpoint
ALTER TABLE "appointment_types" ADD CONSTRAINT "appointment_types_buffer_after" CHECK ("appointment_types"."buffer_after_min" >= 0);
--> statement-breakpoint
-- Types from before keep their buffer on both sides.
UPDATE "appointment_types" SET "buffer_before_min" = "buffer_min", "buffer_after_min" = "buffer_min" WHERE "buffer_min" > 0;
