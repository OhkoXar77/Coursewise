-- Run once in the Supabase SQL Editor to allow events to continue overnight.
alter table public.coursewise_calendar_events
  drop constraint if exists coursewise_calendar_events_time_range;
