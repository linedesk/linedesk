CREATE TABLE "provider_tests" (
	"provider" text PRIMARY KEY NOT NULL,
	"keys" text NOT NULL,
	"ok" boolean NOT NULL,
	"message" text NOT NULL,
	"tested_at" timestamp with time zone DEFAULT now() NOT NULL
);
