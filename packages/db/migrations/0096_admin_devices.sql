CREATE TABLE "admin_devices" (
	"user_id" text NOT NULL,
	"device_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_devices_user_id_device_hash_pk" PRIMARY KEY("user_id","device_hash")
);
--> statement-breakpoint
ALTER TABLE "admin_devices" ADD CONSTRAINT "admin_devices_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;