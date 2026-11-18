ALTER TABLE "agent_setup_keys" ADD COLUMN "partner_id" text;--> statement-breakpoint
ALTER TABLE "partners" ADD COLUMN "setup_step" text;--> statement-breakpoint
ALTER TABLE "agent_setup_keys" ADD CONSTRAINT "agent_setup_keys_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE cascade ON UPDATE no action;