ALTER TABLE "commands" ADD COLUMN "pruned_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "commands_unpruned_created" ON "commands" USING btree ("created_at") WHERE "commands"."pruned_at" is null;--> statement-breakpoint
CREATE INDEX "commands_unpruned_input" ON "commands" USING gin ("input" jsonb_path_ops) WHERE "commands"."pruned_at" is null;--> statement-breakpoint
CREATE INDEX "commands_unpruned_result" ON "commands" USING gin ("result" jsonb_path_ops) WHERE "commands"."pruned_at" is null;