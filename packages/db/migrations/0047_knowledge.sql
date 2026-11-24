CREATE TABLE "knowledge_chunks" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"document_id" text NOT NULL,
	"assistant_id" text NOT NULL,
	"position" integer NOT NULL,
	"text" text NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', text)) STORED NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"assistant_id" text NOT NULL,
	"name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"chars" integer NOT NULL,
	"store" text,
	"storage_key" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" bigint DEFAULT nextval('row_version') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_questions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"assistant_id" text NOT NULL,
	"call_id" text,
	"question" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" bigint DEFAULT nextval('row_version') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_document_id_knowledge_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."knowledge_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_assistant_id_assistants_id_fk" FOREIGN KEY ("assistant_id") REFERENCES "public"."assistants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_questions" ADD CONSTRAINT "knowledge_questions_assistant_id_assistants_id_fk" FOREIGN KEY ("assistant_id") REFERENCES "public"."assistants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_questions" ADD CONSTRAINT "knowledge_questions_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_chunks_assistant" ON "knowledge_chunks" USING btree ("assistant_id");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_search" ON "knowledge_chunks" USING gin ("search");--> statement-breakpoint
CREATE INDEX "knowledge_documents_ws" ON "knowledge_documents" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "knowledge_documents_assistant" ON "knowledge_documents" USING btree ("assistant_id");--> statement-breakpoint
CREATE INDEX "knowledge_questions_ws" ON "knowledge_questions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "knowledge_questions_assistant" ON "knowledge_questions" USING btree ("assistant_id","status");--> statement-breakpoint
create trigger knowledge_documents_version before update on knowledge_documents for each row execute function bump_row_version();--> statement-breakpoint
create trigger knowledge_questions_version before update on knowledge_questions for each row execute function bump_row_version();
