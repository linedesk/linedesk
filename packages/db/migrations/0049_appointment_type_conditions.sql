ALTER TABLE "appointment_types" ADD COLUMN "name_required" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "appointment_types" ADD COLUMN "instruction" text DEFAULT '' NOT NULL;