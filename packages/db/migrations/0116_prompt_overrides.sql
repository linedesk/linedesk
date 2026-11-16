CREATE TABLE "prompt_overrides" (
	"key" text PRIMARY KEY NOT NULL,
	"text" text NOT NULL,
	"default_text" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text
);
