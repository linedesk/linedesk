CREATE TABLE "sign_in_counters" (
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"hour" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "sign_in_counters_user_id_kind_hour_pk" PRIMARY KEY("user_id","kind","hour")
);
--> statement-breakpoint
ALTER TABLE "sign_in_counters" ADD CONSTRAINT "sign_in_counters_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;