-- Add optional per-event reminder timing and an idempotency ledger per device.
alter table public.coursewise_calendar_events
  add column if not exists reminder text
  check (reminder is null or reminder in ('15m', '1h', '1d', '1w'));

create index if not exists coursewise_calendar_events_pending_reminders_idx
  on public.coursewise_calendar_events (auth_user_id, event_date)
  where reminder is not null;

create table if not exists public.coursewise_event_reminder_deliveries (
  id bigint generated always as identity primary key,
  event_id uuid not null references public.coursewise_calendar_events(id) on delete cascade,
  occurrence_date date not null,
  subscription_id uuid not null references public.coursewise_push_subscriptions(id) on delete cascade,
  sent_at timestamptz not null default now(),
  unique (event_id, occurrence_date, subscription_id)
);

alter table public.coursewise_event_reminder_deliveries enable row level security;
revoke all on public.coursewise_event_reminder_deliveries from anon, authenticated;

create index if not exists coursewise_event_reminder_deliveries_sent_idx
  on public.coursewise_event_reminder_deliveries (sent_at);
