CREATE TABLE "number_purchases" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workspace_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"e164" text NOT NULL,
	"provider" text NOT NULL,
	"carrier_account" text NOT NULL,
	"by_admin" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX "number_purchases_ws" ON "number_purchases" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "number_purchases_created" ON "number_purchases" USING btree ("created_at");