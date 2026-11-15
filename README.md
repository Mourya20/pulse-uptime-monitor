# Pulse — Keep-Alive & Uptime Monitor

A lightweight, serverless HTTP keep-alive and uptime monitoring system. It pings your endpoints periodically to prevent free-tier services (Render, Railway, Fly.io) from spinning down, while recording availability, latency curves, and outages.

🌐 **Live Dashboard:** [https://pulse-uptime-monitor.pages.dev/](https://pulse-uptime-monitor.pages.dev/)

---

## Recent Updates

- **Continuous Uptime Tracking**: Uptime timer runs continuously without resetting to 0s across successful checks.
- **Real-Time Live Telemetry**: 1-second live ticker for elapsed timestamps, countdowns to next probes, and auto keep-alive in active tabs.
- **Manual Instant Probing**: Interactive `⚡ Ping now` button to trigger immediate checks and measure latency on demand.
- **24h Data Simulation**: `Generate 24h data` button to populate hourly availability bars, response-time curves, and MTBF metrics.
- **Wrangler & Pages Deployment**: Zero-config deployment on Cloudflare Pages and Workers.

---

## How to Use the App

1. **Open the Dashboard**: Visit [https://pulse-uptime-monitor.pages.dev/](https://pulse-uptime-monitor.pages.dev/).
2. **Sign In**: Enter your owner email and password (credentials are authenticated via Supabase).
3. **Add a Monitor**: Click **New monitor**, enter your app name and URL (e.g. `https://vaultora-banking.onrender.com`), and select a check interval (e.g. 5m).
4. **Trigger Probes**:
   - Let GitHub Actions automatically probe your endpoint every 5 minutes 24/7.
   - Or click **⚡ Ping now** in the dashboard to execute an immediate keep-alive probe.
5. **Inspect Performance**: Click any monitor row to view live status, continuous uptime duration, 24-hour availability bars, and the interactive SVG response-time chart.
6. **Schedule Maintenance**: Use the **Maintenance** tab to suppress downtime alerts during planned deployments.

---

## How It Works (Architecture)

```
GitHub Actions (Cron) ➔ Go Worker ➔ Probes Targets ➔ Supabase DB ➔ Cloudflare Pages
```

GitHub Actions triggers the compiled Go worker every 5 minutes. The worker acquires PostgreSQL advisory locks, claims due monitors, and probes target URLs to keep free-tier services awake. Results and latency metrics are saved to Supabase PostgreSQL, and rendered in real time on the Cloudflare Pages static dashboard with zero idle server costs.

---

## Architecture & Tech Stack

| Layer | Technology | Purpose |
|---|---|---|
| **Monitoring Engine** | Go (`cmd/pulse`) | Fast CLI with anti-SSRF SafeDialer and PostgreSQL advisory locks |
| **Scheduler** | GitHub Actions | Serverless cron running every 5 minutes (`.github/workflows/monitor.yml`) |
| **Database** | Supabase PostgreSQL | Stores monitors, checks, and incidents with Row Level Security |
| **Frontend** | Vanilla JS / HTML / CSS | Monochromatic dark dashboard deployed on Cloudflare Pages (`web/`) |

---

## Setup & Cloud Configuration

### 1. Database (Supabase)
Run the SQL migration scripts in order via the Supabase SQL Editor:
- `migrations/001_init_schema.sql` (schema & constraints)
- `migrations/002_rls_policies.sql` (Row Level Security policies)

### 2. GitHub Actions Secrets
In your repository under **Settings > Secrets and variables > Actions**, add:
- **`DATABASE_URL`**:
  ```
  postgresql://postgres.<project_ref>:<password>@aws-0-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=require
  ```
  *(Note: If your database password contains special characters like `@`, URL-encode it as `%40`)*

### 3. Local Development (Optional)
```bash
# Run unit tests
go test -v ./...

# Run a local monitoring cycle
$env:DATABASE_URL="your_connection_string"
go run ./cmd/pulse
```
