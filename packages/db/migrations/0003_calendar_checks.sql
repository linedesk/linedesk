ALTER TABLE "workspace_settings" DROP CONSTRAINT "workspace_settings_workspace_id_unique";--> statement-breakpoint
ALTER TABLE "workspace_settings" DROP COLUMN "id";--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD PRIMARY KEY ("workspace_id");--> statement-breakpoint
ALTER TABLE "appointment_types" ADD CONSTRAINT "appointment_types_duration" CHECK ("appointment_types"."duration_min" > 0);--> statement-breakpoint
ALTER TABLE "appointment_types" ADD CONSTRAINT "appointment_types_buffer" CHECK ("appointment_types"."buffer_min" >= 0);--> statement-breakpoint
ALTER TABLE "appointment_types" ADD CONSTRAINT "appointment_types_min_notice" CHECK ("appointment_types"."min_notice_hours" >= 0);--> statement-breakpoint
ALTER TABLE "appointment_types" ADD CONSTRAINT "appointment_types_max_days" CHECK ("appointment_types"."max_days_ahead" > 0);--> statement-breakpoint
ALTER TABLE "availability_exceptions" ADD CONSTRAINT "availability_exceptions_times" CHECK (("availability_exceptions"."start_time" is null and "availability_exceptions"."end_time" is null) or coalesce("availability_exceptions"."end_time" > "availability_exceptions"."start_time", false));--> statement-breakpoint
ALTER TABLE "availability_rules" ADD CONSTRAINT "availability_rules_weekday" CHECK ("availability_rules"."weekday" between 0 and 6);--> statement-breakpoint
ALTER TABLE "availability_rules" ADD CONSTRAINT "availability_rules_times" CHECK ("availability_rules"."end_time" > "availability_rules"."start_time");--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_times" CHECK ("bookings"."end_at" > "bookings"."start_at");