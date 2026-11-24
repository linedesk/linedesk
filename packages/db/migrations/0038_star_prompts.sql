CREATE TABLE "star_prompts" (
	"user_id" text PRIMARY KEY NOT NULL,
	"answer" text NOT NULL,
	"answered_at" timestamp with time zone DEFAULT now() NOT NULL
);
