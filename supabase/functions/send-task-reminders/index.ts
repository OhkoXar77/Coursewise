import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const jsonHeaders = { "Content-Type": "application/json" };
const minute = 60_000;
const reminderOffsets: Record<string, number> = {
  "15m": 15 * minute,
  "1h": 60 * minute,
  "1d": 24 * 60 * minute,
  "1w": 7 * 24 * 60 * minute
};

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

function zonedLocalTimeToUtc(dateKey: string, time: string, timezone: string) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const [hour, minutePart] = time.split(":").map(Number);
  const desired = Date.UTC(year, month - 1, day, hour, minutePart, 0, 0);
  let guess = desired;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  });
  for (let i = 0; i < 3; i++) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(guess)).map(part => [part.type, part.value]));
    const represented = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
    guess += desired - represented;
  }
  return new Date(guess);
}

function dueInstant(task: Record<string, unknown>, timezone: string) {
  if (typeof task.TaskDueDate !== "string") return null;
  if (task.HasDueTime) {
    const parsed = new Date(task.TaskDueDate);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }
  const dateKey = task.TaskDueDate.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return null;
  try {
    return zonedLocalTimeToUtc(dateKey, "09:00", timezone || "UTC");
  } catch {
    return zonedLocalTimeToUtc(dateKey, "09:00", "UTC");
  }
}

function reminderInstant(dueAt: Date, reminder: string, timezone: string) {
  const offset = reminderOffsets[reminder];
  if (!offset) return null;
  if (reminder === "15m" || reminder === "1h") return new Date(dueAt.getTime() - offset);
  try {
    const local = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone || "UTC", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    }).formatToParts(dueAt).map(part => [part.type, part.value]));
    const days = reminder === "1w" ? 7 : 1;
    const prior = new Date(Date.UTC(Number(local.year), Number(local.month) - 1, Number(local.day) - days));
    const dateKey = `${prior.getUTCFullYear()}-${String(prior.getUTCMonth() + 1).padStart(2, "0")}-${String(prior.getUTCDate()).padStart(2, "0")}`;
    return zonedLocalTimeToUtc(dateKey, `${local.hour}:${local.minute}`, timezone || "UTC");
  } catch {
    return new Date(dueAt.getTime() - offset);
  }
}

type EventRepeatRule = {
  unit?: string;
  interval?: number;
  days?: number[];
  end?: { type?: string; date?: string; count?: number };
  skipDates?: string[];
};

const presetEventRules: Record<string, EventRepeatRule> = {
  daily: { unit: "day", interval: 1 },
  weekdays: { unit: "week", interval: 1, days: [1, 2, 3, 4, 5] },
  weekly: { unit: "week", interval: 1 },
  monthly: { unit: "month", interval: 1 }
};

function shiftDateKey(dateKey: string, days: number) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function dateNumber(dateKey: string) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return Date.UTC(year, month - 1, day) / 86_400_000;
}

function localDateKey(date: Date, timezone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function stepEventDate(dateKey: string, rule: EventRepeatRule, anchorDay: number) {
  const interval = Math.max(1, Math.min(99, Number(rule.interval) || 1));
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (rule.unit === "day") return shiftDateKey(dateKey, interval);
  if (rule.unit === "week") {
    const days = rule.days?.length ? rule.days : [date.getUTCDay()];
    const baseSunday = dateNumber(shiftDateKey(dateKey, -date.getUTCDay()));
    for (let offset = 1; offset <= 7 * interval + 7; offset++) {
      const candidate = shiftDateKey(dateKey, offset);
      const candidateDay = new Date(dateNumber(candidate) * 86_400_000).getUTCDay();
      const candidateSunday = dateNumber(shiftDateKey(candidate, -candidateDay));
      if (days.includes(candidateDay) && (candidateSunday - baseSunday) / 7 % interval === 0) return candidate;
    }
    return shiftDateKey(dateKey, 7 * interval);
  }
  const months = rule.unit === "year" ? 12 * interval : interval;
  const targetMonth = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(targetMonth.getUTCFullYear(), targetMonth.getUTCMonth() + 1, 0)).getUTCDate();
  return `${targetMonth.getUTCFullYear()}-${String(targetMonth.getUTCMonth() + 1).padStart(2, "0")}-${String(Math.min(anchorDay, lastDay)).padStart(2, "0")}`;
}

function eventOccurrenceDates(event: Record<string, unknown>, timezone: string, now: Date) {
  const eventDate = String(event.event_date || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) return [];
  let fromDate: string, toDate: string;
  try {
    fromDate = localDateKey(now, timezone || "UTC");
  } catch {
    fromDate = localDateKey(now, "UTC");
  }
  toDate = shiftDateKey(fromDate, 8);
  const rawRule = typeof event.repeat_rule === "string"
    ? presetEventRules[event.repeat_rule] || null
    : event.repeat_rule && typeof event.repeat_rule === "object"
      ? event.repeat_rule as EventRepeatRule : null;
  if (!rawRule || !["day", "week", "month", "year"].includes(String(rawRule.unit))) {
    return eventDate >= fromDate && eventDate <= toDate ? [eventDate] : [];
  }

  const rule = rawRule;
  const interval = Math.max(1, Math.min(99, Number(rule.interval) || 1));
  const [, , anchorDay] = eventDate.split("-").map(Number);
  let date = eventDate, position = 0;
  if (rule.unit === "week" && rule.days?.length && !rule.days.includes(new Date(dateNumber(date) * 86_400_000).getUTCDay())) {
    date = stepEventDate(date, rule, anchorDay);
  }
  const end = rule.end || { type: "never" };
  const count = end.type === "after" ? Math.max(1, Number(end.count) || 1) : Infinity;
  if (rule.unit === "day" && fromDate > date) {
    position = Math.max(0, Math.ceil((dateNumber(fromDate) - dateNumber(date)) / interval));
    date = shiftDateKey(date, position * interval);
  } else {
    while (date < fromDate && position < count && (!end.date || date <= end.date)) {
      date = stepEventDate(date, rule, anchorDay);
      position++;
    }
  }

  const skipped = new Set(Array.isArray(rule.skipDates) ? rule.skipDates : []);
  const dates: string[] = [];
  while (position < count && date <= toDate && (!end.date || date <= end.date)) {
    if (date >= fromDate && !skipped.has(date)) dates.push(date);
    date = stepEventDate(date, rule, anchorDay);
    position++;
  }
  return dates;
}

function validSubscription(value: unknown) {
  if (!value || typeof value !== "object") return false;
  const sub = value as Record<string, unknown>;
  if (typeof sub.endpoint !== "string" || typeof sub.keys !== "object" || !sub.keys) return false;
  try {
    const endpoint = new URL(sub.endpoint);
    const host = endpoint.hostname.toLowerCase();
    const allowed = host === "fcm.googleapis.com"
      || host === "push.services.mozilla.com"
      || host.endsWith(".push.services.mozilla.com")
      || host.endsWith(".push.apple.com")
      || host === "notify.windows.com"
      || host.endsWith(".notify.windows.com");
    return endpoint.protocol === "https:" && allowed;
  } catch {
    return false;
  }
}

Deno.serve(async request => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: jsonHeaders });
  if (request.method !== "POST") return reply({ error: "Method not allowed." }, 405);

  const expectedSecret = Deno.env.get("REMINDER_CRON_SECRET");
  if (!expectedSecret || request.headers.get("x-coursewise-cron-secret") !== expectedSecret) {
    return reply({ error: "Unauthorized." }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const vapidPublic = Deno.env.get("VAPID_PUBLIC_KEY");
  const vapidPrivate = Deno.env.get("VAPID_PRIVATE_KEY");
  const vapidSubject = Deno.env.get("VAPID_SUBJECT");
  if (!supabaseUrl || !serviceKey || !vapidPublic || !vapidPrivate || !vapidSubject) {
    console.error("Task reminder sender is missing required configuration.");
    return reply({ error: "Task reminder sender is not configured." }, 500);
  }

  webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);
  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const now = new Date();
  const windowStart = new Date(now.getTime() - 90_000);
  const windowEnd = new Date(now.getTime() + minute);
  let sent = 0, failed = 0, skipped = 0;

  const { data: subscriptions, error: subscriptionError } = await db.from("coursewise_push_subscriptions")
    .select("id,auth_user_id,endpoint,subscription,timezone");
  if (subscriptionError) {
    console.error("Could not load push subscriptions:", subscriptionError.message);
    return reply({ error: "Could not load notification subscriptions." }, 500);
  }
  if (!subscriptions?.length) return reply({ sent: 0, failed: 0, skipped: 0 });

  const authIds = [...new Set(subscriptions.map(row => row.auth_user_id))];
  const { data: users, error: userError } = await db.from("User").select("UserID,AuthUserID").in("AuthUserID", authIds);
  if (userError) {
    console.error("Could not map notification accounts:", userError.message);
    return reply({ error: "Could not load notification accounts." }, 500);
  }
  const userIdByAuth = new Map((users || []).map(user => [user.AuthUserID, String(user.UserID)]));
  const tasksByUser = new Map<string, Record<string, unknown>[]>();
  const eventsByUser = new Map<string, Record<string, unknown>[]>();

  for (const authId of authIds) {
    const userId = userIdByAuth.get(authId);
    if (!userId) continue;
    const rows: Record<string, unknown>[] = [];
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await db.from("Tasks")
        .select("TaskID,UserID,TaskDueDate,HasDueTime,Reminder,IsComplete")
        .eq("UserID", userId).eq("IsComplete", false).not("Reminder", "is", null)
        .not("TaskDueDate", "is", null).range(offset, offset + 999);
      if (error) {
        console.error("Could not load pending task reminders:", error.message);
        return reply({ error: "Could not load task reminders." }, 500);
      }
      rows.push(...(data || []));
      if ((data || []).length < 1000) break;
    }
    tasksByUser.set(authId, rows);

    const eventRows: Record<string, unknown>[] = [];
    let eventReminderColumnAvailable = true;
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await db.from("coursewise_calendar_events")
        .select("id,auth_user_id,title,event_date,event_time,reminder,repeat_rule")
        .eq("auth_user_id", authId).not("reminder", "is", null).range(offset, offset + 999);
      if (error) {
        if (["42703", "PGRST204"].includes(error.code)) {
          console.warn("Event reminders are unavailable until the calendar event reminder migration is applied.");
          eventReminderColumnAvailable = false;
          break;
        }
        console.error("Could not load pending event reminders:", error.message);
        return reply({ error: "Could not load event reminders." }, 500);
      }
      eventRows.push(...(data || []));
      if ((data || []).length < 1000) break;
    }
    eventsByUser.set(authId, eventReminderColumnAvailable ? eventRows : []);
  }

  for (const device of subscriptions) {
    if (!validSubscription(device.subscription)
      || (device.subscription as Record<string, unknown>).endpoint !== device.endpoint) { skipped++; continue; }
    const tasks = tasksByUser.get(device.auth_user_id) || [];
    for (const task of tasks) {
      const reminder = String(task.Reminder);
      if (!reminderOffsets[reminder]) { skipped++; continue; }
      const dueAt = dueInstant(task, String(device.timezone || "UTC"));
      if (!dueAt) { skipped++; continue; }
      const remindAt = reminderInstant(dueAt, reminder, String(device.timezone || "UTC"));
      if (!remindAt) { skipped++; continue; }
      if (remindAt < windowStart || remindAt > windowEnd) continue;

      const taskId = String(task.TaskID);
      const dueIso = dueAt.toISOString();
      const { data: claim, error: claimError } = await db.from("coursewise_task_reminder_deliveries")
        .upsert({ task_id: taskId, due_at: dueIso, subscription_id: device.id }, {
          onConflict: "task_id,due_at,subscription_id", ignoreDuplicates: true
        }).select("id").maybeSingle();
      if (claimError) {
        console.error("Could not claim task reminder delivery:", claimError.message);
        failed++;
        continue;
      }
      if (!claim) continue;

      try {
        await webpush.sendNotification(device.subscription, JSON.stringify({
          title: "Coursewise task reminder",
          body: "A task you scheduled is coming up.",
          tag: `coursewise-task-${taskId}-${dueAt.getTime()}`,
          url: "home.html"
        }), { TTL: 3600, urgency: "normal" });
        sent++;
      } catch (error) {
        failed++;
        const statusCode = Number((error as { statusCode?: number })?.statusCode);
        if (statusCode === 404 || statusCode === 410) {
          await db.from("coursewise_push_subscriptions").delete().eq("id", device.id);
        } else {
          // Let the next minute retry transient push-service failures.
          await db.from("coursewise_task_reminder_deliveries").delete()
            .eq("task_id", taskId).eq("due_at", dueIso).eq("subscription_id", device.id);
        }
      }
    }

    const events = eventsByUser.get(device.auth_user_id) || [];
    const timezone = String(device.timezone || "UTC");
    for (const event of events) {
      const reminder = String(event.reminder);
      if (!reminderOffsets[reminder]) { skipped++; continue; }
      const eventTime = typeof event.event_time === "string" ? event.event_time.slice(0, 5) : "09:00";
      if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(eventTime)) { skipped++; continue; }
      for (const occurrenceDate of eventOccurrenceDates(event, timezone, now)) {
        let dueAt: Date;
        try {
          dueAt = zonedLocalTimeToUtc(occurrenceDate, eventTime, timezone);
        } catch {
          dueAt = zonedLocalTimeToUtc(occurrenceDate, eventTime, "UTC");
        }
        const remindAt = reminderInstant(dueAt, reminder, timezone);
        if (!remindAt || remindAt < windowStart || remindAt > windowEnd) continue;

        const eventId = String(event.id);
        const { data: claim, error: claimError } = await db.from("coursewise_event_reminder_deliveries")
          .upsert({ event_id: eventId, occurrence_date: occurrenceDate, subscription_id: device.id }, {
            onConflict: "event_id,occurrence_date,subscription_id", ignoreDuplicates: true
          }).select("id").maybeSingle();
        if (claimError) {
          console.error("Could not claim event reminder delivery:", claimError.message);
          failed++;
          continue;
        }
        if (!claim) continue;

        try {
          await webpush.sendNotification(device.subscription, JSON.stringify({
            title: "Coursewise event reminder",
            body: "An event you scheduled is coming up.",
            tag: `coursewise-event-${eventId}-${occurrenceDate}`,
            url: "calendar.html"
          }), { TTL: 3600, urgency: "normal" });
          sent++;
        } catch (error) {
          failed++;
          const statusCode = Number((error as { statusCode?: number })?.statusCode);
          if (statusCode === 404 || statusCode === 410) {
            await db.from("coursewise_push_subscriptions").delete().eq("id", device.id);
          } else {
            await db.from("coursewise_event_reminder_deliveries").delete()
              .eq("event_id", eventId).eq("occurrence_date", occurrenceDate).eq("subscription_id", device.id);
          }
        }
      }
    }
  }

  // Keep the idempotency ledger bounded without retaining task or endpoint details.
  await db.from("coursewise_task_reminder_deliveries")
    .delete().lt("sent_at", new Date(now.getTime() - 90 * 24 * 60 * minute).toISOString());
  await db.from("coursewise_event_reminder_deliveries")
    .delete().lt("sent_at", new Date(now.getTime() - 90 * 24 * 60 * minute).toISOString());
  return reply({ sent, failed, skipped });
});
