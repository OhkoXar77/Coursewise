-- Add an optional location to calendar events.
alter table public.coursewise_calendar_events
  add column if not exists location text;

alter table public.coursewise_calendar_events
  drop constraint if exists coursewise_calendar_events_location_length_check;

alter table public.coursewise_calendar_events
  add constraint coursewise_calendar_events_location_length_check
  check (location is null or char_length(location) <= 300);
