ALTER TABLE "appointment_types" ADD COLUMN "required_fields" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "caller_email" text;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "confirmation" text;