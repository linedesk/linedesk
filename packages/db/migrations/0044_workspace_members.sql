CREATE TABLE "call_events" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"call_id" text NOT NULL,
	"kind" text NOT NULL,
	"actor_id" text,
	"assignee_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" bigint DEFAULT nextval('row_version') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_members" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"version" bigint DEFAULT nextval('row_version') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "member_notification_settings" ADD COLUMN "assigned_email" boolean;--> statement-breakpoint
ALTER TABLE "call_events" ADD CONSTRAINT "call_events_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "call_events_call" ON "call_events" USING btree ("call_id","created_at");--> statement-breakpoint
CREATE INDEX "workspace_members_ws" ON "workspace_members" USING btree ("workspace_id");--> statement-breakpoint
create trigger workspace_members_version before update on workspace_members for each row execute function bump_row_version();
--> statement-breakpoint
create trigger call_events_version before update on call_events for each row execute function bump_row_version();
--> statement-breakpoint
-- workspace_members mirrors Better Auth's member and user rows (safe fields only), whoever writes them.
create or replace function sync_workspace_member() returns trigger as $$
begin
  if tg_op = 'DELETE' then
    delete from workspace_members where id = old.id;
    return old;
  end if;
  insert into workspace_members (id, workspace_id, user_id, name, role, disabled)
  select new.id, new.organization_id, u.id, u.name, new.role, u.disabled_at is not null
  from "user" u where u.id = new.user_id
  on conflict (id) do update set workspace_id = excluded.workspace_id, user_id = excluded.user_id, name = excluded.name,
    role = excluded.role, disabled = excluded.disabled;
  return new;
end $$ language plpgsql;
--> statement-breakpoint
create trigger member_sync_workspace_members after insert or update or delete on member for each row execute function sync_workspace_member();
--> statement-breakpoint
create or replace function sync_workspace_member_user() returns trigger as $$
begin
  update workspace_members set name = new.name, disabled = new.disabled_at is not null
  where user_id = new.id;
  return new;
end $$ language plpgsql;
--> statement-breakpoint
create trigger user_sync_workspace_members after update of name, disabled_at on "user" for each row
  when (old.name is distinct from new.name or (old.disabled_at is null) <> (new.disabled_at is null))
  execute function sync_workspace_member_user();
--> statement-breakpoint
insert into workspace_members (id, workspace_id, user_id, name, role, disabled)
select m.id, m.organization_id, u.id, u.name, m.role, u.disabled_at is not null
from member m join "user" u on u.id = m.user_id
on conflict (id) do nothing;
