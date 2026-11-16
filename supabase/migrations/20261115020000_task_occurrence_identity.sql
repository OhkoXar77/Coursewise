-- Stable identity for individually materialized recurring task occurrences.
create table if not exists public.coursewise_task_occurrences (
  user_id text not null,
  series_id text not null,
  occurrence_date date not null,
  task_id text,
  skipped boolean not null default false,
  is_generated boolean not null default false,
  primary key (user_id, series_id, occurrence_date),
  unique (user_id, task_id)
);

alter table public.coursewise_task_occurrences enable row level security;
revoke all on public.coursewise_task_occurrences from public, anon, authenticated;

create policy "Users read their own task occurrence identities"
  on public.coursewise_task_occurrences
  for select
  using (
    exists (
      select 1
      from public."User" u
      where u."UserID"::text = coursewise_task_occurrences.user_id
        and u."AuthUserID" = auth.uid()
    )
  );
grant select on public.coursewise_task_occurrences to authenticated;

create or replace function public.coursewise_claim_task_occurrence(
  p_series_id text,
  p_occurrence_date date,
  p_task_id text,
  p_generated boolean
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id text;
  v_task_id text;
  v_skipped boolean;
begin
  select u."UserID"::text into v_user_id
  from public."User" u
  where u."AuthUserID" = auth.uid();

  if v_user_id is null then
    raise exception 'Sign in to save this task occurrence.';
  end if;
  if nullif(p_series_id, '') is null or p_occurrence_date is null or nullif(p_task_id, '') is null then
    raise exception 'A series, occurrence date, and task are required.';
  end if;
  if not exists (
    select 1
    from public."Tasks" t
    where t."TaskID"::text = p_task_id
      and t."UserID"::text = v_user_id
  ) then
    raise exception 'The task occurrence could not be found.';
  end if;

  insert into public.coursewise_task_occurrences
    (user_id, series_id, occurrence_date, task_id, skipped, is_generated)
  values
    (v_user_id, p_series_id, p_occurrence_date, p_task_id, false, coalesce(p_generated, false))
  on conflict (user_id, series_id, occurrence_date) do nothing;

  select occurrence.task_id, occurrence.skipped
  into v_task_id, v_skipped
  from public.coursewise_task_occurrences occurrence
  where occurrence.user_id = v_user_id
    and occurrence.series_id = p_series_id
    and occurrence.occurrence_date = p_occurrence_date
  for update;

  if v_skipped then
    return null;
  end if;

  if v_task_id is null or not exists (
    select 1
    from public."Tasks" t
    where t."TaskID"::text = v_task_id
      and t."UserID"::text = v_user_id
  ) then
    update public.coursewise_task_occurrences
    set task_id = p_task_id, skipped = false, is_generated = coalesce(p_generated, false)
    where user_id = v_user_id
      and series_id = p_series_id
      and occurrence_date = p_occurrence_date;
    return p_task_id;
  end if;

  return v_task_id;
end;
$$;

create or replace function public.coursewise_skip_task_occurrence(
  p_series_id text,
  p_occurrence_date date
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id text;
begin
  select u."UserID"::text into v_user_id
  from public."User" u
  where u."AuthUserID" = auth.uid();

  if v_user_id is null then
    raise exception 'Sign in to delete this task occurrence.';
  end if;
  if nullif(p_series_id, '') is null or p_occurrence_date is null then
    raise exception 'A series and occurrence date are required.';
  end if;

  insert into public.coursewise_task_occurrences
    (user_id, series_id, occurrence_date, task_id, skipped)
  values
    (v_user_id, p_series_id, p_occurrence_date, null, true)
  on conflict (user_id, series_id, occurrence_date)
  do update set task_id = null, skipped = true;
end;
$$;

revoke all on function public.coursewise_claim_task_occurrence(text, date, text, boolean) from public, anon;
revoke all on function public.coursewise_skip_task_occurrence(text, date) from public, anon;
grant execute on function public.coursewise_claim_task_occurrence(text, date, text, boolean) to authenticated;
grant execute on function public.coursewise_skip_task_occurrence(text, date) to authenticated;
