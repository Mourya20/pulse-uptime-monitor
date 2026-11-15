-- =============================================================================
-- Migration: 001_init_schema.sql
-- Description: Core tables, constraints, and indexes for Pulse Keep-Alive & Uptime Monitor
-- =============================================================================

-- Ensure pgcrypto or uuid-ossp extension is enabled for UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. App Settings Table
-- Stores user-level dashboard preferences and monitoring defaults.
CREATE TABLE IF NOT EXISTS public.app_settings (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    default_interval_minutes INT NOT NULL DEFAULT 15 CHECK (default_interval_minutes BETWEEN 1 AND 1440),
    default_timeout_seconds INT NOT NULL DEFAULT 90 CHECK (default_timeout_seconds BETWEEN 5 AND 120),
    degraded_threshold_ms INT NOT NULL DEFAULT 1000 CHECK (degraded_threshold_ms >= 100),
    dashboard_timezone TEXT NOT NULL DEFAULT 'UTC',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Monitors Table
-- Stores user-configured endpoints for keep-alive probing and availability tracking.
CREATE TABLE IF NOT EXISTS public.monitors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (char_length(name) >= 1 AND char_length(name) <= 100),
    url TEXT NOT NULL CHECK (url ~* '^https?://'),
    interval_minutes INT NOT NULL DEFAULT 5 CHECK (interval_minutes BETWEEN 1 AND 1440),
    timeout_seconds INT NOT NULL DEFAULT 90 CHECK (timeout_seconds BETWEEN 5 AND 120),
    degraded_threshold_ms INT NOT NULL DEFAULT 1000 CHECK (degraded_threshold_ms >= 100),
    is_paused BOOLEAN NOT NULL DEFAULT false,
    current_status TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (current_status IN ('UP', 'DEGRADED', 'DOWN', 'PAUSED', 'MAINTENANCE', 'UNKNOWN')),
    last_checked_at TIMESTAMPTZ,
    next_check_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for efficient scheduling and user dashboard queries
CREATE INDEX IF NOT EXISTS idx_monitors_user_id ON public.monitors(user_id);
CREATE INDEX IF NOT EXISTS idx_monitors_due ON public.monitors(next_check_at) WHERE is_paused = false;

-- 3. Checks Table
-- Records every executed keep-alive HTTP probe and latency measurement.
CREATE TABLE IF NOT EXISTS public.checks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    monitor_id UUID NOT NULL REFERENCES public.monitors(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    status TEXT NOT NULL CHECK (status IN ('UP', 'DEGRADED', 'DOWN', 'MAINTENANCE')),
    status_code INT,
    response_time_ms INT NOT NULL CHECK (response_time_ms >= 0),
    error_message TEXT,
    is_retry BOOLEAN NOT NULL DEFAULT false
);

-- Indexes for historical graphs, strip calculation, and monitor detail view
CREATE INDEX IF NOT EXISTS idx_checks_monitor_checked_at ON public.checks(monitor_id, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_checks_user_checked_at ON public.checks(user_id, checked_at DESC);

-- 4. Incidents Table
-- Tracks outages, root cause, and recovery times.
CREATE TABLE IF NOT EXISTS public.incidents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    monitor_id UUID NOT NULL REFERENCES public.monitors(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ,
    duration_seconds INT CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
    root_cause TEXT NOT NULL,
    http_status INT,
    error_details TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Crucial: Ensure only one active (unresolved) incident can exist per monitor
CREATE UNIQUE INDEX IF NOT EXISTS unique_active_incident_per_monitor 
    ON public.incidents (monitor_id) 
    WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_incidents_user_started ON public.incidents(user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_incidents_monitor_started ON public.incidents(monitor_id, started_at DESC);

-- 5. Maintenance Windows Table
-- Scheduled periods where outage alerts are suppressed and keep-alive pings continue.
CREATE TABLE IF NOT EXISTS public.maintenance_windows (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    monitor_id UUID REFERENCES public.monitors(id) ON DELETE CASCADE, -- NULL indicates fleet-wide maintenance
    name TEXT NOT NULL CHECK (char_length(name) >= 1 AND char_length(name) <= 100),
    description TEXT,
    start_time TIMESTAMPTZ NOT NULL,
    end_time TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT check_end_after_start CHECK (end_time > start_time)
);

CREATE INDEX IF NOT EXISTS idx_maintenance_user_time ON public.maintenance_windows(user_id, start_time, end_time);
CREATE INDEX IF NOT EXISTS idx_maintenance_monitor_time ON public.maintenance_windows(monitor_id, start_time, end_time);
