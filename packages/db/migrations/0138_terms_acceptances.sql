CREATE TABLE "terms_acceptances" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"billing_account_id" text,
	"source" text NOT NULL,
	"terms_url" text NOT NULL,
	"terms_version" text NOT NULL,
	"privacy_url" text NOT NULL,
	"privacy_version" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "terms_acceptances_source" CHECK ("terms_acceptances"."source" in ('signup'))
);
--> statement-breakpoint
CREATE INDEX "terms_acceptances_user" ON "terms_acceptances" USING btree ("user_id","accepted_at");--> statement-breakpoint
CREATE INDEX "terms_acceptances_bill" ON "terms_acceptances" USING btree ("billing_account_id");