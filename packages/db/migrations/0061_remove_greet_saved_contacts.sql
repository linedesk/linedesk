ALTER TABLE "assistants" ALTER COLUMN "greet_by_name" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "assistants" ALTER COLUMN "greeting_known_caller" SET DEFAULT '';--> statement-breakpoint
-- Greeting saved contacts by name is removed: off for every assistant, so an agent of the release before says no such greeting either.
UPDATE "assistants" SET "greet_by_name" = false, "greeting_known_caller" = '' WHERE "greet_by_name" OR "greeting_known_caller" <> '';
