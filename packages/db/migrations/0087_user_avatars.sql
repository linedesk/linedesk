CREATE TABLE "user_avatars" (
	"user_id" text PRIMARY KEY NOT NULL,
	"png" text NOT NULL,
	"version" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_members" ADD COLUMN "avatar_version" text;--> statement-breakpoint
ALTER TABLE "user_avatars" ADD CONSTRAINT "user_avatars_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- workspace_members carries each member's profile picture version (user_avatars), whoever writes it.
create or replace function sync_workspace_member() returns trigger as $$
begin
  if tg_op = 'DELETE' then
    delete from workspace_members where id = old.id;
    return old;
  end if;
  insert into workspace_members (id, workspace_id, user_id, name, role, disabled, avatar_version)
  select new.id, new.organization_id, u.id, u.name, new.role, u.disabled_at is not null,
    (select a.version from user_avatars a where a.user_id = u.id)
  from "user" u where u.id = new.user_id
  on conflict (id) do update set workspace_id = excluded.workspace_id, user_id = excluded.user_id, name = excluded.name,
    role = excluded.role, disabled = excluded.disabled, avatar_version = excluded.avatar_version;
  return new;
end $$ language plpgsql;
--> statement-breakpoint
create or replace function sync_workspace_member_avatar() returns trigger as $$
begin
  if tg_op = 'DELETE' then
    update workspace_members set avatar_version = null where user_id = old.user_id;
    return old;
  end if;
  update workspace_members set avatar_version = new.version
  where user_id = new.user_id and avatar_version is distinct from new.version;
  return new;
end $$ language plpgsql;
--> statement-breakpoint
create trigger user_avatars_sync_workspace_members after insert or update or delete on user_avatars for each row
  execute function sync_workspace_member_avatar();
