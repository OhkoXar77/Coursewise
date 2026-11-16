-- Add a three-level priority to calendar events. Existing events default to Medium.
alter table public.coursewise_calendar_events
  add column if not exists priority integer not null default 2;

alter table public.coursewise_calendar_events
  drop constraint if exists coursewise_calendar_events_priority_check;

alter table public.coursewise_calendar_events
  add constraint coursewise_calendar_events_priority_check
  check (priority in (1, 2, 3));
