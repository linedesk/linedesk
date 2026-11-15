-- A person's UI language (LIN-261): their choice (null: Automatic, follow the browser) and what Automatic last
-- resolved to in their browser, for emails. Expand only: the previous release ignores both columns.
ALTER TABLE "user" ADD COLUMN "locale" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "locale_auto" text;