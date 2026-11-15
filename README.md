# Pulse — Keep-Alive & Uptime Monitoring Application

Pulse is a lightweight, open-source, serverless HTTP keep-alive and uptime monitoring application. It sends periodic HTTP requests to user-configured service endpoints to prevent free-hosted applications (such as Render, Fly.io, Railway, and Koyeb) from sleeping due to inactivity, while simultaneously capturing availability, latency measurements, and incident metrics.

---

## 1. Architecture Overview

Pulse is architected without a continuously running application backend server:

```
                  +--------------------------------------------------------+
                  |               GitHub Actions Scheduler                 |
                  |                (cron: '2/5 * * * *')                   |
                  +---------------------------+----------------------------+
                                              |
                                              v (Triggers every 5 mins)
                  +--------------------------------------------------------+
                  |                 Pulse Go Worker                        |
                  |  - Advisory Locking (anti-overlap)                     |
                  |  - Atomic DB check-claim (anti-burst)                  |
                  |  - SSRF protection & safe HTTP client                  |
                  |  - Latency measurement & single retry policy           |
                  +-------------+----------------------------+-------------+
                                |                            |
             (Probe Requests)   |                            | (Raw SQL via pgx)
                                v                            v
                  +-------------------------+  +---------------------------+
                  | Monitored HTTP Endpoints|  |   Supabase PostgreSQL     |
                  | (Render, Railway, etc.) |  |  - monitors, checks       |
                  +-------------------------+  |  - incidents, maintenance |
                                               |  - Row Level Security     |
                                               +-------------+-------------+
                                                             ^
                                                             | (Browser DB access
                                                             |  via Supabase JS)
                  +------------------------------------------+-------------+
                  |          Cloudflare Pages Static Frontend              |
                  |  (HTML, CSS, Vanilla JS, Monochromatic Vercel UI)      |
                  +--------------------------------------------------------+
```

1. **Scheduler**: GitHub Actions runs on a 5-minute cron offset (`2/5 * * * *`) on `ubuntu-latest`.
2. **Monitoring Engine**: A single compiled Go executable executes, claims due monitors from PostgreSQL using short atomic transactions (`FOR UPDATE SKIP LOCKED`), executes keep-alive probes, records checks and incident transitions, and terminates.
3. **Database**: Supabase PostgreSQL with raw SQL queries via `pgx/v5`. Row Level Security (RLS) restricts access to the authenticated owner. A dedicated least-privilege `pulse_worker` role is used by the Go runner.
4. **Dashboard**: Monochromatic, dark-mode static frontend hosted on Cloudflare Pages (from `web/`), interacting with Supabase via `@supabase/supabase-js`.

---

## 2. Fixed Technology Stack

| Component | Technology | Rationale |
|---|---|---|
| Monitoring engine | Go 1.26+ | Fast startup, zero server idle cost, safe concurrency |
| HTTP client | Go `net/http` | Custom `SafeDialer` with SSRF protection & anti-DNS-rebinding |
| PostgreSQL driver | `jackc/pgx/v5` | High performance connection pool and raw SQL |
| Database | Supabase PostgreSQL | Fully managed PostgreSQL with native Auth & RLS |
| Database queries | Raw SQL | Complete control over transactions and locking |
| Dashboard | HTML, CSS, Vanilla JS | Zero-dependency, lightweight, ultra-fast static web app |
| Authentication | Supabase Auth | Single-owner email/password auth; no public signups |
| Scheduler | GitHub Actions Cron | Serverless scheduled runner with repository secret protection |
| Frontend hosting | Cloudflare Pages | Global edge static file hosting from `web/` |

---

## 3. Security Considerations & SSRF Protection

Pulse implements multi-layered URL security in `internal/security/ssrf.go`:

- **Scheme Validation**: Only `http://` and `https://` URLs are accepted.
- **Credential Stripping**: Userinfo credentials (`user:pass@host`) are strictly forbidden.
- **SSRF Defense**: All hostnames are resolved before connection and checked against non-routable CIDRs:
  - Loopback (`127.0.0.0/8`, `::1`)
  - Private RFC 1918 (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`)
  - Link-Local & Cloud Metadata (`169.254.0.0/16`, `169.254.169.254`, `fe80::/10`)
  - Carrier-grade NAT (`100.64.0.0/10`)
  - Multicast and Reserved (`224.0.0.0/4`, `240.0.0.0/4`, `0.0.0.0/8`, `255.255.255.255`)
  - Unique Local IPv6 (`fc00::/7`)
  - Internal metadata domains (`metadata.google.internal`, `instance-data`, `localhost`)
- **DNS Rebinding Prevention**: `SafeDialer` resolves IP addresses, verifies that *all* returned IPs are public, and dials the validated IP directly while preserving the original hostname for SNI and TLS certificate verification.
- **Redirect Controls**: Redirects are validated at each hop and limited to a maximum of 3 hops.
- **Safe Body Consumption**: Responses read only up to 4 KB before closing to free the socket without buffering large response payloads into memory.

---

## 4. Setup Guide

### Step 1: Create a Supabase Project

1. Log in to [Supabase](https://supabase.com) and click **New project**.
2. Note down:
   - **Project URL** (e.g. `https://your-project.supabase.co`)
   - **Publishable / Anon API Key** (from Settings > API)
   - **Database Connection String** (from Settings > Database > Connection string > URI)

### Step 2: Apply Database Migrations

Open the **SQL Editor** in your Supabase dashboard and run the migrations in order:

1. **`migrations/001_init_schema.sql`**:
   Creates tables (`app_settings`, `monitors`, `checks`, `incidents`, `maintenance_windows`), indexes, and constraints.
2. **`migrations/002_rls_policies.sql`**:
   Enables Row Level Security (RLS) on all tables and restricts data access to authenticated users (`auth.uid() = user_id`).
3. **`migrations/003_worker_role.sql`**:
   Creates the dedicated `pulse_worker` role with least-privilege permissions and RLS access:
   ```sql
   -- Remember to replace the password in migrations/003_worker_role.sql before running:
   CREATE ROLE pulse_worker WITH LOGIN PASSWORD 'YOUR_SECURE_WORKER_PASSWORD' NOINHERIT;
   ```

### Step 3: Create the Owner Account

In the Supabase Dashboard:
1. Navigate to **Authentication** > **Users**.
2. Click **Add user** > **Create user**.
3. Enter your owner email and a secure password.
4. Auto-confirm the user (no email delivery or verification required).

### Step 4: Configure GitHub Secrets

In your GitHub repository:
1. Go to **Settings** > **Secrets and variables** > **Actions**.
2. Click **New repository secret**.
3. Create:
   - **`DATABASE_URL`**:
     ```
     postgresql://pulse_worker:YOUR_SECURE_WORKER_PASSWORD@db.your-project.supabase.co:5432/postgres?sslmode=require
     ```

### Step 5: Deploy Frontend to Cloudflare Pages

1. Log in to the [Cloudflare Dashboard](https://dash.cloudflare.com) and navigate to **Workers & Pages** > **Pages** > **Connect to Git**.
2. Select your `pulse-uptime` repository.
3. Build Settings:
   - **Framework preset**: None
   - **Build command**: *(leave empty)*
   - **Build output directory**: `web`
   - **Production branch**: `main`
4. Click **Save and Deploy**.
5. Once deployed, open your `pages.dev` URL.
6. On first visit:
   - Click **Config** on the sign-in modal.
   - Enter your Supabase Project URL and Anon Key (saved locally in your browser).
   - Sign in with your owner account.

---

## 5. Local Development and Execution

### Prerequisites
- Go 1.22+
- Access to Supabase PostgreSQL or a local Postgres instance

### Running Tests
Execute the full test suite with unit tests and race detection:

```bash
# Verify formatting
gofmt -l .

# Run static analysis
go vet ./...

# Run all unit tests
go test -v -count=1 ./...

# Build the executable
go build ./cmd/pulse
```

### Running the Worker Locally
Copy `.env.example` to `.env` and set `DATABASE_URL`:

```bash
# Set DATABASE_URL
export DATABASE_URL="postgresql://pulse_worker:YOUR_PASSWORD@db.your-project.supabase.co:5432/postgres?sslmode=require"

# Run a single monitoring probe cycle
go run ./cmd/pulse
```

### Previewing the Frontend Locally
Serve the `web/` directory using any static file server:

```bash
# Python
python3 -m http.server 8080 --directory web

# Node.js
npx serve web
```
Open `http://localhost:8080` in your browser.

---

## 6. How Keep-Alive & Monitoring Works

### Keep-Alive Responsibility
Every 5 minutes, GitHub Actions invokes Pulse. For each monitor due:
1. Pulse issues an HTTP `GET` request with a custom user agent `Pulse-KeepAlive-Monitor/1.0`.
2. Free hosts register this inbound HTTP traffic and reset their inactivity sleep timer.
3. Response headers are measured immediately for latency.
4. Response bodies are discarded (reading up to 4 KB) to avoid memory overhead.

### Availability & Incident Engine
- **Status Classification**:
  - `UP`: HTTP 2xx or 3xx received within degraded threshold.
  - `DEGRADED`: HTTP 2xx or 3xx received, but response time exceeds `degraded_threshold_ms` (default 1000ms).
  - `DOWN`: 4xx, 5xx, or network failure confirmed after bounded retry.
  - `MAINTENANCE`: Check executed during active maintenance window. Keeps keep-alive active while suppressing outage incidents.
  - `PAUSED`: User intentionally paused monitor. No probes are sent.
  - `UNKNOWN`: Monitor hasn't been checked beyond grace period (`interval * 2 + 10m`).
- **Single Retry Policy**:
  Transient 5xx errors (500, 502, 503, 504) or network errors trigger exactly one immediate retry after a 1.5s backoff. 4xx errors are not retried.
- **Incident Lifecycle**:
  - When confirmed DOWN outside maintenance: an incident is opened in `incidents` with root cause and HTTP code.
  - Database constraint `WHERE resolved_at IS NULL` ensures only **one** unresolved incident can exist per monitor.
  - When service recovers (UP or DEGRADED): the active incident is resolved, and `duration_seconds` is recorded.
- **Maintenance Windows**:
  - Can target fleet-wide or a specific monitor.
  - Keep-alive requests continue during maintenance.
  - Outage incidents are suppressed.
  - Maintenance duration is excluded from uptime calculations.

---

## 7. Limitations & Honest Scheduler Disclosure

- **GitHub Actions Scheduling**: GitHub Actions Cron is a best-effort queue, not a hard real-time scheduler. Execution may experience jitter (typically 1–3 minutes). Pulse’s database locking and `next_check_at` scheduling are designed to tolerate this gracefully without burst catch-ups.
- **Keep-Alive Target URLs**: Use genuine health endpoints or root application routes (e.g. `https://myapp.onrender.com/health`). Avoid using `/robots.txt` or routes that don't spin up your application container.

---

## 8. Troubleshooting

| Issue | Cause | Resolution |
|---|---|---|
| `DATABASE_URL environment variable is required` | Worker missing database credentials | Add `DATABASE_URL` to GitHub Secrets or local `.env`. |
| `Another runner instance is currently executing` | Previous worker still active | Advisory lock prevents overlap. The runner skips cleanly. |
| `Blocked by SSRF policy` | URL targets localhost, private IP, or metadata endpoint | Check that monitor URL points to a public FQDN or IP. |
| Supabase Auth `Invalid login credentials` | Incorrect owner email/password | Check User in Supabase Authentication dashboard. |
| `new row violates row-level security policy` | Authenticated user ID mismatch | Ensure user is signed in before creating monitors. |
