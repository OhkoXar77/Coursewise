# Coursewise Admin Portal

This local Node/Express app provides the IS 401 admin-only interface for the Coursewise `User` and `Tasks` tables. It is intentionally separate from the static student app in the parent folder.

## Local setup

1. Use Node.js 20 or newer.
2. Copy `.env.example` to `.env` in this folder.
3. Fill in the Coursewise Supabase project URL, publishable key, service-role key, and a long random `SESSION_SECRET`. The service-role key must remain server-side; never paste it into chat or commit `.env`.
4. In Supabase SQL Editor, run `../supabase/admin-setup.sql` if `public.coursewise_admins` does not already exist. Follow [ADMIN-SETUP.md](../ADMIN-SETUP.md) to grant the grading account administrator access.
5. From this folder, run `npm install`, then `npm start`.
6. Open `http://localhost:3000`.

Only accounts in `public.coursewise_admins` can use the user and record screens. The server verifies that allow-list on every request. User credentials are managed by Supabase Auth; the app never stores passwords in the `User` table.

## Included admin workflows

- **Maintain Users:** list, search, add, edit, and delete Coursewise profile/Auth accounts.
- **Maintain Records:** list, search, sort, add, edit, and delete task records in `public."Tasks"`.
- **Logout:** clears the signed, HTTP-only admin session cookie.

The app uses the existing Coursewise schema and the existing images in `../assets`. It does not modify the student-facing pages.

## Deployment

For Vercel, select this folder as the project root and configure the same four Supabase/session environment variables in the hosting environment. Never add a service-role key to browser JavaScript or a committed file. After deployment, verify the admin account, CRUD operations, and logout using the production URL.
