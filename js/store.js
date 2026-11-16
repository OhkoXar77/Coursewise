/* Tidy — cloud data and recurrence helpers. Supabase is the source of truth. */
(() => {
  const pad = n => String(n).padStart(2, "0");
  const toKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const shift = n => { const d = new Date(); d.setDate(d.getDate() + n); return toKey(d); };
  const parseKey = k => { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d); };
  const fmtDate = k => parseKey(k).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  // 12-hour or 24-hour ("military") display. Times are always stored as 24-hour HH:MM.
  const TIME_KEY = "coursewise-time-format";
  const TASK_SORT_MODES = [
    ["manual", "Custom order"],
    ["title", "Alphabetically"],
    ["due", "Due date"],
    ["created", "Recently added"],
    ["category", "Category"]
  ];
  const validTaskSort = mode => TASK_SORT_MODES.some(([value]) => value === mode);
  let timeFormat = "12";
  try { if (localStorage.getItem(TIME_KEY) === "24") timeFormat = "24"; } catch {}
  const fmtTime = t => {
    if (!t) return "";
    const [h, m] = t.split(":").map(Number);
    return timeFormat === "24" ? `${pad(h)}:${pad(m)}` : `${h % 12 || 12}:${pad(m)} ${h >= 12 ? "PM" : "AM"}`;
  };
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const REPEATS = { daily: "Every day", weekdays: "Every weekday", weekly: "Every week", monthly: "Every month" };
  const THEMES = [["green", "Green"], ["teal", "Teal"], ["blue", "Blue"], ["purple", "Purple"], ["pink", "Pink"], ["orange", "Orange"]];
  const DAYN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const PRESETS = { daily: { unit: "day", interval: 1 }, weekdays: { unit: "week", interval: 1, days: [1, 2, 3, 4, 5] }, weekly: { unit: "week", interval: 1 }, monthly: { unit: "month", interval: 1 } };
  const asRule = r => (typeof r === "string" ? PRESETS[r] : r);

  /* The date after `d` for a repeat rule: { unit, interval, days?, end? } */
  function stepDate(d, rule, anchor) {
    const n = Math.max(1, rule.interval || 1);
    if (rule.unit === "day") { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
    if (rule.unit === "week") {
      const days = rule.days && rule.days.length ? rule.days : [d.getDay()];
      const sow = v => { const x = new Date(v); x.setDate(x.getDate() - x.getDay()); x.setHours(12, 0, 0, 0); return x; };
      const base = sow(d);
      for (let i = 1; i <= 7 * n + 7; i++) {
        const c = new Date(d); c.setDate(c.getDate() + i);
        if (days.includes(c.getDay()) && Math.round((sow(c) - base) / 604800000) % n === 0) return c;
      }
    }
    const months = rule.unit === "year" ? 12 * n : n;
    const y = new Date(d.getFullYear(), d.getMonth() + months, 1);
    y.setDate(Math.min(anchor, new Date(y.getFullYear(), y.getMonth() + 1, 0).getDate()));
    return y;
  }
  /* Next occurrence, always later than today */
  function nextDate(key, repeat) {
    const rule = asRule(repeat), today = toKey(new Date()), anchor = parseKey(key).getDate();
    let d = parseKey(key);
    do d = stepDate(d, rule, anchor); while (toKey(d) <= today);
    return toKey(d);
  }
  function eventOccurrences(event, fromKey, endKey) {
    const rule = asRule(event.repeat), start = parseKey(event.date);
    const spansNextDay = !!(event.time && event.endTime && event.endTime <= event.time);
    const occurrenceFromKey = spansNextDay ? shiftKey(fromKey, -1) : fromKey;
    start.setHours(12, 0, 0, 0);
    const occurrences = [];
    const addOccurrence = date => {
      if (rule?.skipDates?.includes(date)) return;
      const occurrence = { ...event, date, occurrenceDate: date };
      if (date >= fromKey && date <= endKey) occurrences.push(occurrence);
      if (spansNextDay) {
        const nextDate = shiftKey(date, 1);
        if (nextDate >= fromKey && nextDate <= endKey) {
          occurrences.push({ ...occurrence, date: nextDate, time: null, occurrenceDate: date });
        }
      }
    };
    if (!rule) {
      addOccurrence(event.date);
      return occurrences;
    }

    const interval = Math.max(1, Number(rule.interval) || 1), anchor = start.getDate();
    if (rule.unit === 'week' && rule.days?.length && !rule.days.includes(start.getDay())) {
      start.setTime(stepDate(start, rule, anchor).getTime());
    }
    const end = rule.end || { type: 'never' };
    const count = end.type === 'after' ? Math.max(1, Number(end.count) || 1) : Infinity;
    let date = start, position = 0;

    if (rule.unit === 'day' && occurrenceFromKey > event.date) {
      const dayNumber = key => {
        const [year, month, day] = key.split('-').map(Number);
        return Date.UTC(year, month - 1, day) / 86400000;
      };
      position = Math.max(0, Math.ceil((dayNumber(occurrenceFromKey) - dayNumber(event.date)) / interval));
      date = new Date(start);
      date.setDate(date.getDate() + position * interval);
    } else {
      while (toKey(date) < occurrenceFromKey && position < count && (!end.date || toKey(date) <= end.date)) {
        date = stepDate(date, rule, anchor);
        position++;
      }
    }

    while (position < count && toKey(date) <= endKey && (!end.date || toKey(date) <= end.date)) {
      addOccurrence(toKey(date));
      date = stepDate(date, rule, anchor);
      position++;
    }
    return occurrences;
  }
  function shiftKey(key, days) {
    const date = parseKey(key);
    date.setDate(date.getDate() + days);
    return toKey(date);
  }
  function taskSeriesId(tasks, task) {
    const seriesId = asRule(task.repeat)?.seriesId;
    if (seriesId) return String(seriesId);
    let first = task;
    const seen = new Set([task.id]);
    while (true) {
      const previous = tasks.find(candidate => candidate.spawned === first.id && !seen.has(candidate.id));
      if (!previous) break;
      first = previous;
      seen.add(first.id);
    }
    return `legacy-${first.id}`;
  }
  function recurrencePattern(repeat) {
    const rule = { ...asRule(repeat) };
    delete rule.materialized;
    delete rule.seriesId;
    delete rule.seriesPosition;
    delete rule.seriesStart;
    delete rule.seriesDays;
    delete rule.seriesEnd;
    return JSON.stringify(rule);
  }
  function taskOccurrences(tasks, fromKey, endKey, occurrenceStates = state.taskOccurrences) {
    const knownTaskIds = new Set(tasks.map(task => task.id));
    const occurrenceByTask = new Map(occurrenceStates.filter(item => item.taskId && !item.skipped && knownTaskIds.has(item.taskId))
      .map(item => [item.taskId, item]));
    const skipped = new Set(occurrenceStates.filter(item => item.skipped)
      .map(item => `${item.seriesId}\u0000${item.date}`));
    const output = new Map();
    for (const task of tasks) {
      if (!task.due || task.due < fromKey || task.due > endKey) continue;
      const identity = occurrenceByTask.get(task.id);
      const seriesId = identity?.seriesId || (task.repeat ? taskSeriesId(tasks, task) : null);
      const occurrenceDate = identity?.date || task.due;
      if (seriesId && skipped.has(`${seriesId}\u0000${occurrenceDate}`)) continue;
      const occurrenceIdentity = seriesId ? { seriesId, date: occurrenceDate } : null;
      const occurrence = { ...task, occurrenceIdentity, virtualOccurrence: false };
      const key = seriesId ? `${seriesId}\u0000${occurrenceDate}` : `task\u0000${task.id}`;
      const existing = output.get(key);
      if (!existing || (task.done && !existing.done)) {
        output.set(key, occurrence);
      }
    }

    const patterns = new Map();
    const registeredKeys = new Set(occurrenceStates.filter(item => item.taskId && !item.skipped && knownTaskIds.has(item.taskId))
      .map(item => `${item.seriesId}\u0000${item.date}`));
    for (const task of tasks) {
      const rule = asRule(task.repeat);
      if (!rule || rule.materialized || !task.due) continue;
      const registration = occurrenceByTask.get(task.id);
      const seriesId = taskSeriesId(tasks, task), pattern = recurrencePattern(rule);
      const key = `${seriesId}\u0000${pattern}`;
      const existing = patterns.get(key);
      const anchor = rule.seriesStart || registration?.date || task.due;
      if (!existing || anchor < existing.due) {
        patterns.set(key, { ...task, due: anchor, repeat: { ...rule, seriesId }, seriesId });
      }
    }

    for (const template of patterns.values()) {
      const seriesId = template.seriesId;
      const dates = eventOccurrences({ date: template.due, repeat: template.repeat }, fromKey, endKey);
      for (const item of dates) {
        const key = `${seriesId}\u0000${item.date}`;
        if (skipped.has(key) || registeredKeys.has(key) || output.has(key)) continue;
        output.set(key, {
          ...template,
          due: item.date,
          done: false,
          occurrenceIdentity: { seriesId, date: item.date },
          virtualOccurrence: true
        });
      }
    }
    return [...output.values()].sort((a, b) => a.due.localeCompare(b.due) ||
      (a.time || "99:99").localeCompare(b.time || "99:99") || a.title.localeCompare(b.title));
  }
  function nextScheduledDate(task, afterKey) {
    const rule = asRule(task.repeat);
    if (!rule || rule.materialized || !task.due) return null;
    const startKey = rule.seriesStart || task.due;
    const anchor = parseKey(startKey).getDate();
    let date = parseKey(startKey), position = 1;
    if (rule.unit === "week" && rule.days?.length && !rule.days.includes(date.getDay())) {
      date = stepDate(date, rule, anchor);
    }
    const count = rule.end?.type === "after" ? Math.max(1, Number(rule.end.count) || 1) : Infinity;
    if (rule.unit === "day" && toKey(date) <= afterKey) {
      const dayNumber = key => {
        const [year, month, day] = key.split("-").map(Number);
        return Date.UTC(year, month - 1, day) / 86400000;
      };
      const interval = Math.max(1, Number(rule.interval) || 1);
      const steps = Math.floor((dayNumber(afterKey) - dayNumber(toKey(date))) / interval) + 1;
      position += steps;
      date.setDate(date.getDate() + steps * interval);
    } else {
      while (toKey(date) <= afterKey && position < count) {
        date = stepDate(date, rule, anchor);
        position++;
      }
    }
    if (position > count || toKey(date) <= afterKey ||
      (rule.end?.type === "on" && rule.end.date && toKey(date) > rule.end.date)) return null;
    return toKey(date);
  }
  function taskListItems(tasks, showDone, today = toKey(new Date())) {
    const result = tasks.filter(task => !task.repeat || !task.due);
    const recurring = tasks.filter(task => task.repeat && task.due);
    if (!recurring.length) return result.filter(task => showDone || !task.done);

    const start = recurring.reduce((first, task) => {
      const seriesStart = asRule(task.repeat)?.seriesStart || task.due;
      return seriesStart < first ? seriesStart : first;
    }, recurring[0].due);
    const latestDone = new Map();
    for (const task of recurring) {
      if (!task.done) continue;
      const seriesId = taskSeriesId(tasks, task);
      const date = task.occurrenceIdentity?.date || task.due;
      if (date > (latestDone.get(seriesId) || "")) latestDone.set(seriesId, date);
    }
    const through = [...latestDone.values()].reduce((end, date) => date > end ? date : end, today);
    const occurrences = taskOccurrences(tasks, start, through)
      .filter(task => task.repeat && task.due);

    for (const task of recurring) {
      if (task.due <= through) continue;
      const seriesId = taskSeriesId(tasks, task);
      const occurrenceDate = task.occurrenceIdentity?.date || task.due;
      if (state.taskOccurrences.some(item =>
        item.skipped && item.seriesId === seriesId && item.date === occurrenceDate)) continue;
      occurrences.push({
        ...task,
        occurrenceIdentity: task.occurrenceIdentity || { seriesId, date: occurrenceDate }
      });
    }

    const nextBySeries = new Map();
    const visibleOccurrences = [];
    for (const task of occurrences) {
      const seriesId = task.occurrenceIdentity?.seriesId || taskSeriesId(tasks, task);
      const completedThrough = latestDone.get(seriesId) || "";
      if (task.done) {
        if (showDone) visibleOccurrences.push(task);
      } else if (task.due <= today || task.due <= completedThrough) {
        visibleOccurrences.push(task);
      } else if (task.due > today) {
        const current = nextBySeries.get(seriesId);
        if (!current || task.due < current.due) nextBySeries.set(seriesId, task);
      }
    }

    const series = new Map();
    for (const task of recurring) {
      const seriesId = taskSeriesId(tasks, task), pattern = recurrencePattern(task.repeat);
      const patterns = series.get(seriesId) || new Map();
      const current = patterns.get(pattern);
      if (!current || task.due < current.due) patterns.set(pattern, task);
      series.set(seriesId, patterns);
    }
    for (const [seriesId, patterns] of series) {
      const boundary = latestDone.get(seriesId) || "";
      for (const task of patterns.values()) {
        let candidateDate = nextScheduledDate(task, boundary > today ? boundary : today);
        while (candidateDate) {
          const candidate = taskOccurrences(tasks, candidateDate, candidateDate)
            .find(item => item.occurrenceIdentity?.seriesId === seriesId && item.occurrenceIdentity.date === candidateDate);
          if (!candidate) {
            const rule = asRule(task.repeat);
            if (rule?.end?.type === "on" && rule.end.date && candidateDate >= rule.end.date) break;
            const next = { ...task, due: candidateDate };
            candidateDate = nextScheduledDate(next, candidateDate);
            continue;
          }
          if (!candidate.done) {
            const current = nextBySeries.get(seriesId);
            if (!current || candidate.due < current.due) nextBySeries.set(seriesId, candidate);
            break;
          }
          candidateDate = nextScheduledDate(task, candidateDate);
        }
      }
    }
    result.push(...visibleOccurrences, ...nextBySeries.values());
    return result.filter(task => showDone || !task.done);
  }
  function weeklyTasks(task) {
    const rule = asRule(task.repeat);
    const days = rule?.unit === "week" && rule.days?.length > 1
      ? [...new Set(rule.days)].filter(day => Number.isInteger(day) && day >= 0 && day <= 6).sort((a, b) => a - b)
      : [];
    if (days.length < 2 || !task.due) return [task];

    const interval = Math.max(1, rule.interval || 1), base = parseKey(task.due);
    base.setHours(12, 0, 0, 0);
    const nextByDay = new Map(days.map(day => {
      const date = new Date(base);
      date.setDate(date.getDate() + (day - date.getDay() + 7) % 7);
      if (date < base) date.setDate(date.getDate() + interval * 7);
      return [day, date];
    }));
    const counts = new Map(days.map(day => [day, 1]));
    const end = rule.end || { type: "never" };

    if (end.type === "after") {
      for (const day of days) counts.set(day, 0);
      const next = new Map(nextByDay);
      for (let occurrence = 0; occurrence < Math.max(1, Number(end.count) || 1); occurrence++) {
        const day = days.reduce((first, candidate) => next.get(candidate) < next.get(first) ? candidate : first, days[0]);
        counts.set(day, counts.get(day) + 1);
        const date = new Date(next.get(day));
        date.setDate(date.getDate() + interval * 7);
        next.set(day, date);
      }
    }

    return days.filter(day => counts.get(day) > 0 && (end.type !== "on" || !end.date || toKey(nextByDay.get(day)) <= end.date))
      .map(day => {
        const dayRule = { ...rule, days: [day], seriesDays: days, seriesEnd: end };
        if (end.type === "after") dayRule.end = { type: "after", count: counts.get(day) };
        return { ...task, due: toKey(nextByDay.get(day)), repeat: dayRule };
      }).sort((a, b) => a.due.localeCompare(b.due));
  }
  function recurrenceTasks(task) {
    const rule = asRule(task.repeat), end = rule?.end;
    if (!rule || rule.materialized) return { tasks: [task], truncated: false };
    if (!end || !["after", "on"].includes(end.type)) {
      const seriesId = rule.seriesId || uid();
      return { tasks: weeklyTasks(task).map((item, index) => ({
        ...item, repeat: { ...asRule(item.repeat), seriesId, seriesPosition: index, seriesStart: item.due }
      })), truncated: false };
    }

    const anchor = parseKey(task.due).getDate();
    const seriesId = rule.seriesId || uid();
    let date = parseKey(task.due);
    date.setHours(12, 0, 0, 0);
    if (rule.unit === "week" && rule.days?.length && !rule.days.includes(date.getDay())) {
      date = stepDate(date, rule, anchor);
    }
    const count = end.type === "after" ? Math.max(1, Number(end.count) || 1) : Infinity;
    const tasks = [];
    let truncated = false;
    while (tasks.length < count && (end.type !== "on" || toKey(date) <= end.date)) {
      if (tasks.length === 100) { truncated = true; break; }
      const repeat = { ...rule, materialized: true, seriesId, seriesPosition: tasks.length, seriesStart: toKey(parseKey(task.due)) };
      if (rule.unit === "week" && rule.days?.length > 1) {
        repeat.seriesDays = [...new Set(rule.days)];
        repeat.seriesEnd = end;
      }
      tasks.push({ ...task, due: toKey(date), repeat });
      date = stepDate(date, rule, anchor);
    }
    if (!tasks.length) throw new Error("The recurrence end must be on or after the first occurrence.");
    return { tasks, truncated };
  }
  function legacySeriesTasks(tasks, task) {
    const rule = task.repeat;
    if (!rule?.materialized || rule.seriesId || !rule.end || !["after", "on"].includes(rule.end.type)) return [];

    const { materialized, seriesPosition, seriesDays, seriesEnd, ...repeat } = rule;
    const identity = JSON.stringify({ title: task.title, categoryId: task.categoryId, listId: task.listId,
      time: task.time, reminder: task.reminder, repeat });
    const candidates = tasks.filter(item => {
      const candidate = item.repeat;
      if (!candidate?.materialized || candidate.seriesId || !candidate.end || !["after", "on"].includes(candidate.end.type)) return false;
      const { materialized: ignoredMaterialized, seriesPosition: ignoredPosition, seriesDays: ignoredDays, seriesEnd: ignoredEnd, ...candidateRepeat } = candidate;
      return JSON.stringify({ title: item.title, categoryId: item.categoryId, listId: item.listId,
        time: item.time, reminder: item.reminder, repeat: candidateRepeat }) === identity;
    }).sort((a, b) => a.due.localeCompare(b.due));
    if (candidates.length < 2) return candidates;

    const first = parseKey(candidates[0].due), anchor = first.getDate(), included = new Set([candidates[0].id]);
    let expected = first, steps = 0;
    for (const candidate of candidates.slice(1)) {
      while (toKey(expected) < candidate.due && steps < 1000) {
        expected = stepDate(expected, rule, anchor);
        steps++;
      }
      if (toKey(expected) === candidate.due) included.add(candidate.id);
    }
    return candidates.filter(item => included.has(item.id));
  }
  function taskDeletionIds(tasks, task, scope) {
    const ids = new Set(), addFollowing = start => {
      let current = start;
      while (current && !ids.has(current.id)) {
        ids.add(current.id);
        current = tasks.find(item => item.id === current.spawned);
      }
    };
    if (scope === "this") {
      ids.add(task.id);
      return ids;
    }
    const seriesId = task.repeat?.seriesId, legacySeries = seriesId ? [] : legacySeriesTasks(tasks, task);
    if (seriesId) {
      const series = tasks.filter(item => item.repeat?.seriesId === seriesId), familyIds = new Set();
      series.forEach(start => {
        let current = start;
        while (current && !familyIds.has(current.id)) {
          familyIds.add(current.id);
          current = tasks.find(item => item.id === current.spawned);
        }
      });
      const family = tasks.filter(item => familyIds.has(item.id));
      const position = task.repeat?.materialized ? task.repeat.seriesPosition : null;
      const selected = scope === "all" ? family : scope === "following"
        ? family.filter(item => Number.isInteger(position) && item.repeat?.materialized && Number.isInteger(item.repeat.seriesPosition)
          ? item.repeat.seriesPosition >= position : item.due >= task.due)
        : [task];
      selected.forEach(addFollowing);
    } else if (legacySeries.length) {
      const familyIds = new Set();
      legacySeries.forEach(start => {
        let current = start;
        while (current && !familyIds.has(current.id)) {
          familyIds.add(current.id);
          current = tasks.find(item => item.id === current.spawned);
        }
      });
      const family = tasks.filter(item => familyIds.has(item.id));
      const selected = scope === "all" ? family : scope === "following"
        ? family.filter(item => item.due >= task.due) : [task];
      selected.forEach(addFollowing);
    } else if (scope === "this") {
      ids.add(task.id);
    } else {
      let first = task;
      if (scope === "all") {
        const seen = new Set([task.id]);
        while (true) {
          const previous = tasks.find(item => item.spawned === first.id && !seen.has(item.id));
          if (!previous) break;
          first = previous;
          seen.add(first.id);
        }
      }
      addFollowing(first);
    }
    return ids;
  }
  function hasNextOccurrence(tasks, task, due) {
    const rule = asRule(task.repeat);
    if (!rule) return false;
    const normalizeRule = value => {
      const recurrence = { ...value };
      delete recurrence.materialized;
      delete recurrence.seriesId;
      delete recurrence.seriesPosition;
      delete recurrence.seriesStart;
      delete recurrence.seriesDays;
      delete recurrence.seriesEnd;
      return JSON.stringify(recurrence);
    };
    return tasks.some(candidate => {
      if (candidate.id === task.id || candidate.due !== due || !candidate.repeat) return false;
      const candidateRule = asRule(candidate.repeat);
      if (!candidateRule) return false;
      if (rule.seriesId && candidateRule.seriesId) return rule.seriesId === candidateRule.seriesId;
      return candidate.title === task.title &&
        candidate.categoryId === task.categoryId &&
        candidate.listId === task.listId &&
        candidate.time === task.time &&
        candidate.reminder === task.reminder &&
        candidate.fromCanvas === task.fromCanvas &&
        normalizeRule(rule) === normalizeRule(candidateRule);
    });
  }
  function repeatLabel(r) {
    if (typeof r === "string") return REPEATS[r];
    const n = r.interval || 1;
    let s = n === 1 ? `Every ${r.unit}` : `Every ${n} ${r.unit}s`;
    const days = r.seriesDays || r.days, end = r.seriesEnd || r.end;
    if (r.unit === "week" && days && days.length) s += " on " + [...days].sort().map(i => DAYN[i]).join(", ");
    if (end && end.type === "on") s += ", until " + parseKey(end.date).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    if (end && end.type === "after") s += `, ${end.count} times`;
    return s;
  }
  const uid = () => "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  const db = window.tidyClient;
  const tones = ["sky", "grape", "sun", "mint", "rose", "slate", "teal", "coral", "indigo", "lime"];
  const empty = () => ({ signedIn: false, user: { first: '', last: '', email: '', username: '' }, prefs: { weekStart: 0, showDone: false, theme: 'green', defaultSortOrder: 'manual' }, categories: [], lists: [], tasks: [], taskOccurrences: [], events: [], canvasConnected: false, completedToday: 0, streak: null, introDone: true });
  let state = empty(), authUser, owner;
  const defaultSortKey = () => `cw-default-task-sort-v1:${authUser?.id || "default"}`;
  function savedDefaultSort() {
    try {
      const saved = localStorage.getItem(defaultSortKey());
      return validTaskSort(saved) ? saved : "manual";
    } catch { return "manual"; }
  }
  function sortTasks(tasks, mode, direction = "asc") {
    if (mode === "manual") return tasks;
    const sign = direction === "desc" ? -1 : 1;
    const compareText = (a, b) => String(a || "").localeCompare(String(b || ""), undefined, { numeric: true, sensitivity: "base" });
    return [...tasks].sort((a, b) => {
      let left, right;
      if (mode === "title") { left = a.title; right = b.title; }
      else if (mode === "due") { left = a.due; right = b.due; }
      else if (mode === "created") { left = a.createdAt; right = b.createdAt; }
      else if (mode === "category") { left = Tidy.cat(a.categoryId)?.name; right = Tidy.cat(b.categoryId)?.name; }
      else return (a.sortOrder - b.sortOrder) || a.id.localeCompare(b.id);
      const leftMissing = left == null || left === "", rightMissing = right == null || right === "";
      if (leftMissing !== rightMissing) return leftMissing ? (direction === "asc" ? 1 : -1) : (direction === "asc" ? -1 : 1);
      if (leftMissing) return (a.sortOrder - b.sortOrder) || a.id.localeCompare(b.id);
      return sign * (mode === "due" || mode === "created"
        ? String(left).localeCompare(String(right))
        : compareText(left, right)) || (a.sortOrder - b.sortOrder) || a.id.localeCompare(b.id);
    });
  }
  const requireDb = () => { if (!db) throw new Error('Could not load Supabase. Check your connection and reload.'); };
  async function result(query) { const {data, error} = await query; if (error) throw new Error(error.message); return data; }
  const id = n => n == null ? null : String(n);
  function validateEventTimes(p) {
    const validTime = value => !value || /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
    if (!validTime(p.time) || !validTime(p.endTime)) throw new Error('Enter a valid event time.');
    if (p.endTime && !p.time) throw new Error('Choose a start time before setting an end time.');
    if (p.reminder && !['15m', '1h', '1d', '1w'].includes(p.reminder)) throw new Error('Choose a valid event reminder.');
  }
  function parseRepeat(r) {
    if (!r) return null;
    let v; try { v = JSON.parse(r); } catch { v = r; }
    if (typeof v === 'string') return PRESETS[v] ? v : null;
    if (!v || !['day','week','month','year'].includes(v.unit)) return null;
    return { ...v, interval: Math.min(99, Math.max(1, Number(v.interval) || 1)) };
  }
  function taskFromRow(r) {
    const d = r.TaskDueDate ? new Date(r.TaskDueDate) : null;
    return { id: id(r.TaskID), title: r.Name, categoryId: id(r.CategoryID), listId: id(r.ListID),
      due: d ? (r.HasDueTime ? toKey(d) : r.TaskDueDate.slice(0,10)) : null,
      time: d && r.HasDueTime ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : null,
      reminder: r.Reminder, done: r.IsComplete, repeat: parseRepeat(r.Repeating),
      occ: r.Occurrence, spawned: id(r.SpawnedTaskID), fromCanvas: r.IsAssignment, sortOrder: r.SortOrder,
      createdAt: r.CreatedAt || r.created_at || null };
  }
  function dueStamp(p) { return p.due ? (p.time ? new Date(`${p.due}T${p.time}:00`).toISOString() : `${p.due}T00:00:00.000Z`) : null; }
  function taskToRow(p) {
    return { Name: p.title, CategoryID: p.categoryId || null, ListID: p.listId || null,
      ListName: state.lists.find(l => l.id === p.listId)?.title || null,
      TaskDueDate: dueStamp(p), HasDueTime: !!(p.due && p.time), Reminder: p.due ? (p.reminder || null) : null,
      Repeating: p.repeat ? JSON.stringify(p.repeat) : null };
  }
  async function allRows(table, columns, order) {
    let rows = [];
    for (let offset = 0; ; offset += 1000) {
      const batch = await result(db.from(table).select(columns).eq('UserID', owner).order(order).range(offset, offset + 999));
      rows.push(...batch);
      if (batch.length < 1000) return rows;
    }
  }
  async function calendarEventsForUser(authUserId) {
    const baseColumns = 'id,title,event_date,event_time,end_time,category_id,repeat_rule';
    let response = await db.from('coursewise_calendar_events')
      .select(`${baseColumns},reminder`).eq('auth_user_id', authUserId).order('event_date').order('event_time');
    if (response.error && ['42703', 'PGRST204'].includes(response.error.code)) {
      response = await db.from('coursewise_calendar_events')
        .select(baseColumns).eq('auth_user_id', authUserId).order('event_date').order('event_time');
    }
    if (response.error) throw new Error(response.error.message);
    return response.data || [];
  }
  // Appearance is optional: if the column has not been added yet, load the rest of the settings as before.
  async function loadSettings() {
    const base = 'ColorTheme,WeekStart,ShowDone';
    let failure;
    // Newer columns are optional so the app keeps working until their SQL has been run.
    for (const extra of ['Appearance,TimeFormat,ShowGoose', 'Appearance,TimeFormat', 'Appearance', 'TimeFormat', '']) {

      const r = await db.from('Settings').select(extra ? `${base},${extra}` : base).eq('UserID', owner).single();
      if (!r.error) return r.data;
      failure = r.error;
    }
    throw new Error(failure.message);
  }
  const validMode = m => m === 'light' || m === 'dark' ? m : null;
  // Best effort: a failed save must never interrupt the app; the device still remembers the choice.
  async function saveAppearance(mode) {
    if (!owner || !validMode(mode)) return;
    try { await db.from('Settings').update({ Appearance: mode }).eq('UserID', owner); } catch {}
  }
  document.addEventListener('coursewise:appearance', e => {
    if (state.prefs) state.prefs.appearance = validMode(e.detail?.mode);
    void saveAppearance(e.detail?.mode);
  });
  // The getting-started guide is saved on the account so it shows once, not once per device.
  const introKey = kind => `cw-intro${kind}:${authUser?.id || ''}`;
  function introDone(saved, hasContent) {
    if (saved !== undefined) return saved !== null;
    // Until the column exists, decide once on this device: only accounts with nothing in them see the guide.
    try {
      let v = localStorage.getItem(introKey(''));
      if (v !== 'done' && v !== 'open') { v = hasContent ? 'done' : 'open'; localStorage.setItem(introKey(''), v); }
      return v === 'done';
    } catch { return hasContent; }
  }
  async function load() {
    if (!owner) throw new Error('Please log in again.');
    // Keep the prior screen intact if any request fails.
    const [profile, settings, categories, lists, tasks, taskOccurrenceRows, events, streak, introSaved] = await Promise.all([
      result(db.from('User').select('UserID,FirstName,LastName,Username').eq('UserID', owner).single()),
      loadSettings(),
      allRows('Categories','CategoryID,DisplayName,DisplayColor','CategoryID'),
      allRows('Lists','ListID,Title,SortOrder','SortOrder'),
      allRows('Tasks','*','TaskID'),
      result(db.from('coursewise_task_occurrences').select('series_id,occurrence_date,task_id,skipped,is_generated').eq('user_id', owner)),
      document.body.dataset.page === 'calendar'
        ? calendarEventsForUser(authUser.id)
        : Promise.resolve([]),
      // Streaks are a bonus: if the migration is not applied yet, the rest of the app still loads.
      Promise.resolve(db.rpc('coursewise_my_streak')).then(r => r.error ? null : r.data, () => null),
      // Getting-started guide: undefined means the IntroDoneAt column has not been added yet.
      Promise.resolve(db.from('Settings').select('IntroDoneAt').eq('UserID', owner).single())
        .then(r => r.error ? undefined : (r.data?.IntroDoneAt ?? null), () => undefined)
    ]);
    if (settings.TimeFormat === '12' || settings.TimeFormat === '24') {
      timeFormat = settings.TimeFormat;
      try { localStorage.setItem(TIME_KEY, timeFormat); } catch {}
    }
    const parsedTasks = tasks.filter(task => !task.CanvasExcluded).map(taskFromRow);
    state = { signedIn: true, user: { first: profile.FirstName, last: profile.LastName, username: profile.Username, email: authUser.email || '' },
      prefs: {
        theme: THEMES.some(t => t[0] === settings.ColorTheme) ? settings.ColorTheme : 'green',
        weekStart: settings.WeekStart,
        showDone: settings.ShowDone,
        defaultSortOrder: savedDefaultSort(),
        appearance: validMode(settings.Appearance),
        timeFormat,
        showGoose: settings.ShowGoose !== false
      },
      categories: categories.map(c => ({id:id(c.CategoryID),name:c.DisplayName,tone:tones.includes(c.DisplayColor)?c.DisplayColor:'slate'})),
      lists: lists.map(l => ({id:id(l.ListID),title:l.Title,order:l.SortOrder})),
      taskOccurrences: taskOccurrenceRows.map(item => ({
        seriesId: item.series_id, date: item.occurrence_date, taskId: id(item.task_id),
        skipped: item.skipped, generated: item.is_generated
      })),
      tasks: parsedTasks.map(task => {
          const occurrence = taskOccurrenceRows.find(item => id(item.task_id) === task.id && !item.skipped);
          if (occurrence) return { ...task, occurrenceIdentity: {
            seriesId: occurrence.series_id, date: occurrence.occurrence_date
          } };
          return task.repeat && task.due ? { ...task, occurrenceIdentity: {
            seriesId: taskSeriesId(parsedTasks, task), date: task.due
          } } : task;
        })
        .sort((a,b) => a.sortOrder-b.sortOrder || a.id.localeCompare(b.id)),
      events: events.map(event => ({ id: event.id, title: event.title, date: event.event_date,
        time: event.event_time?.slice(0, 5) || null, endTime: event.end_time?.slice(0, 5) || null,
        categoryId: id(event.category_id), repeat: parseRepeat(event.repeat_rule), reminder: event.reminder || null }))
        .sort((a,b) => a.date.localeCompare(b.date) || (a.time || '99:99').localeCompare(b.time || '99:99') || a.title.localeCompare(b.title)),
      canvasConnected: false,
      completedToday: Number(streak?.completed_today) || 0,
      streak: streak ? { current: Number(streak.current) || 0, longest: Number(streak.longest) || 0, doneToday: !!streak.done_today } : null,
      introDone: introDone(introSaved, tasks.length > 0 || lists.length > 0) };
    // Apply saved goose visibility on every page.
    document.documentElement.dataset.goose =
      state.prefs.showGoose ? "on" : "off";
    if (window.CoursewiseTheme) window.CoursewiseTheme.apply(state.prefs.theme);
    else document.documentElement.dataset.theme = state.prefs.theme;
    // The account's saved light/dark mode wins. If the account has none yet, keep this device's mode and save it.
    const A = window.CoursewiseAppearance;
    if (A) {
      if (state.prefs.appearance) A.set(state.prefs.appearance);
      else if ('Appearance' in settings) { state.prefs.appearance = A.get(); void saveAppearance(state.prefs.appearance); }
    }
  }
  async function init() {
    requireDb();
    const {data:{session}, error} = await db.auth.getSession();
    if (error) throw error;
    if (!session) return false;
    authUser = session.user;
    const p = await result(db.from('User').select('UserID').eq('AuthUserID',authUser.id).maybeSingle());
    if (!p) throw new Error('This account has no Tidy profile. Run setup.sql before creating a new account. Existing demo accounts are not migrated.');
    owner = p.UserID;
    await load(); return true;
  }
  // Database writes finish before the UI reports success. A load failure is distinct
  // from a write failure so users do not repeat an already-committed write.
  async function refreshAfterSave() {
    try { await load(); } catch { throw new Error('Your change was saved, but the screen could not refresh. Reload the page before making another change.'); }
  }
  async function write(query) { await result(query); await refreshAfterSave(); }
  async function materializeTaskOccurrence(seriesId, occurrenceDate) {
    const registration = state.taskOccurrences.find(item => item.seriesId === seriesId && item.date === occurrenceDate);
    if (registration?.skipped) throw new Error('This occurrence was deleted.');
    if (registration?.taskId) {
      const registeredTask = state.tasks.find(task => task.id === registration.taskId);
      if (registeredTask) return registeredTask;
    }

    const occurrence = taskOccurrences(state.tasks, occurrenceDate, occurrenceDate)
      .find(task => task.occurrenceIdentity?.seriesId === seriesId &&
        task.occurrenceIdentity.date === occurrenceDate);
    if (!occurrence) throw new Error('This recurring occurrence is no longer available. Reload the page.');

    let taskId = occurrence.id;
    let generated = !!occurrence.virtualOccurrence;
    if (generated) {
      const rule = { ...asRule(occurrence.repeat), seriesId };
      const sortOrder = Math.max(-1, ...state.tasks.filter(task => task.listId === occurrence.listId)
        .map(task => task.sortOrder)) + 1;
      const inserted = await result(db.from('Tasks').insert({
        ...taskToRow({ ...occurrence, due: occurrenceDate, repeat: rule }),
        SortOrder: sortOrder, UserID: owner, IsComplete: false, IsAssignment: false
      }).select('TaskID').single());
      taskId = id(inserted.TaskID);
    }

    let canonicalId;
    try {
      canonicalId = id(await result(db.rpc('coursewise_claim_task_occurrence', {
        p_series_id: seriesId,
        p_occurrence_date: occurrenceDate,
        p_task_id: taskId,
        p_generated: generated
      })));
    } catch (error) {
      if (generated) {
        const cleanup = await db.from('Tasks').delete().eq('TaskID', taskId).eq('UserID', owner);
        if (cleanup.error) throw new Error(`${error.message} The unregistered occurrence could not be removed: ${cleanup.error.message}`);
      }
      throw error;
    }
    if (!canonicalId) {
      if (generated) await result(db.from('Tasks').delete().eq('TaskID', taskId).eq('UserID', owner).select('TaskID'));
      await refreshAfterSave();
      throw new Error('This occurrence was deleted.');
    }
    if (canonicalId !== taskId) {
      if (generated) await result(db.from('Tasks').delete().eq('TaskID', taskId).eq('UserID', owner).select('TaskID'));
      taskId = canonicalId;
    }
    if (!registration?.taskId || registration.taskId !== canonicalId) await refreshAfterSave();
    const task = state.tasks.find(item => item.id === taskId);
    if (!task) throw new Error('The occurrence was saved but could not be loaded. Reload the page.');
    return task;
  }
  async function deleteTaskOccurrence(taskId, identity) {
    await result(db.rpc('coursewise_skip_task_occurrence', {
      p_series_id: identity.seriesId, p_occurrence_date: identity.date
    }));
    const task = state.tasks.find(item => item.id === taskId);
    const predecessor = state.tasks.find(item => item.spawned === taskId && item.id !== taskId);
    const successor = task?.spawned ? state.tasks.find(item => item.id === task.spawned) : null;
    const taskPattern = task?.repeat ? recurrencePattern(task.repeat) : null;
    const seriesTasks = task ? state.tasks.filter(item =>
      taskSeriesId(state.tasks, item) === identity.seriesId &&
      (!taskPattern || (item.repeat && recurrencePattern(item.repeat) === taskPattern))) : [];
    const seriesStart = seriesTasks.reduce((first, item) => {
      const start = asRule(item.repeat)?.seriesStart || item.due;
      return start && start < first ? start : first;
    }, task?.due || identity.date);
    const taskRule = task?.repeat ? asRule(task.repeat) : null;
    const unbounded = !!taskRule && (!taskRule.end || taskRule.end.type === 'never');
    const seriesTemplateRule = rule => {
      const { materialized, seriesPosition, ...template } = rule;
      return { ...template, seriesId: identity.seriesId, seriesStart };
    };
    const preserveSeriesAnchor = !!task && !successor && unbounded &&
      (!taskRule.end || taskRule.end.type === 'never');
    if (task && successor) {
      const successorRule = asRule(successor.repeat);
      if (successorRule) {
        await result(db.from('Tasks').update({ Repeating: JSON.stringify({
          ...(unbounded ? seriesTemplateRule(successorRule) : { ...successorRule, seriesId: identity.seriesId, seriesStart })
        }) }).eq('TaskID', successor.id).eq('UserID', owner).select('TaskID').single());
      }
      if (predecessor) {
        await result(db.from('Tasks').update({ SpawnedTaskID: successor.id })
          .eq('TaskID', predecessor.id).eq('UserID', owner).select('TaskID').single());
      }
    } else if (task && predecessor) {
      await result(db.from('Tasks').update({ SpawnedTaskID: null })
        .eq('TaskID', predecessor.id).eq('UserID', owner).select('TaskID').single());
    }
    if (preserveSeriesAnchor) {
      await result(db.from('Tasks').update({ Repeating: JSON.stringify({
        ...seriesTemplateRule(taskRule)
      }) }).eq('TaskID', taskId).eq('UserID', owner).select('TaskID').single());
    } else if (task) {
      await result(db.from('Tasks').delete().eq('TaskID', taskId).eq('UserID', owner).select('TaskID'));
    }
    await refreshAfterSave();
  }
  const Tidy = {
    toKey, shift, parseKey, fmtDate, fmtTime, timeFormat: () => timeFormat, esc, tones, themes: THEMES, repeats: REPEATS, repeatLabel, dayNames: DAYN, eventOccurrences, taskOccurrences, taskListItems,
    taskSortModes: TASK_SORT_MODES,
    sortTasks,
    get categories() { return state.categories; }, get state() { return state; },
    materializeTaskOccurrence,
    // One saved preference controls completed-task visibility on every page.
    visibleTasks: (tasks = state.tasks) =>
      tasks.filter(task => state.prefs.showDone || !task.done),
    cat: n => state.categories.find(c => c.id===n), init, reload: load,

    async login(email, password) {
      requireDb();

      const signed = await result(
        db.auth.signInWithPassword({ email, password })
      );

      // A new login should always check Canvas again.
      if (signed?.user?.id) {
        try {
          sessionStorage.removeItem(
            `cw-canvas-auto-check-${signed.user.id}`
          );
        } catch {
          // Browser storage may be disabled.
        }
      }
    },

    async signup(p,password) {
      requireDb(); return result(db.auth.signUp({ email:p.email, password, options:{
        emailRedirectTo: new URL('index.html',location.href).href,
        data:{ first_name:p.first,last_name:p.last,username:p.username }
      }}));
    },
    async logout() { requireDb(); await result(db.auth.signOut()); state=empty(); owner=null; authUser=null; },
    async resetPassword(email) { requireDb(); await result(db.auth.resetPasswordForEmail(email,{redirectTo:new URL('reset-password.html',location.href).href})); },
    async changePassword(password) { requireDb(); await result(db.auth.updateUser({password})); },
    async updateUser(p) {
      await write(db.from('User').update({FirstName:p.first,LastName:p.last,Username:p.username}).eq('UserID',owner).select('UserID').single());
    },
    async setIntroDone(done) {
      state.introDone = !!done;
      try {
        localStorage.setItem(introKey(''), done ? 'done' : 'open');
        if (!done) localStorage.removeItem(introKey('-skips'));
      } catch {}
      // Best effort, like Appearance: the device copy above keeps working if the column is missing.
      try { await db.from('Settings').update({ IntroDoneAt: done ? new Date().toISOString() : null }).eq('UserID', owner); } catch {}
    },
    introSkips() { try { return JSON.parse(localStorage.getItem(introKey('-skips')) || '[]'); } catch { return []; } },
    setIntroSkip(step, skipped) {
      const next = new Set(this.introSkips());
      skipped ? next.add(step) : next.delete(step);
      try { localStorage.setItem(introKey('-skips'), JSON.stringify([...next])); } catch {}
    },
    async setPrefs(p) {
      if ('defaultSortOrder' in p) {
        if (!validTaskSort(p.defaultSortOrder)) throw new Error('Choose a valid default sort order.');
        try { localStorage.setItem(defaultSortKey(), p.defaultSortOrder); } catch {}
        state.prefs.defaultSortOrder = p.defaultSortOrder;
      }
      if ('timeFormat' in p) {
        timeFormat = p.timeFormat === '24' ? '24' : '12';
        try { localStorage.setItem(TIME_KEY, timeFormat); } catch {}
        if (state.prefs) state.prefs.timeFormat = timeFormat;
        // Best effort: if the column is not set up yet, the choice still works on this device.
        try { await db.from('Settings').update({ TimeFormat: timeFormat }).eq('UserID', owner); } catch {}
      }
      
      const row = {};
      if ('theme' in p) row.ColorTheme = p.theme;
      if ('weekStart' in p) row.WeekStart = p.weekStart;
      if ('showDone' in p) row.ShowDone = p.showDone;
      if ('showGoose' in p) row.ShowGoose = !!p.showGoose;

      if (!Object.keys(row).length) return;
      await write(db.from('Settings').update(row).eq('UserID',owner).select('UserID').single());
      
      if ('showGoose' in p) {
        state.prefs.showGoose = !!p.showGoose;
        document.documentElement.dataset.goose =
          p.showGoose ? "on" : "off";
      }

    },
    async addCategory(name,tone) {
      const c=await result(db.from('Categories').insert({UserID:owner,DisplayName:name,DisplayColor:tone}).select('CategoryID').single());
      await refreshAfterSave(); return Tidy.cat(id(c.CategoryID));
    },
    async updateCategory(n,p) { await write(db.from('Categories').update({DisplayName:p.name,DisplayColor:p.tone}).eq('CategoryID',n).eq('UserID',owner).select('CategoryID').single()); },
    async deleteCategory(n) { await write(db.rpc('tidy_delete_category',{p_id:n})); },
    async addTask(p) {
      const {tasks,truncated}=recurrenceTasks(p), sortOrder=Math.max(-1,...state.tasks.filter(t=>t.listId===p.listId).map(t=>t.sortOrder))+1;
      await write(db.from('Tasks').insert(tasks.map((task,index)=>({...taskToRow(task),SortOrder:sortOrder+index,UserID:owner,IsComplete:false,IsAssignment:false}))));
      return {truncated};
    },
    async addEvent(p) {
      validateEventTimes(p);
      if (p.categoryId && !Tidy.cat(p.categoryId)) throw new Error('That category is no longer available. Reload the page and try again.');
      await write(db.from('coursewise_calendar_events').insert({
        auth_user_id: authUser.id, title: p.title, event_date: p.date,
        event_time: p.time || null, end_time: p.endTime || null, category_id: p.categoryId || null,
        repeat_rule: p.repeat ? (typeof p.repeat === 'string' ? PRESETS[p.repeat] : p.repeat) : null,
        reminder: p.reminder || null
      }));
    },
    async updateEvent(n,p) {
      validateEventTimes(p);
      if (p.categoryId && !Tidy.cat(p.categoryId)) throw new Error('That category is no longer available. Reload the page and try again.');
      await write(db.from('coursewise_calendar_events').update({
        title: p.title, event_date: p.date, event_time: p.time || null, end_time: p.endTime || null,
        category_id: p.categoryId || null,
        repeat_rule: p.repeat ? (typeof p.repeat === 'string' ? PRESETS[p.repeat] : p.repeat) : null,
        reminder: p.reminder || null
      }).eq('id',n).eq('auth_user_id',authUser.id).select('id').single());
    },
    async deleteEvent(n, scope = 'all', occurrenceDate) {
      const event = state.events.find(item => item.id === n);
      if (!event) throw new Error('Event not found. Reload the page.');
      const rule = asRule(event.repeat), recurring = !!rule;
      if (scope === 'this' && recurring) {
        const skipDates = [...new Set([...(rule.skipDates || []), occurrenceDate || event.date])];
        await write(db.from('coursewise_calendar_events').update({
          repeat_rule: { ...rule, skipDates }
        }).eq('id',n).eq('auth_user_id',authUser.id).select('id').single());
        return;
      }
      if (scope === 'following' && recurring) {
        const until = shiftKey(occurrenceDate || event.date, -1);
        const previous = eventOccurrences(event, event.date, until).filter(item => item.date === item.occurrenceDate);
        if (previous.length) {
          await write(db.from('coursewise_calendar_events').update({
            repeat_rule: { ...rule, end: { type: 'on', date: previous[previous.length - 1].date } }
          }).eq('id',n).eq('auth_user_id',authUser.id).select('id').single());
          return;
        }
      }
      await write(db.from('coursewise_calendar_events').delete().eq('id',n).eq('auth_user_id',authUser.id).select('id').single());
    },
    async updateTask(n,p) {
      const existing=state.tasks.find(t=>t.id===n), sameRepeat=!!existing&&existing.due===p.due&&JSON.stringify(existing.repeat)===JSON.stringify(p.repeat);
      const plan=existing?.occurrenceIdentity||existing?.spawned&&sameRepeat?{tasks:[{...p,repeat:existing.repeat}],truncated:false}:recurrenceTasks(p), tasks=plan.tasks, row=taskToRow(tasks[0]);
      let sortOrder=existing?.sortOrder ?? 0;
      if (existing && existing.listId!==p.listId) sortOrder=Math.max(-1,...state.tasks.filter(t=>t.listId===p.listId).map(t=>t.sortOrder))+1;
      row.SortOrder=sortOrder;
      if (existing?.spawned&&!sameRepeat&&!existing.occurrenceIdentity) {
        const descendants=[]; let childId=existing.spawned;
        while(childId&&!descendants.includes(childId)) {
          const child=state.tasks.find(t=>t.id===childId);
          if(!child) break;
          descendants.push(childId); childId=child.spawned;
        }
        if(descendants.length) await result(db.from('Tasks').delete().in('TaskID',descendants).eq('UserID',owner));
        row.SpawnedTaskID=null;
      }
      if (tasks.length > 1) {
        const nextOrder=Math.max(-1,...state.tasks.filter(t=>t.listId===p.listId).map(t=>t.sortOrder))+1;
        await result(db.from('Tasks').insert(tasks.slice(1).map((task,index)=>({...taskToRow(task),SortOrder:nextOrder+index,UserID:owner,IsComplete:false,IsAssignment:false}))));
      }
      await write(db.from('Tasks').update(row).eq('TaskID',n).eq('UserID',owner).select('TaskID').single());
      return {truncated:plan.truncated};
    },
    async reorderTasks(taskId,targetListId,targetTaskIds,sourceTaskIds) {
      await write(db.rpc('tidy_reorder_tasks',{
        p_task_id:taskId,
        p_target_list_id:targetListId,
        p_target_task_ids:targetTaskIds,
        p_source_task_ids:sourceTaskIds
      }));
    },
    async deleteTask(n, scope = 'this', occurrenceIdentity) {
      const task = state.tasks.find(item => item.id === n);
      if (!task) throw new Error('Task not found. Reload the page.');
      if (scope === 'this' && occurrenceIdentity) {
        const occurrence = await materializeTaskOccurrence(occurrenceIdentity.seriesId, occurrenceIdentity.date);
        await deleteTaskOccurrence(occurrence.id, occurrenceIdentity);
        return;
      }
      const identity = occurrenceIdentity || task.occurrenceIdentity;
      const target = identity ? { ...task, due: identity.date, occurrenceIdentity: identity } : task;
      const ids = taskDeletionIds(state.tasks, target, scope);

      const predecessor = state.tasks.find(item => item.spawned && ids.has(item.spawned) && !ids.has(item.id));
      if (predecessor) {
        const nextId = task.spawned && !ids.has(task.spawned) && state.tasks.some(item => item.id === task.spawned)
          ? task.spawned : null;
        await result(db.from('Tasks').update({SpawnedTaskID:nextId}).eq('TaskID',predecessor.id).eq('UserID',owner).select('TaskID').single());
      }
      if (scope === 'following' && identity) {
        const seriesTasks = state.tasks.filter(item => taskSeriesId(state.tasks, item) === identity.seriesId && !ids.has(item.id));
        const endDate = shiftKey(identity.date, -1);
        for (const item of seriesTasks) {
          if (!item.repeat || asRule(item.repeat).materialized) continue;
          await result(db.from('Tasks').update({
            Repeating: JSON.stringify({ ...asRule(item.repeat), seriesId: identity.seriesId, end: { type: 'on', date: endDate } })
          }).eq('TaskID', item.id).eq('UserID', owner).select('TaskID').single());
        }
      }
      await write(db.from('Tasks').delete().in('TaskID',[...ids]).eq('UserID',owner).select('TaskID'));
    },
    async deleteTasks(taskIds) {
      const ids = new Set(taskIds.map(String));
      if (!ids.size) return;
      const known = new Set(state.tasks.map(task => task.id));
      if ([...ids].some(taskId => !known.has(taskId))) throw new Error('Tasks have changed. Reload and select them again.');
      // Preserve links between surviving occurrences of a repeating task series.
      // Only selected TaskIDs are deleted; unlike series deletion, descendants remain.
      const byId = new Map(state.tasks.map(task => [task.id, task]));
      for (const task of state.tasks) {
        if (ids.has(task.id) || !ids.has(task.spawned)) continue;
        let next = task.spawned;
        const visited = new Set();
        while (next && ids.has(next) && !visited.has(next)) {
          visited.add(next);
          next = byId.get(next)?.spawned || null;
        }
        await result(db.from('Tasks').update({ SpawnedTaskID: next && !ids.has(next) ? next : null })
          .eq('TaskID', task.id).eq('UserID', owner).select('TaskID').single());
      }
      await write(db.from('Tasks').delete().in('TaskID', [...ids]).eq('UserID', owner).select('TaskID'));
    },
    async toggleTask(n, identity) {
      if (identity) {
        const occurrence = await materializeTaskOccurrence(identity.seriesId, identity.date);
        n = occurrence.id;
      }
      const t=state.tasks.find(t=>t.id===n); if (!t) throw new Error('Task not found. Reload the page.');
      let next, ended=false;
      if (!t.done && t.repeat && t.due && !asRule(t.repeat).materialized) {
        const rule=asRule(t.repeat), end=rule.end || {type:'never'}, occ=t.occ || 1;
        const candidate=nextDate(t.due,t.repeat);
        if ((end.type==='after' && occ>=end.count) || (end.type==='on' && end.date && candidate>end.date)) ended=true;
        else if (!t.spawned && !hasNextOccurrence(state.tasks,t,candidate)) next=candidate;
      }
      await write(db.rpc('tidy_toggle_task',{p_id:n,p_expected_done:t.done,p_next_due:next?dueStamp({...t,due:next}):null}));
      return {done:!t.done,next,ended};
    },
    async addList(title) {
      const order=Math.max(-1,...state.lists.map(l=>l.order))+1;
      const l=await result(db.from('Lists').insert({UserID:owner,Title:title,SortOrder:order}).select('ListID').single());
      await refreshAfterSave(); return state.lists.find(v=>v.id===id(l.ListID));
    },
    async reorderLists(listIds) { await write(db.rpc('tidy_reorder_lists',{p_list_ids:listIds})); },
    async renameList(n,title) { await write(db.rpc('tidy_rename_list',{p_id:n,p_title:title})); },
    async deleteList(n) { await write(db.from('Lists').delete().eq('ListID',n).eq('UserID',owner).select('ListID').single()); }
  };
  if (db) db.auth.onAuthStateChange((event, session) => {
    if (event==='SIGNED_OUT' || (authUser && session && session.user.id!==authUser.id)) {
      state=empty(); owner=null; authUser=null;
      if (!['login','signup','reset-password'].includes(document.body.dataset.page)) location.replace('index.html');
    }
  });
  window.Tidy=Tidy;
})();
