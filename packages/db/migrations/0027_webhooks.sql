CREATE TABLE "webhook_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"endpoint_id" text NOT NULL,
	"event" text NOT NULL,
	"payload" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"response_status" integer,
	"error" text,
	"last_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoints" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"url" text NOT NULL,
	"events" jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"disabled_reason" text,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"last_delivery_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" bigint DEFAULT nextval('row_version') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_secrets" (
	"endpoint_id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"secret_encrypted" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_id_webhook_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."webhook_endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_secrets" ADD CONSTRAINT "webhook_secrets_endpoint_id_webhook_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."webhook_endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webhook_deliveries_endpoint" ON "webhook_deliveries" USING btree ("endpoint_id","created_at");--> statement-breakpoint
CREATE INDEX "webhook_endpoints_ws" ON "webhook_endpoints" USING btree ("workspace_id");--> statement-breakpoint
create trigger webhook_endpoints_version before update on webhook_endpoints for each row execute function bump_row_version();