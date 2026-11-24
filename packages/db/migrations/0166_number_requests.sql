CREATE TABLE "number_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"country" text NOT NULL,
	"number_type" text DEFAULT 'local' NOT NULL,
	"prefix" text NOT NULL,
	"city" text NOT NULL,
	"assistant_id" text,
	"status" text NOT NULL,
	"reason" text,
	"provider" text NOT NULL,
	"carrier_account" text NOT NULL,
	"e164" text,
	"requirement_group_ref" text,
	"order_ref" text,
	"phone_number_id" text,
	"requested_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"checked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "regulatory_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	"content_encrypted" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text
);
--> statement-breakpoint
CREATE TABLE "regulatory_profiles" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"legal_name" text NOT NULL,
	"entity_type" text NOT NULL,
	"registration_number" text,
	"website" text,
	"use_case" text,
	"address" jsonb NOT NULL,
	"contact" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
CREATE INDEX "number_requests_ws" ON "number_requests" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "number_requests_order" ON "number_requests" USING btree ("order_ref");--> statement-breakpoint
CREATE INDEX "number_requests_group" ON "number_requests" USING btree ("requirement_group_ref");--> statement-breakpoint
CREATE INDEX "regulatory_documents_ws" ON "regulatory_documents" USING btree ("workspace_id","kind");