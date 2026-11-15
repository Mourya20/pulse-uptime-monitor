-- =============================================================================
-- Migration: 002_rls_policies.sql
-- Description: Row Level Security (RLS) policies for authenticated dashboard users
-- =============================================================================

-- Enable Row Level Security on all tables
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.monitors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.maintenance_windows ENABLE ROW LEVEL SECURITY;

-- 1. App Settings Policies
DROP POLICY IF EXISTS "Users can view their own settings" ON public.app_settings;
CREATE POLICY "Users can view their own settings"
    ON public.app_settings FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert their own settings" ON public.app_settings;
CREATE POLICY "Users can insert their own settings"
    ON public.app_settings FOR INSERT
    TO authenticated
    WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their own settings" ON public.app_settings;
CREATE POLICY "Users can update their own settings"
    ON public.app_settings FOR UPDATE
    TO authenticated
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- 2. Monitors Policies
DROP POLICY IF EXISTS "Users can view their own monitors" ON public.monitors;
CREATE POLICY "Users can view their own monitors"
    ON public.monitors FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert their own monitors" ON public.monitors;
CREATE POLICY "Users can insert their own monitors"
    ON public.monitors FOR INSERT
    TO authenticated
    WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their own monitors" ON public.monitors;
CREATE POLICY "Users can update their own monitors"
    ON public.monitors FOR UPDATE
    TO authenticated
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete their own monitors" ON public.monitors;
CREATE POLICY "Users can delete their own monitors"
    ON public.monitors FOR DELETE
    TO authenticated
    USING (auth.uid() = user_id);

-- 3. Checks Policies
DROP POLICY IF EXISTS "Users can view checks for their monitors" ON public.checks;
CREATE POLICY "Users can view checks for their monitors"
    ON public.checks FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert checks for their monitors" ON public.checks;
CREATE POLICY "Users can insert checks for their monitors"
    ON public.checks FOR INSERT
    TO authenticated
    WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete checks for their monitors" ON public.checks;
CREATE POLICY "Users can delete checks for their monitors"
    ON public.checks FOR DELETE
    TO authenticated
    USING (auth.uid() = user_id);

-- 4. Incidents Policies
DROP POLICY IF EXISTS "Users can view their own incidents" ON public.incidents;
CREATE POLICY "Users can view their own incidents"
    ON public.incidents FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert their own incidents" ON public.incidents;
CREATE POLICY "Users can insert their own incidents"
    ON public.incidents FOR INSERT
    TO authenticated
    WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their own incidents" ON public.incidents;
CREATE POLICY "Users can update their own incidents"
    ON public.incidents FOR UPDATE
    TO authenticated
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- 5. Maintenance Windows Policies
DROP POLICY IF EXISTS "Users can view their maintenance windows" ON public.maintenance_windows;
CREATE POLICY "Users can view their maintenance windows"
    ON public.maintenance_windows FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can create maintenance windows" ON public.maintenance_windows;
CREATE POLICY "Users can create maintenance windows"
    ON public.maintenance_windows FOR INSERT
    TO authenticated
    WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their maintenance windows" ON public.maintenance_windows;
CREATE POLICY "Users can update their maintenance windows"
    ON public.maintenance_windows FOR UPDATE
    TO authenticated
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete their maintenance windows" ON public.maintenance_windows;
CREATE POLICY "Users can delete their maintenance windows"
    ON public.maintenance_windows FOR DELETE
    TO authenticated
    USING (auth.uid() = user_id);
