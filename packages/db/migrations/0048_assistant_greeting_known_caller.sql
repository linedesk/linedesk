ALTER TABLE "assistants" ADD COLUMN "greeting_known_caller" text DEFAULT 'Hi {first_name}, good to hear from you again.' NOT NULL;--> statement-breakpoint
-- An assistant that had greeting by name turned off keeps it off.
UPDATE "assistants" SET "greeting_known_caller" = '' WHERE "greet_by_name" = false;
