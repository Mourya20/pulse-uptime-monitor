-- =============================================================================
-- Migration: 005_enforce_min_interval.sql
-- Description: Align check intervals to 5 minutes minimum and enforce 5-minute defaults
-- =============================================================================

-- 1. Enforce minimum 5 minutes on monitors table
ALTER TABLE public.monitors DROP CONSTRAINT IF EXISTS monitors_interval_minutes_check;
ALTER TABLE public.monitors ADD CONSTRAINT monitors_interval_minutes_check 
    CHECK (interval_minutes >= 5 AND interval_minutes <= 1440);
ALTER TABLE public.monitors ALTER COLUMN interval_minutes SET DEFAULT 5;

-- Update any existing monitors that had sub-5m intervals
UPDATE public.monitors SET interval_minutes = 5 WHERE interval_minutes < 5;

-- 2. Enforce minimum 5 minutes on app_settings table
ALTER TABLE public.app_settings DROP CONSTRAINT IF EXISTS app_settings_default_interval_minutes_check;
ALTER TABLE public.app_settings ADD CONSTRAINT app_settings_default_interval_minutes_check 
    CHECK (default_interval_minutes >= 5 AND default_interval_minutes <= 1440);
ALTER TABLE public.app_settings ALTER COLUMN default_interval_minutes SET DEFAULT 5;

UPDATE public.app_settings SET default_interval_minutes = 5 WHERE default_interval_minutes < 5;
