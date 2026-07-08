# Claim Desk — Product Claim System (review prototype)

A working prototype of the product claim system: customer registration with
admin approval, claim events with coded product lists, stock-aware claiming,
waitlists, deposit tracking with unique payment references, staff roles
(Super Admin / Claim Administrator), settings, CSV export, and an audit log.

## Demo sign-ins

| Role | Email | PIN |
|---|---|---|
| Super Admin | `admin` | `1234` |
| Sample customer (pending approval) | `sam@example.com` | `1111` |

## Reviewing

This prototype stores data in your own browser (localStorage). Each reviewer
gets an independent sandbox: you can register, approve, claim, and manage
events freely without affecting anyone else. Clearing your browser data
resets the demo.

The production build replaces this with a shared database, real
authentication, and email notifications.

## Run locally

```bash
npm install
npm run dev
```

## Deployment

Pushing to the `main` branch automatically builds and publishes the site to
GitHub Pages via the workflow in `.github/workflows/deploy.yml`. In the
repository settings, set **Pages → Source** to **GitHub Actions** (one-time).

## Shared live data for the whole team (optional)

By default each reviewer's data lives in their own browser. To make one
shared live system for everyone with the URL:

1. Create a free project at supabase.com.
2. In the Supabase **SQL Editor**, run:

```sql
create table if not exists kv (key text primary key, value text);
alter table kv enable row level security;
create policy "demo read"   on kv for select using (true);
create policy "demo insert" on kv for insert with check (true);
create policy "demo update" on kv for update using (true);
```

3. In Supabase **Settings → API**, copy the **Project URL** and the
   **anon public** key into the `REMOTE` constant at the top of
   `src/App.jsx`, then commit the change — the site redeploys itself.

Note: this demo database is open to anyone who has the site URL, which is
fine for a private team review but not for real customers. The production
build replaces it with proper authentication and per-user permissions.
