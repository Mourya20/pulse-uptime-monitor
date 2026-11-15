-- =============================================================================
-- Migration: 003_worker_role.sql
-- Description: Dedicated least-privilege PostgreSQL role for the Go monitoring worker
-- =============================================================================

-- 1. Create the dedicated worker role with login if it does not already exist
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'pulse_worker') THEN
        CREATE ROLE pulse_worker WITH LOGIN PASSWORD 'REPLACE_WITH_SECURE_PASSWORD' NOINHERIT;
    END IF;
END
$$;

-- 2. Grant schema usage
GRANT USAGE ON SCHEMA public TO pulse_worker;

-- 3. Grant strictly required table privileges
-- - monitors: SELECT to read due targets, UPDATE to set status and schedule timestamps
-- - checks: INSERT to write probe results, SELECT to read recent check stats if needed
-- - incidents: SELECT to check active outage, INSERT to open outage, UPDATE to resolve
-- - maintenance_windows: SELECT to evaluate active suppression windows
-- - app_settings: SELECT to read monitoring defaults
GRANT SELECT, UPDATE ON TABLE public.monitors TO pulse_worker;
GRANT SELECT, INSERT ON TABLE public.checks TO pulse_worker;
GRANT SELECT, INSERT, UPDATE ON TABLE public.incidents TO pulse_worker;
GRANT SELECT ON TABLE public.maintenance_windows TO pulse_worker;
GRANT SELECT ON TABLE public.app_settings TO pulse_worker;

-- 4. Worker Row Level Security (RLS) policies
-- Enables the worker role to access all records across the deployment without superuser privileges
DROP POLICY IF EXISTS "Worker monitors access" ON public.monitors;
CREATE POLICY "Worker monitors access"
    ON public.monitors FOR ALL
    TO pulse_worker
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "Worker checks access" ON public.checks;
CREATE POLICY "Worker checks access"
    ON public.checks FOR ALL
    TO pulse_worker
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "Worker incidents access" ON public.incidents;
CREATE POLICY "Worker incidents access"
    ON public.incidents FOR ALL
    TO pulse_worker
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "Worker maintenance access" ON public.maintenance_windows;
CREATE POLICY "Worker maintenance access"
    ON public.maintenance_windows FOR SELECT
    TO pulse_worker
    USING (true);

DROP POLICY IF EXISTS "Worker settings access" ON public.app_settings;
CREATE POLICY "Worker settings access"
    ON public.app_settings FOR SELECT
    TO pulse_worker
    USING (true);
