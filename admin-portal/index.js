require("dotenv").config();

const crypto = require("node:crypto");
const path = require("node:path");
const express = require("express");

const app = express();
const port = Number(process.env.PORT) || 3000;
const supabaseUrl = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const publishableKey =
  process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const sessionSecret = process.env.SESSION_SECRET || "";
const sessionCookie = "coursewise.admin.sid";
const csrfCookie = "coursewise.admin.csrf";
const sessionLifetimeMs = 8 * 60 * 60 * 1000;

if (
  (process.env.NODE_ENV === "production" || process.env.VERCEL === "1") &&
  !sessionSecret
) {
  throw new Error("Set SESSION_SECRET in the hosting environment before starting the admin portal.");
}

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.set("trust proxy", 1);
app.use((req, res, next) => {
  res.set({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data:; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; form-action 'self'; base-uri 'self'; frame-ancestors 'none'"
  });
  next();
});
app.use(express.urlencoded({ extended: false, limit: "32kb" }));
if (process.env.VERCEL !== "1") {
  app.use(express.static(path.join(__dirname, "public")));
  app.use("/images", express.static(path.join(__dirname, "..", "assets")));
}

function isProduction() {
  return (
    process.env.NODE_ENV === "production" ||
    process.env.VERCEL_ENV === "production" ||
    process.env.VERCEL_ENV === "preview"
  );
}

function cookieValue(req, name) {
  const pair = (req.headers.cookie || "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  if (!pair) return "";
  try {
    return decodeURIComponent(pair.slice(name.length + 1));
  } catch {
    return "";
  }
}

function cookieOptions(maxAge) {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction(),
    path: "/",
    maxAge
  };
}

function ensureCsrfCookie(req, res, next) {
  let token = cookieValue(req, csrfCookie);
  if (!/^[A-Za-z0-9_-]{40,50}$/.test(token)) {
    token = crypto.randomBytes(32).toString("base64url");
    res.cookie(csrfCookie, token, {
      ...cookieOptions(sessionLifetimeMs),
      httpOnly: false,
      sameSite: "strict"
    });
  }
  res.locals.csrfToken = token;
  next();
}

function validateCsrf(req, res, next) {
  if (req.method !== "POST") return next();
  const cookieToken = cookieValue(req, csrfCookie);
  const submittedToken = String(req.body._csrf || "");
  const cookieBuffer = Buffer.from(cookieToken);
  const submittedBuffer = Buffer.from(submittedToken);
  if (
    !cookieToken ||
    cookieBuffer.length !== submittedBuffer.length ||
    !crypto.timingSafeEqual(cookieBuffer, submittedBuffer)
  ) {
    return res.status(403).render("error", {
      title: "Request expired",
      message: "Refresh the page and submit the form again."
    });
  }
  next();
}

function requireConfiguration() {
  if (!supabaseUrl || !publishableKey || !serviceRoleKey || !sessionSecret) {
    throw new Error(
      "Supabase is not configured. Copy .env.example to .env and add the project URL, publishable key, server-only service-role key, and a long session secret."
    );
  }
}

function signPayload(payload) {
  return crypto
    .createHmac("sha256", sessionSecret)
    .update(payload)
    .digest("base64url");
}

function createAdminCookie(admin) {
  const payload = Buffer.from(
    JSON.stringify({
      id: admin.id,
      email: admin.email,
      expiresAt: Date.now() + sessionLifetimeMs
    })
  ).toString("base64url");
  return `${payload}.${signPayload(payload)}`;
}

function readAdminCookie(req) {
  if (!sessionSecret) return null;
  const token = cookieValue(req, sessionCookie);
  if (!token) return null;
  const separator = token.lastIndexOf(".");
  if (separator < 1) return null;

  try {
    const payload = token.slice(0, separator);
    const provided = Buffer.from(token.slice(separator + 1), "base64url");
    const expected = Buffer.from(signPayload(payload), "base64url");
    if (
      provided.length !== expected.length ||
      !crypto.timingSafeEqual(provided, expected)
    ) {
      return null;
    }

    const admin = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (
      typeof admin.id !== "string" ||
      typeof admin.email !== "string" ||
      !Number.isFinite(admin.expiresAt) ||
      admin.expiresAt <= Date.now()
    ) {
      return null;
    }
    return admin;
  } catch {
    return null;
  }
}

function clearAdminCookie(res) {
  res.clearCookie(sessionCookie, cookieOptions());
}

function redirectWithNotice(res, message, type = "success", destination = "/") {
  const query = new URLSearchParams({ notice: message, noticeType: type });
  const safeDestination = destination === "/users" || destination === "/records"
    ? destination
    : "/";
  return res.redirect(`${safeDestination}?${query.toString()}`);
}

function encoded(value) {
  return encodeURIComponent(String(value));
}

function apiErrorMessage(data) {
  return (
    data?.message ||
    data?.msg ||
    data?.error_description ||
    data?.details ||
    "Supabase request failed."
  );
}

async function supabaseRequest(pathname, options = {}) {
  requireConfiguration();
  const apiKey = options.apiKey || serviceRoleKey;
  const headers = {
    apikey: apiKey,
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json"
  };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.prefer) headers.Prefer = options.prefer;

  const response = await fetch(`${supabaseUrl}${pathname}`, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(15000)
  });
  const raw = await response.text();
  let data = null;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = raw;
    }
  }
  if (!response.ok) {
    const error = new Error(apiErrorMessage(data));
    error.status = response.status;
    throw error;
  }
  return data;
}

async function isCourseWiseAdmin(authUserId) {
  const rows = await supabaseRequest(
    `/rest/v1/coursewise_admins?select=user_id&user_id=eq.${encoded(authUserId)}&limit=1`
  );
  return Array.isArray(rows) && rows.length === 1;
}

async function listAdminIds() {
  const rows = await supabaseRequest(
    "/rest/v1/coursewise_admins?select=user_id&limit=1000"
  );
  if (!Array.isArray(rows)) throw new Error("Could not load administrator roles.");
  return new Set(rows.map((row) => String(row.user_id)));
}

async function listAuthUsers() {
  const users = [];
  for (let page = 1; page <= 100; page += 1) {
    const result = await supabaseRequest(
      `/auth/v1/admin/users?page=${page}&per_page=1000`
    );
    const pageUsers = Array.isArray(result?.users) ? result.users : [];
    users.push(...pageUsers);
    if (pageUsers.length < 1000) return users;
  }
  throw new Error("Too many accounts to list safely. Narrow the data set before continuing.");
}

async function listProfiles() {
  const [profiles, authUsers, adminIds] = await Promise.all([
    supabaseRequest(
      "/rest/v1/User?select=UserID,AuthUserID,FirstName,LastName,Username&order=FirstName.asc,LastName.asc"
    ),
    listAuthUsers(),
    listAdminIds()
  ]);
  const authById = new Map(authUsers.map((user) => [user.id, user]));
  return profiles.map((profile) => {
    const authUser = authById.get(profile.AuthUserID);
    return {
      ...profile,
      email: authUser?.email || "(no Auth account found)",
      hasAuthAccount: Boolean(authUser),
      isAdmin: adminIds.has(String(profile.AuthUserID))
    };
  });
}

async function getProfile(userId) {
  const profiles = await supabaseRequest(
    `/rest/v1/User?select=UserID,AuthUserID,FirstName,LastName,Username&UserID=eq.${encoded(userId)}&limit=1`
  );
  if (!Array.isArray(profiles) || !profiles.length) return null;

  const profile = profiles[0];
  if (!profile.AuthUserID) {
    return { ...profile, email: "", hasAuthAccount: false };
  }
  try {
    const result = await supabaseRequest(
      `/auth/v1/admin/users/${encoded(profile.AuthUserID)}`
    );
    const authUser = result.user || result.data?.user || result;
    return { ...profile, email: authUser.email || "", hasAuthAccount: true };
  } catch (error) {
    if (error.status === 404) {
      return { ...profile, email: "", hasAuthAccount: false };
    }
    throw error;
  }
}

async function getRecord(recordId) {
  const rows = await supabaseRequest(
    `/rest/v1/Tasks?select=TaskID,UserID,Name,TaskDueDate,IsComplete&TaskID=eq.${encoded(recordId)}&limit=1`
  );
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function getProfileChoices() {
  return supabaseRequest(
    "/rest/v1/User?select=UserID,FirstName,LastName,Username&order=FirstName.asc,LastName.asc"
  );
}

function requiredText(value, label, maxLength) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${label} is required.`);
  if (text.length > maxLength) {
    throw new Error(`${label} must be ${maxLength} characters or fewer.`);
  }
  return text;
}

function validEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Enter a valid email address.");
  }
  return email;
}

function validDate(value) {
  const date = String(value || "").trim();
  if (!date) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("Enter a valid due date.");
  }
  const parsed = new Date(`${date}T12:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error("Enter a valid due date.");
  }
  return `${date}T12:00:00.000Z`;
}

function formatDueDate(value) {
  if (!value) return "No due date";
  const date = new Date(`${String(value).slice(0, 10)}T12:00:00`);
  return Number.isNaN(date.getTime()) ? String(value).slice(0, 10) : date.toLocaleDateString();
}

function dateForInput(value) {
  return value ? String(value).slice(0, 10) : "";
}

function requireLogin(req, res, next) {
  if (req.admin) return next();
  if (req.adminCheckError) {
    return renderError(res, req.adminCheckError, "Could not verify admin access");
  }
  clearAdminCookie(res);
  return redirectWithNotice(res, "Sign in with a Coursewise administrator account.", "error");
}

function renderError(res, error, title = "Something went wrong") {
  console.error(error);
  const status =
    Number.isInteger(error.status) && error.status >= 400 && error.status < 500
      ? error.status
      : 500;
  return res.status(status).render("error", {
    title,
    message: error.message || "The request could not be completed. Check your configuration and try again."
  });
}

app.use(ensureCsrfCookie);
app.use(async (req, res, next) => {
  req.admin = readAdminCookie(req);
  req.adminCheckError = null;
  const hasSessionCookie = Boolean(cookieValue(req, sessionCookie));
  if (hasSessionCookie && !req.admin) clearAdminCookie(res);

  if (req.admin) {
    try {
      if (!(await isCourseWiseAdmin(req.admin.id))) {
        req.admin = null;
        clearAdminCookie(res);
      }
    } catch (error) {
      req.admin = null;
      req.adminCheckError = error;
    }
  }

  res.locals.loggedIn = Boolean(req.admin);
  res.locals.adminEmail = req.admin?.email || "";
  res.locals.adminId = req.admin?.id || "";
  res.locals.notice = String(req.query.notice || "");
  res.locals.noticeType = req.query.noticeType === "error" ? "error" : "success";
  res.locals.configurationReady = Boolean(
    supabaseUrl && publishableKey && serviceRoleKey && sessionSecret
  );
  next();
});
app.use(validateCsrf);

app.get("/", (req, res) => {
  if (req.adminCheckError) {
    res.locals.notice = "Could not verify administrator access. Check the Supabase configuration and try again.";
    res.locals.noticeType = "error";
  }
  res.render("index");
});

app.post("/login", async (req, res) => {
  try {
    requireConfiguration();
    const email = validEmail(req.body.user_email);
    const password = String(req.body.user_password || "");
    if (!password) throw new Error("Enter your password.");
    const signedIn = await supabaseRequest("/auth/v1/token?grant_type=password", {
      method: "POST",
      apiKey: publishableKey,
      body: { email, password }
    });
    if (!signedIn?.user?.id || !signedIn.user.email) {
      throw new Error("Supabase did not return a valid sign-in session.");
    }
    if (!(await isCourseWiseAdmin(signedIn.user.id))) {
      clearAdminCookie(res);
      return redirectWithNotice(res, "This account does not have administrator access.", "error");
    }
    res.cookie(
      sessionCookie,
      createAdminCookie({ id: signedIn.user.id, email: signedIn.user.email }),
      cookieOptions(sessionLifetimeMs)
    );
    return redirectWithNotice(res, "You are signed in.");
  } catch (error) {
    const message =
      error.status === 400 || error.status === 401
        ? "Email or password was not accepted."
        : error.message;
    return redirectWithNotice(res, message || "Sign-in failed.", "error");
  }
});

app.post("/logout", requireLogin, (req, res) => {
  clearAdminCookie(res);
  return redirectWithNotice(res, "You are signed out.");
});

app.get("/users", requireLogin, async (req, res) => {
  try {
    const users = await listProfiles();
    res.render("users", { users });
  } catch (error) {
    renderError(res, error, "Could not load users");
  }
});

app.get("/users/new", requireLogin, (req, res) => {
  res.render("user-form", {
    user: null,
    formAction: "/users",
    pageTitle: "Add user"
  });
});

app.post("/users", requireLogin, async (req, res) => {
  let createdAuthId = null;
  try {
    const email = validEmail(req.body.user_email);
    const password = String(req.body.user_password || "");
    const firstName = requiredText(req.body.first_name, "First name", 100);
    const lastName = requiredText(req.body.last_name, "Last name", 100);
    const username = requiredText(req.body.username, "Username", 50);
    if (password.length < 8) throw new Error("Password must be at least 8 characters.");
    if (password.length > 72) throw new Error("Password must be 72 characters or fewer.");

    const created = await supabaseRequest("/auth/v1/admin/users", {
      method: "POST",
      body: {
        email,
        password,
        email_confirm: true,
        user_metadata: { first_name: firstName, last_name: lastName, username }
      }
    });
    createdAuthId = created.id;
    if (!createdAuthId) throw new Error("Supabase did not return the new account ID.");

    const existing = await supabaseRequest(
      `/rest/v1/User?select=UserID&AuthUserID=eq.${encoded(createdAuthId)}&limit=1`
    );
    if (Array.isArray(existing) && existing.length) {
      await supabaseRequest(`/rest/v1/User?UserID=eq.${encoded(existing[0].UserID)}`, {
        method: "PATCH",
        body: { FirstName: firstName, LastName: lastName, Username: username },
        prefer: "return=minimal"
      });
    } else {
      await supabaseRequest("/rest/v1/User", {
        method: "POST",
        body: [{ AuthUserID: createdAuthId, FirstName: firstName, LastName: lastName, Username: username }],
        prefer: "return=minimal"
      });
    }
    return redirectWithNotice(res, "User added.", "success", "/users");
  } catch (error) {
    if (createdAuthId) {
      try {
        await supabaseRequest(`/auth/v1/admin/users/${encoded(createdAuthId)}`, {
          method: "DELETE"
        });
      } catch (cleanupError) {
        console.error("Could not roll back the new Auth user after profile creation failed.", cleanupError);
      }
    }
    return renderError(res, error, "Could not add user");
  }
});

app.get("/users/:id/edit", requireLogin, async (req, res) => {
  try {
    const user = await getProfile(req.params.id);
    if (!user) {
      return res.status(404).render("error", {
        title: "User not found",
        message: "That profile could not be found."
      });
    }
    res.render("user-form", {
      user,
      formAction: `/users/${encoded(user.UserID)}/edit`,
      pageTitle: "Edit user"
    });
  } catch (error) {
    renderError(res, error, "Could not load user");
  }
});

app.post("/users/:id/edit", requireLogin, async (req, res) => {
  try {
    const user = await getProfile(req.params.id);
    if (!user) {
      return res.status(404).render("error", {
        title: "User not found",
        message: "That profile could not be found."
      });
    }
    if (!user.hasAuthAccount) {
      throw new Error("This profile has no matching Supabase Auth account; remove the stale profile and create a linked user.");
    }

    const email = validEmail(req.body.user_email);
    const password = String(req.body.user_password || "");
    const firstName = requiredText(req.body.first_name, "First name", 100);
    const lastName = requiredText(req.body.last_name, "Last name", 100);
    const username = requiredText(req.body.username, "Username", 50);
    if (password && password.length < 8) throw new Error("A new password must be at least 8 characters.");
    if (password.length > 72) throw new Error("Password must be 72 characters or fewer.");

    await supabaseRequest(`/rest/v1/User?UserID=eq.${encoded(user.UserID)}`, {
      method: "PATCH",
      body: { FirstName: firstName, LastName: lastName, Username: username },
      prefer: "return=minimal"
    });
    const authUpdate = {
      email,
      email_confirm: true,
      user_metadata: { first_name: firstName, last_name: lastName, username }
    };
    if (password) authUpdate.password = password;
    try {
      await supabaseRequest(`/auth/v1/admin/users/${encoded(user.AuthUserID)}`, {
        method: "PUT",
        body: authUpdate
      });
    } catch (error) {
      try {
        await supabaseRequest(`/rest/v1/User?UserID=eq.${encoded(user.UserID)}`, {
          method: "PATCH",
          body: {
            FirstName: user.FirstName,
            LastName: user.LastName,
            Username: user.Username
          },
          prefer: "return=minimal"
        });
      } catch (rollbackError) {
        console.error("Could not restore the profile after Auth update failed.", rollbackError);
      }
      throw error;
    }
    return redirectWithNotice(res, "User changes saved.", "success", "/users");
  } catch (error) {
    return renderError(res, error, "Could not update user");
  }
});

app.post("/users/:id/admin-role", requireLogin, async (req, res) => {
  try {
    const user = await getProfile(req.params.id);
    if (!user) {
      return res.status(404).render("error", {
        title: "User not found",
        message: "That profile could not be found."
      });
    }
    if (!user.hasAuthAccount || !user.AuthUserID) {
      throw new Error("This profile has no matching Supabase Auth account and cannot be assigned an admin role.");
    }
    if (user.AuthUserID === req.admin.id) {
      throw new Error("You cannot change your own administrator access.");
    }

    const action = String(req.body.admin_action || "");
    if (action === "grant") {
      await supabaseRequest(
        "/rest/v1/coursewise_admins?on_conflict=user_id",
        {
          method: "POST",
          body: [{ user_id: user.AuthUserID }],
          prefer: "resolution=merge-duplicates,return=minimal"
        }
      );
      return redirectWithNotice(res, `Administrator access granted to ${user.email}.`, "success", "/users");
    }
    if (action === "revoke") {
      await supabaseRequest(
        `/rest/v1/coursewise_admins?user_id=eq.${encoded(user.AuthUserID)}`,
        { method: "DELETE", prefer: "return=minimal" }
      );
      return redirectWithNotice(res, `Administrator access removed from ${user.email}.`, "success", "/users");
    }
    const error = new Error("Choose whether to grant or remove administrator access.");
    error.status = 400;
    throw error;
  } catch (error) {
    return renderError(res, error, "Could not change administrator access");
  }
});

app.post("/users/:id/delete", requireLogin, async (req, res) => {
  try {
    const user = await getProfile(req.params.id);
    if (!user) {
      return res.status(404).render("error", {
        title: "User not found",
        message: "That profile could not be found."
      });
    }
    if (user.AuthUserID === req.admin.id) {
      throw new Error("You cannot delete the administrator account you are currently using.");
    }
    if (user.hasAuthAccount) {
      await supabaseRequest(`/auth/v1/admin/users/${encoded(user.AuthUserID)}`, {
        method: "DELETE"
      });
    }
    await supabaseRequest(`/rest/v1/User?UserID=eq.${encoded(user.UserID)}`, {
      method: "DELETE",
      prefer: "return=minimal"
    });
    return redirectWithNotice(res, "User deleted.", "success", "/users");
  } catch (error) {
    return renderError(res, error, "Could not delete user");
  }
});

app.get("/records", requireLogin, async (req, res) => {
  try {
    const [records, users] = await Promise.all([
      supabaseRequest(
        "/rest/v1/Tasks?select=TaskID,UserID,Name,TaskDueDate,IsComplete&order=TaskDueDate.asc.nullslast,TaskID.asc"
      ),
      getProfileChoices()
    ]);
    const names = new Map(
      users.map((user) => [
        String(user.UserID),
        `${user.FirstName || ""} ${user.LastName || ""}`.trim() ||
          user.Username ||
          "Coursewise user"
      ])
    );
    res.render("records", { records, names, formatDueDate });
  } catch (error) {
    renderError(res, error, "Could not load records");
  }
});

app.get("/records/new", requireLogin, async (req, res) => {
  try {
    const users = await getProfileChoices();
    res.render("record-form", {
      record: null,
      users,
      formAction: "/records",
      pageTitle: "Add record",
      dateForInput
    });
  } catch (error) {
    renderError(res, error, "Could not open record form");
  }
});

app.post("/records", requireLogin, async (req, res) => {
  try {
    const name = requiredText(req.body.name, "Record name", 300);
    const userId = requiredText(req.body.user_id, "User", 100);
    const dueDate = validDate(req.body.due_date);
    const users = await supabaseRequest(
      `/rest/v1/User?select=UserID&UserID=eq.${encoded(userId)}&limit=1`
    );
    if (!Array.isArray(users) || !users.length) throw new Error("Choose an existing user.");

    await supabaseRequest("/rest/v1/Tasks", {
      method: "POST",
      body: [{
        Name: name,
        UserID: userId,
        TaskDueDate: dueDate,
        HasDueTime: false,
        IsComplete: req.body.is_complete === "on",
        IsAssignment: false
      }],
      prefer: "return=minimal"
    });
    return redirectWithNotice(res, "Record added.", "success", "/records");
  } catch (error) {
    return renderError(res, error, "Could not add record");
  }
});

app.get("/records/:id/edit", requireLogin, async (req, res) => {
  try {
    const [record, users] = await Promise.all([
      getRecord(req.params.id),
      getProfileChoices()
    ]);
    if (!record) {
      return res.status(404).render("error", {
        title: "Record not found",
        message: "That task record could not be found."
      });
    }
    res.render("record-form", {
      record,
      users,
      formAction: `/records/${encoded(record.TaskID)}/edit`,
      pageTitle: "Edit record",
      dateForInput
    });
  } catch (error) {
    renderError(res, error, "Could not load record");
  }
});

app.post("/records/:id/edit", requireLogin, async (req, res) => {
  try {
    const current = await getRecord(req.params.id);
    if (!current) {
      return res.status(404).render("error", {
        title: "Record not found",
        message: "That task record could not be found."
      });
    }
    const name = requiredText(req.body.name, "Record name", 300);
    const userId = requiredText(req.body.user_id, "User", 100);
    const dueDate = validDate(req.body.due_date);
    const users = await supabaseRequest(
      `/rest/v1/User?select=UserID&UserID=eq.${encoded(userId)}&limit=1`
    );
    if (!Array.isArray(users) || !users.length) throw new Error("Choose an existing user.");

    await supabaseRequest(`/rest/v1/Tasks?TaskID=eq.${encoded(current.TaskID)}`, {
      method: "PATCH",
      body: {
        Name: name,
        UserID: userId,
        TaskDueDate: dueDate,
        HasDueTime: false,
        IsComplete: req.body.is_complete === "on"
      },
      prefer: "return=minimal"
    });
    return redirectWithNotice(res, "Record changes saved.", "success", "/records");
  } catch (error) {
    return renderError(res, error, "Could not update record");
  }
});

app.post("/records/:id/delete", requireLogin, async (req, res) => {
  try {
    const current = await getRecord(req.params.id);
    if (!current) {
      return res.status(404).render("error", {
        title: "Record not found",
        message: "That task record could not be found."
      });
    }
    await supabaseRequest(`/rest/v1/Tasks?TaskID=eq.${encoded(current.TaskID)}`, {
      method: "DELETE",
      prefer: "return=minimal"
    });
    return redirectWithNotice(res, "Record deleted.", "success", "/records");
  } catch (error) {
    return renderError(res, error, "Could not delete record");
  }
});

app.use((req, res) => {
  res.status(404).render("error", {
    title: "Page not found",
    message: "That page does not exist."
  });
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  return renderError(res, error);
});

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Coursewise Admin is running at http://localhost:${port}`);
  });
}

module.exports = app;
