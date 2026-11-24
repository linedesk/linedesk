CREATE INDEX "commands_action_created" ON "commands" USING btree ("action","created_at");--> statement-breakpoint
CREATE INDEX "commands_impersonated_created" ON "commands" USING btree ("created_at") WHERE "commands"."impersonated_by" is not null;--> statement-breakpoint
CREATE INDEX "commands_setup_key_created" ON "commands" USING btree ("created_at") WHERE "commands"."setup_key_id" is not null;