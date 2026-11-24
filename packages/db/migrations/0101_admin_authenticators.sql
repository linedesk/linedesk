CREATE TABLE "admin_authenticators" (
	"user_id" text PRIMARY KEY NOT NULL,
	"secret" text NOT NULL,
	"confirmed_at" timestamp with time zone,
	"last_step" bigint,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "second_factor_method" text;--> statement-breakpoint
ALTER TABLE "admin_authenticators" ADD CONSTRAINT "admin_authenticators_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;