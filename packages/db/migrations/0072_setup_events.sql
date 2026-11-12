CREATE TABLE "setup_events" (
	"workspace_id" text NOT NULL,
	"event" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "setup_events_workspace_id_event_pk" PRIMARY KEY("workspace_id","event")
);
