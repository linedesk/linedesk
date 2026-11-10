CREATE TABLE "appointment_types" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"duration_min" integer NOT NULL,
	"buffer_min" integer DEFAULT 0 NOT NULL,
	"min_notice_hours" integer DEFAULT 0 NOT NULL,
	"max_days_ahead" integer DEFAULT 60 NOT NULL,
	"location" text DEFAULT 'on_site' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" bigint DEFAULT nextval('row_version') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "availability_exceptions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"date" date NOT NULL,
	"start_time" time,
	"end_time" time,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" bigint DEFAULT nextval('row_version') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "availability_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"weekday" integer NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" bigint DEFAULT nextval('row_version') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"call_id" text,
	"contact_id" text,
	"appointment_type_id" text,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'confirmed' NOT NULL,
	"calendar_id" text,
	"external_event_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" bigint DEFAULT nextval('row_version') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"timezone" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" bigint DEFAULT nextval('row_version') NOT NULL,
	CONSTRAINT "workspace_settings_workspace_id_unique" UNIQUE("workspace_id")
);
--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_appointment_type_id_appointment_types_id_fk" FOREIGN KEY ("appointment_type_id") REFERENCES "public"."appointment_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appointment_types_ws" ON "appointment_types" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "availability_exceptions_ws_date" ON "availability_exceptions" USING btree ("workspace_id","date");--> statement-breakpoint
CREATE INDEX "availability_rules_ws" ON "availability_rules" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "bookings_ws_start" ON "bookings" USING btree ("workspace_id","start_at");--> statement-breakpoint
create trigger workspace_settings_version before update on workspace_settings for each row execute function bump_row_version();
--> statement-breakpoint
create trigger availability_rules_version before update on availability_rules for each row execute function bump_row_version();
--> statement-breakpoint
create trigger availability_exceptions_version before update on availability_exceptions for each row execute function bump_row_version();
--> statement-breakpoint
create trigger appointment_types_version before update on appointment_types for each row execute function bump_row_version();
--> statement-breakpoint
create trigger bookings_version before update on bookings for each row execute function bump_row_version();
