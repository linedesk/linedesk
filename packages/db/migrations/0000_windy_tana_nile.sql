CREATE SEQUENCE "public"."row_version" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "assistants" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text DEFAULT 'Maya' NOT NULL,
	"greeting" text DEFAULT '' NOT NULL,
	"disclose_ai" boolean DEFAULT true NOT NULL,
	"voice" jsonb DEFAULT '{"provider":"cartesia","voice_id":""}'::jsonb NOT NULL,
	"business_profile" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" bigint DEFAULT nextval('row_version') NOT NULL,
	CONSTRAINT "assistants_workspace_id_unique" UNIQUE("workspace_id")
);
--> statement-breakpoint
CREATE TABLE "calls" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"contact_id" text,
	"from_number" text NOT NULL,
	"to_number" text NOT NULL,
	"direction" text DEFAULT 'in' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"duration_sec" integer,
	"status" text DEFAULT 'live' NOT NULL,
	"outcome" text,
	"urgency" text DEFAULT 'normal' NOT NULL,
	"title" text,
	"summary" text,
	"action_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"answered_by" text DEFAULT 'ai' NOT NULL,
	"recording_key" text,
	"room" text,
	"inbox_state" text DEFAULT 'open' NOT NULL,
	"reminder_at" timestamp with time zone,
	"reminder_label" text,
	"unread" boolean DEFAULT true NOT NULL,
	"assignee_id" text,
	"deleted_at" timestamp with time zone,
	"version" bigint DEFAULT nextval('row_version') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commands" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"input" jsonb NOT NULL,
	"result" jsonb NOT NULL,
	"rejected" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text,
	"company" text,
	"phone" text NOT NULL,
	"email" text,
	"address" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" bigint DEFAULT nextval('row_version') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "phone_numbers" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"e164" text NOT NULL,
	"provider" text NOT NULL,
	"mode" text DEFAULT 'forward_conditional' NOT NULL,
	"forwarded_from" text,
	"provider_ref" text,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" bigint DEFAULT nextval('row_version') NOT NULL,
	CONSTRAINT "phone_numbers_e164_unique" UNIQUE("e164")
);
--> statement-breakpoint
CREATE TABLE "transcript_segments" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"call_id" text NOT NULL,
	"speaker" text NOT NULL,
	"text" text NOT NULL,
	"at_ms" integer NOT NULL,
	"tool_event" jsonb,
	"version" bigint DEFAULT nextval('row_version') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitation" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"inviter_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo" text,
	"created_at" timestamp NOT NULL,
	"metadata" text,
	CONSTRAINT "organization_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"active_organization_id" text,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_segments" ADD CONSTRAINT "transcript_segments_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_inviter_id_user_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "calls_ws_started" ON "calls" USING btree ("workspace_id","started_at");--> statement-breakpoint
CREATE INDEX "contacts_ws_phone" ON "contacts" USING btree ("workspace_id","phone");--> statement-breakpoint
CREATE INDEX "phone_numbers_ws" ON "phone_numbers" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "segments_call" ON "transcript_segments" USING btree ("call_id","at_ms");--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "invitation_organizationId_idx" ON "invitation" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "invitation_email_idx" ON "invitation" USING btree ("email");--> statement-breakpoint
CREATE INDEX "member_organizationId_idx" ON "member" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "member_userId_idx" ON "member" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_slug_uidx" ON "organization" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");