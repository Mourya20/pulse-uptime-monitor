package stats

import (
	"testing"
	"time"

	"github.com/Mourya20/pulse-uptime-monitor/internal/model"
)

func TestCalculateAvailability_ZeroIncidents(t *testing.T) {
	now := time.Now()
	windowStart := now.Add(-24 * time.Hour)
	windowEnd := now

	checks := []model.Check{
		{Status: model.StatusUp, ResponseTimeMs: 100},
		{Status: model.StatusUp, ResponseTimeMs: 200},
		{Status: model.StatusDegraded, ResponseTimeMs: 1200},
	}

	st := CalculateAvailability(windowStart, windowEnd, nil, nil, checks)

	if st.UptimePercentage != 100.0 {
		t.Errorf("expected 100%% uptime, got %.3f%%", st.UptimePercentage)
	}
	if st.IncidentCount != 0 {
		t.Errorf("expected 0 incidents, got %d", st.IncidentCount)
	}
	if st.TotalDownTime != 0 {
		t.Errorf("expected 0 downtime, got %v", st.TotalDownTime)
	}
	if st.MTBFHours != -1 {
		t.Errorf("expected MTBF -1, got %.2f", st.MTBFHours)
	}
	if st.AvgLatencyMs != 500 { // (100 + 200 + 1200) / 3 = 500
		t.Errorf("expected AvgLatency 500ms, got %dms", st.AvgLatencyMs)
	}
	if st.MinLatencyMs != 100 {
		t.Errorf("expected MinLatency 100ms, got %dms", st.MinLatencyMs)
	}
	if st.MaxLatencyMs != 1200 {
		t.Errorf("expected MaxLatency 1200ms, got %dms", st.MaxLatencyMs)
	}
}

func TestCalculateAvailability_WithIncidents(t *testing.T) {
	now := time.Date(2026, 11, 15, 12, 0, 0, 0, time.UTC)
	windowStart := now.Add(-24 * time.Hour) // 24 hours total = 1440 minutes
	windowEnd := now

	// Incident 1: 1 hour outage (10:00 to 11:00) = 60 minutes
	inc1Start := now.Add(-2 * time.Hour)
	inc1End := now.Add(-1 * time.Hour)

	incidents := []model.Incident{
		{
			StartedAt:  inc1Start,
			ResolvedAt: &inc1End,
		},
	}

	st := CalculateAvailability(windowStart, windowEnd, incidents, nil, nil)

	if st.IncidentCount != 1 {
		t.Errorf("expected 1 incident, got %d", st.IncidentCount)
	}
	if st.TotalDownTime != 1*time.Hour {
		t.Errorf("expected 1h downtime, got %v", st.TotalDownTime)
	}

	// 23h up / 24h total = 95.833%
	expectedPct := (23.0 / 24.0) * 100.0
	diff := st.UptimePercentage - expectedPct
	if diff < -0.01 || diff > 0.01 {
		t.Errorf("expected ~95.833%%, got %.3f%%", st.UptimePercentage)
	}
	if st.MTBFHours != 23.0 {
		t.Errorf("expected MTBF 23h, got %.2f", st.MTBFHours)
	}
}

func TestCalculateAvailability_MaintenanceExclusion(t *testing.T) {
	now := time.Date(2026, 11, 15, 12, 0, 0, 0, time.UTC)
	windowStart := now.Add(-24 * time.Hour)
	windowEnd := now

	// Maintenance window: 2 hours (06:00 to 08:00)
	maintStart := now.Add(-6 * time.Hour)
	maintEnd := now.Add(-4 * time.Hour)

	maintenance := []model.MaintenanceWindow{
		{
			StartTime: maintStart,
			EndTime:   maintEnd,
		},
	}

	// Outage during maintenance: 06:30 to 07:30 (1 hour inside maintenance)
	incStart := now.Add(-5*time.Hour - 30*time.Minute)
	incEnd := now.Add(-4*time.Hour - 30*time.Minute)

	incidents := []model.Incident{
		{
			StartedAt:  incStart,
			ResolvedAt: &incEnd,
		},
	}

	st := CalculateAvailability(windowStart, windowEnd, incidents, maintenance, nil)

	// Since the outage occurred during maintenance, downtime must be 0!
	if st.TotalDownTime != 0 {
		t.Errorf("expected 0 downtime during maintenance, got %v", st.TotalDownTime)
	}
	if st.UptimePercentage != 100.0 {
		t.Errorf("expected 100%% uptime with maintenance excluded, got %.3f%%", st.UptimePercentage)
	}
}

func TestFormatDuration(t *testing.T) {
	tests := []struct {
		d        time.Duration
		expected string
	}{
		{21*time.Minute + 5*time.Second, "21m 5s"},
		{6*time.Hour + 13*time.Minute + 20*time.Second, "6h 13m 20s"},
		{41*time.Hour + 25*time.Minute, "1d 17h 25m"},
		{48 * time.Hour, "2d 0h"},
		{45 * time.Second, "45s"},
	}

	for _, tt := range tests {
		got := FormatDuration(tt.d)
		if got != tt.expected {
			t.Errorf("FormatDuration(%v) = %q, want %q", tt.d, got, tt.expected)
		}
	}
}

func TestFormatMTBF(t *testing.T) {
	if FormatMTBF(-1) != "—" {
		t.Errorf("expected — for -1, got %s", FormatMTBF(-1))
	}
	if FormatMTBF(0.69) != "0.69h" {
		t.Errorf("expected 0.69h, got %s", FormatMTBF(0.69))
	}
	if FormatMTBF(168.0) != "7d" {
		t.Errorf("expected 7d, got %s", FormatMTBF(168.0))
	}
}
