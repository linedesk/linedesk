-- Bump `version` on every update of a synced table, whoever writes.
create or replace function bump_row_version() returns trigger as $$
begin
  new.version := nextval('row_version');
  return new;
end $$ language plpgsql;
--> statement-breakpoint
create trigger calls_version before update on calls for each row execute function bump_row_version();
--> statement-breakpoint
create trigger contacts_version before update on contacts for each row execute function bump_row_version();
--> statement-breakpoint
create trigger assistants_version before update on assistants for each row execute function bump_row_version();
--> statement-breakpoint
create trigger phone_numbers_version before update on phone_numbers for each row execute function bump_row_version();
--> statement-breakpoint
create trigger transcript_segments_version before update on transcript_segments for each row execute function bump_row_version();
