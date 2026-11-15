package stats

import (
	"fmt"
	"math"
	"time"

	"github.com/Mourya20/pulse-uptime-monitor/internal/model"
)

// Statistics contains computed metrics for a monitor over an evaluation window.
type Statistics struct {
	UptimePercentage   float64       `json:"uptime_percentage"`
	TotalMonitoredTime time.Duration `json:"total_monitored_time"`
	TotalDownTime      time.Duration `json:"total_down_time"`
	TotalMaintTime     time.Duration `json:"total_maint_time"`
	IncidentCount      int           `json:"incident_count"`
	MTBFHours          float64       `json:"mtbf_hours"` // -1 indicates no incidents (displayed as "—")
	AvgLatencyMs       int           `json:"avg_latency_ms"`
	MinLatencyMs       int           `json:"min_latency_ms"`
	MaxLatencyMs       int           `json:"max_latency_ms"`
}

// CalculateAvailability computes duration-weighted uptime percentage, downtime, MTBF,
// and latency statistics for a window [windowStart, windowEnd].
//
// Rules enforced:
// - UP and DEGRADED count as available.
// - Exclude scheduled maintenance from monitored duration.
// - Do not count downtime during scheduled maintenance.
// - Use observed incident start and resolution timestamps clamped to the window.
// - Availability = (monitored_duration - down_duration) / monitored_duration * 100
func CalculateAvailability(
	windowStart, windowEnd time.Time,
	incidents []model.Incident,
	maintenance []model.MaintenanceWindow,
	checks []model.Check,
) Statistics {
	if windowEnd.Before(windowStart) {
		windowStart, windowEnd = windowEnd, windowStart
	}
	windowDuration := windowEnd.Sub(windowStart)
	if windowDuration <= 0 {
		return Statistics{UptimePercentage: 100.0, MTBFHours: -1}
	}

	// 1. Calculate Maintenance overlap within window
	maintRanges := make([][2]time.Time, 0, len(maintenance))
	for _, m := range maintenance {
		s := m.StartTime
		e := m.EndTime
		if s.Before(windowStart) {
			s = windowStart
		}
		if e.After(windowEnd) {
			e = windowEnd
		}
		if s.Before(e) {
			maintRanges = append(maintRanges, [2]time.Time{s, e})
		}
	}

	totalMaintDuration := sumMergedRanges(maintRanges)
	effectiveMonitoredDuration := windowDuration - totalMaintDuration
	if effectiveMonitoredDuration <= 0 {
		return Statistics{UptimePercentage: 100.0, TotalMaintTime: totalMaintDuration, MTBFHours: -1}
	}

	// 2. Calculate Incident downtime overlap within window (excluding maintenance periods)
	downRanges := make([][2]time.Time, 0, len(incidents))
	incidentCount := 0

	for _, inc := range incidents {
		s := inc.StartedAt
		var e time.Time
		if inc.ResolvedAt != nil {
			e = *inc.ResolvedAt
		} else {
			e = windowEnd
		}

		// Clamp to window
		if s.Before(windowStart) {
			s = windowStart
		}
		if e.After(windowEnd) {
			e = windowEnd
		}

		if s.Before(e) {
			incidentCount++
			// Exclude portions overlapping with maintenance windows
			effectiveRanges := subtractRanges([2]time.Time{s, e}, maintRanges)
			downRanges = append(downRanges, effectiveRanges...)
		}
	}

	totalDownDuration := sumMergedRanges(downRanges)
	if totalDownDuration > effectiveMonitoredDuration {
		totalDownDuration = effectiveMonitoredDuration
	}

	upDuration := effectiveMonitoredDuration - totalDownDuration
	uptimePct := (float64(upDuration) / float64(effectiveMonitoredDuration)) * 100.0
	// Round to 3 decimal places (e.g. 99.982%)
	uptimePct = math.Round(uptimePct*1000) / 1000

	// 3. Compute MTBF = Total Available Time / Incident Count
	var mtbf float64 = -1
	if incidentCount > 0 {
		mtbf = (upDuration.Hours()) / float64(incidentCount)
		mtbf = math.Round(mtbf*100) / 100
	}

	// 4. Compute Latency metrics from checks
	avgLat, minLat, maxLat := computeLatencyStats(checks)

	return Statistics{
		UptimePercentage:   uptimePct,
		TotalMonitoredTime: effectiveMonitoredDuration,
		TotalDownTime:      totalDownDuration,
		TotalMaintTime:     totalMaintDuration,
		IncidentCount:      incidentCount,
		MTBFHours:          mtbf,
		AvgLatencyMs:       avgLat,
		MinLatencyMs:       minLat,
		MaxLatencyMs:       maxLat,
	}
}

// computeLatencyStats calculates average, min, and max latency from checks in the window.
func computeLatencyStats(checks []model.Check) (avg, min, max int) {
	if len(checks) == 0 {
		return 0, 0, 0
	}

	total := 0
	count := 0
	min = math.MaxInt32
	max = 0

	for _, c := range checks {
		// Only consider successful checks (UP or DEGRADED) for latency statistics
		if c.Status == model.StatusUp || c.Status == model.StatusDegraded {
			total += c.ResponseTimeMs
			count++
			if c.ResponseTimeMs < min {
				min = c.ResponseTimeMs
			}
			if c.ResponseTimeMs > max {
				max = c.ResponseTimeMs
			}
		}
	}

	if count == 0 {
		return 0, 0, 0
	}

	avg = total / count
	return avg, min, max
}

// Helper: merge overlapping time ranges and calculate total duration
func sumMergedRanges(ranges [][2]time.Time) time.Duration {
	if len(ranges) == 0 {
		return 0
	}

	// Simple sort by start time
	for i := 0; i < len(ranges)-1; i++ {
		for j := i + 1; j < len(ranges); j++ {
			if ranges[j][0].Before(ranges[i][0]) {
				ranges[i], ranges[j] = ranges[j], ranges[i]
			}
		}
	}

	merged := make([][2]time.Time, 0, len(ranges))
	curr := ranges[0]

	for i := 1; i < len(ranges); i++ {
		next := ranges[i]
		if next[0].Before(curr[1]) || next[0].Equal(curr[1]) {
			if next[1].After(curr[1]) {
				curr[1] = next[1]
			}
		} else {
			merged = append(merged, curr)
			curr = next
		}
	}
	merged = append(merged, curr)

	var total time.Duration
	for _, r := range merged {
		total += r[1].Sub(r[0])
	}
	return total
}

// Helper: subtract an array of exclusion ranges from a single range
func subtractRanges(r [2]time.Time, exclusions [][2]time.Time) [][2]time.Time {
	active := [][2]time.Time{r}

	for _, ex := range exclusions {
		var nextActive [][2]time.Time
		for _, a := range active {
			// No overlap
			if ex[1].Before(a[0]) || ex[1].Equal(a[0]) || ex[0].After(a[1]) || ex[0].Equal(a[1]) {
				nextActive = append(nextActive, a)
				continue
			}

			// Left remnant
			if ex[0].After(a[0]) {
				nextActive = append(nextActive, [2]time.Time{a[0], ex[0]})
			}
			// Right remnant
			if ex[1].Before(a[1]) {
				nextActive = append(nextActive, [2]time.Time{ex[1], a[1]})
			}
		}
		active = nextActive
	}

	return active
}

// FormatDuration formats a duration into compact human-readable form (e.g. "1d 17h 25m" or "0h 21m 5s").
func FormatDuration(d time.Duration) string {
	if d < 0 {
		d = -d
	}

	days := int(d.Hours()) / 24
	hours := int(d.Hours()) % 24
	minutes := int(d.Minutes()) % 60
	seconds := int(d.Seconds()) % 60

	if days > 0 {
		if minutes > 0 {
			return fmt.Sprintf("%dd %dh %dm", days, hours, minutes)
		}
		return fmt.Sprintf("%dd %dh", days, hours)
	}

	if hours > 0 {
		return fmt.Sprintf("%dh %dm %ds", hours, minutes, seconds)
	}

	if minutes > 0 {
		return fmt.Sprintf("%dm %ds", minutes, seconds)
	}

	return fmt.Sprintf("%ds", seconds)
}

// FormatMTBF formats MTBF hours into display text (e.g. "0.69h", "168h", "—").
func FormatMTBF(mtbfHours float64) string {
	if mtbfHours < 0 {
		return "—"
	}
	if mtbfHours >= 24 {
		days := mtbfHours / 24
		if days == math.Floor(days) {
			return fmt.Sprintf("%.0fd", days)
		}
		return fmt.Sprintf("%.1fh", mtbfHours)
	}
	return fmt.Sprintf("%.2fh", mtbfHours)
}
