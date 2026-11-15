-- =============================================================================
-- Migration: 004_flexible_intervals.sql
-- Description: Allow flexible check intervals (1 minute to 1440 minutes / 24 hours)
-- =============================================================================

ALTER TABLE public.monitors DROP CONSTRAINT IF EXISTS monitors_interval_minutes_check;
ALTER TABLE public.monitors ADD CONSTRAINT monitors_interval_minutes_check 
    CHECK (interval_minutes >= 1 AND interval_minutes <= 1440);

ALTER TABLE public.app_settings DROP CONSTRAINT IF EXISTS app_settings_default_interval_minutes_check;
ALTER TABLE public.app_settings ADD CONSTRAINT app_settings_default_interval_minutes_check 
    CHECK (default_interval_minutes >= 1 AND default_interval_minutes <= 1440);
