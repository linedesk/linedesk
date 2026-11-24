CREATE TABLE "oauth_clients" (
	"client_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"redirect_uris" jsonb NOT NULL,
	"auth_method" text NOT NULL,
	"secret_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_codes" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"client_name" text NOT NULL,
	"user_id" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"resource" text,
	"personal_key_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "personal_keys" ADD COLUMN "oauth_client_id" text;--> statement-breakpoint
ALTER TABLE "oauth_codes" ADD CONSTRAINT "oauth_codes_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oauth_codes_expires" ON "oauth_codes" USING btree ("expires_at");