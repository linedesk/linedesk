CREATE TABLE "business_lookup_usage" (
	"day" date NOT NULL,
	"workspace_id" text NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "business_lookup_usage_day_workspace_id_pk" PRIMARY KEY("day","workspace_id")
);
--> statement-breakpoint
CREATE TABLE "forwarding_checks" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"phone_number_id" text NOT NULL,
	"business_number" text NOT NULL,
	"linedesk_number" text NOT NULL,
	"caller_number" text,
	"simulated" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'dialing' NOT NULL,
	"detail" text,
	"created_by" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dialed_at" timestamp with time zone,
	"arrived_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "golive_checklist_dismissals" (
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"dismissed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "golive_checklist_dismissals_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "golive_checklist_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"step" text NOT NULL,
	"state" text NOT NULL,
	"user_id" text,
	"until" timestamp with time zone,
	"by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "line_lookups" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"number" text NOT NULL,
	"looked_up_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "setup_emails" (
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "setup_emails_workspace_id_kind_pk" PRIMARY KEY("workspace_id","kind")
);
--> statement-breakpoint
ALTER TABLE "member_notification_settings" ADD COLUMN "setup_emails" boolean;--> statement-breakpoint
CREATE INDEX "forwarding_checks_ws" ON "forwarding_checks" USING btree ("workspace_id","started_at");--> statement-breakpoint
CREATE INDEX "forwarding_checks_arrival" ON "forwarding_checks" USING btree ("caller_number","dialed_at");--> statement-breakpoint
CREATE INDEX "forwarding_checks_business" ON "forwarding_checks" USING btree ("business_number","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "golive_checklist_steps_workspace" ON "golive_checklist_steps" USING btree ("workspace_id","step") WHERE "golive_checklist_steps"."user_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "golive_checklist_steps_person" ON "golive_checklist_steps" USING btree ("workspace_id","user_id","step","state") WHERE "golive_checklist_steps"."user_id" is not null;--> statement-breakpoint
CREATE INDEX "line_lookups_ws" ON "line_lookups" USING btree ("workspace_id","looked_up_at");--> statement-breakpoint
CREATE INDEX "line_lookups_at" ON "line_lookups" USING btree ("looked_up_at");--> statement-breakpoint
CREATE INDEX "setup_events_signup_at" ON "setup_events" USING btree ("at") WHERE event = 'signup';