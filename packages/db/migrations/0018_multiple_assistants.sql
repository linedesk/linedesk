ALTER TABLE "assistants" DROP CONSTRAINT "assistants_workspace_id_unique";--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "assistant_id" text;--> statement-breakpoint
ALTER TABLE "phone_numbers" ADD COLUMN "assistant_id" text;--> statement-breakpoint
CREATE INDEX "assistants_ws" ON "assistants" USING btree ("workspace_id");--> statement-breakpoint
-- Until now a workspace had one assistant: every existing number and call is that one's.
UPDATE "phone_numbers" SET "assistant_id" = (SELECT "id" FROM "assistants" WHERE "assistants"."workspace_id" = "phone_numbers"."workspace_id" ORDER BY "created_at" LIMIT 1) WHERE "assistant_id" IS NULL;--> statement-breakpoint
UPDATE "calls" SET "assistant_id" = (SELECT "id" FROM "assistants" WHERE "assistants"."workspace_id" = "calls"."workspace_id" ORDER BY "created_at" LIMIT 1) WHERE "assistant_id" IS NULL;
