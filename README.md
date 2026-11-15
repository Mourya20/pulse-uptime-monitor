# Pulse — Keep-Alive & Uptime Monitor

A lightweight, serverless HTTP keep-alive and uptime monitoring system. It pings your endpoints periodically to prevent free-tier services (Render, Railway, Fly.io) from spinning down, while recording availability, latency curves, and outages.

🌐 **Live Dashboard:** [https://pulse-uptime-monitor.pages.dev/](https://pulse-uptime-monitor.pages.dev/)

---

## Key Features

- **Single Source of Truth**: Keep-alive probes and check metrics are executed exclusively by the compiled Go worker running in GitHub Actions. The web frontend is purely read-only for monitoring telemetry.
- **Duration-Weighted Uptime**: Accurate availability calculations that properly account for maintenance windows (no double counting), outage incidents, and unobserved/unknown periods.
- **Stale Detection**: Monitors that have not received a check within their grace period (`interval * 2 + 10 minutes`) are automatically classified and rendered as `UNKNOWN`.
- **Bounded Claiming & Execution**: Monitors are processed in bounded batches without premature schedule advancement, ensuring unprocessed monitors remain due if runners time out.
- **SSRF Protection**: Custom Go HTTP client with anti-SSRF address resolution and DNS rebinding protections.
- **Zero Server Costs**: Deployed statically on Cloudflare Pages with Supabase PostgreSQL and GitHub Actions scheduled execution.

---

## How to Use the App

1. **Open the Dashboard**: Visit [https://pulse-uptime-monitor.pages.dev/](https://pulse-uptime-monitor.pages.dev/) (or your self-hosted deployment).
2. **Sign In**: Enter your owner email and password (authenticated via Supabase).
3. **Add a Monitor**: Click **New monitor**, enter your app name and URL (e.g. `https://vaultora-banking.onrender.com`), and select a check interval (minimum 5m).
4. **Probing**: GitHub Actions probes your endpoints on a 5-minute schedule. Probes and latency metrics stream to the dashboard automatically.
5. **Inspect Performance**: Click any monitor row to view live status, duration-weighted uptime, 24-hour strip, and the interactive SVG response-time chart.
6. **Schedule Maintenance**: Use the **Maintenance** tab to suppress downtime alerts during planned deployments.

---

## How It Works (Architecture)

```
GitHub Actions (Cron) ➔ Go Worker ➔ Probes Targets ➔ Supabase DB ➔ Cloudflare Pages
```

GitHub Actions triggers the compiled Go worker every 5 minutes. The worker acquires PostgreSQL advisory locks, marks stale targets as `UNKNOWN`, claims due monitors in bounded batches, and probes target URLs to keep free-tier services awake. Results and latency metrics are saved to Supabase PostgreSQL, and rendered in real time on the Cloudflare Pages static dashboard.

---

## Architecture & Tech Stack

| Layer | Technology | Purpose |
|---|---|---|
| **Monitoring Engine** | Go 1.23+ (`cmd/pulse`) | Fast CLI with anti-SSRF SafeDialer and PostgreSQL advisory locks |
| **Scheduler** | GitHub Actions | Serverless cron running every 5 minutes (`.github/workflows/monitor.yml`) |
| **Database** | Supabase PostgreSQL | Stores monitors, checks, and incidents with Row Level Security |
| **Frontend** | Vanilla JS / HTML / CSS | Monochromatic dark dashboard deployed on Cloudflare Pages (`web/`) |

---

## Setup & Cloud Configuration

### 1. Database (Supabase)
Run the SQL migration scripts in order via the Supabase SQL Editor:
- `migrations/001_init_schema.sql` (Core schema, default 5m intervals, and constraints)
- `migrations/002_rls_policies.sql` (Row Level Security policies)
- `migrations/003_worker_role.sql` (Dedicated least-privilege `pulse_worker` role)
- `migrations/005_enforce_min_interval.sql` (Aligns intervals to 5m minimum)

To assign a secure password to the dedicated worker role without committing credentials:
```sql
ALTER ROLE pulse_worker WITH LOGIN PASSWORD '<your-generated-strong-password>';
```

### 2. GitHub Actions Secrets
In your repository under **Settings > Secrets and variables > Actions**, add:
- **`DATABASE_URL`**:
  ```
  postgresql://pulse_worker:<your-worker-password>@aws-0-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=require
  ```
  *(Note: If your database password contains special characters like `@`, URL-encode it as `%40`)*

### 3. Local Development & Testing
```bash
# Run automated tests
go test -v ./...

# Build the executable
go build -v -o bin/pulse ./cmd/pulse

# Execute a local monitoring cycle
$env:DATABASE_URL="your_connection_string"
go run ./cmd/pulse
```

---

## License

This project is open-source and available under the [MIT License](LICENSE).
