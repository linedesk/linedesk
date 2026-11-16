CREATE TABLE "integration_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"api_key_id" text NOT NULL,
	"source" text NOT NULL,
	"event" text NOT NULL,
	"target_url" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"disabled_reason" text,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"last_delivery_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ALTER COLUMN "endpoint_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "subscription_id" text;--> statement-breakpoint
ALTER TABLE "integration_subscriptions" ADD CONSTRAINT "integration_subscriptions_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "integration_subscriptions_ws" ON "integration_subscriptions" USING btree ("workspace_id");--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_subscription_id_integration_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."integration_subscriptions"("id") ON DELETE cascade ON UPDATE no action;