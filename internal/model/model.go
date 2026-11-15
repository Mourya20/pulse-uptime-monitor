package model

import "time"

// Monitoring status constants
const (
	StatusUp          = "UP"
	StatusDegraded    = "DEGRADED"
	StatusDown        = "DOWN"
	StatusPaused      = "PAUSED"
	StatusMaintenance = "MAINTENANCE"
	StatusUnknown     = "UNKNOWN"
)

// Supported intervals in minutes
var SupportedIntervals = []int{5, 15, 30}

// Monitor represents a service endpoint configured for keep-alive and uptime monitoring.
type Monitor struct {
	ID                  string     `json:"id"`
	UserID              string     `json:"user_id"`
	Name                string     `json:"name"`
	URL                 string     `json:"url"`
	IntervalMinutes     int        `json:"interval_minutes"`
	TimeoutSeconds      int        `json:"timeout_seconds"`
	DegradedThresholdMs int        `json:"degraded_threshold_ms"`
	IsPaused            bool       `json:"is_paused"`
	CurrentStatus       string     `json:"current_status"`
	LastCheckedAt       *time.Time `json:"last_checked_at"`
	NextCheckAt         *time.Time `json:"next_check_at"`
	CreatedAt           time.Time  `json:"created_at"`
	UpdatedAt           time.Time  `json:"updated_at"`
}

// Check represents the execution result of an individual HTTP probe.
type Check struct {
	ID             string    `json:"id"`
	MonitorID      string    `json:"monitor_id"`
	UserID         string    `json:"user_id"`
	CheckedAt      time.Time `json:"checked_at"`
	Status         string    `json:"status"` // UP, DEGRADED, DOWN, MAINTENANCE
	StatusCode     int       `json:"status_code"`
	ResponseTimeMs int       `json:"response_time_ms"`
	ErrorMessage   *string   `json:"error_message,omitempty"`
	IsRetry        bool      `json:"is_retry"`
}

// Incident represents an outage event detected for a monitor.
type Incident struct {
	ID              string     `json:"id"`
	MonitorID       string     `json:"monitor_id"`
	UserID          string     `json:"user_id"`
	StartedAt       time.Time  `json:"started_at"`
	ResolvedAt      *time.Time `json:"resolved_at,omitempty"`
	DurationSeconds *int       `json:"duration_seconds,omitempty"`
	RootCause       string     `json:"root_cause"`
	HTTPStatus      *int       `json:"http_status,omitempty"`
	ErrorDetails    *string    `json:"error_details,omitempty"`
	CreatedAt       time.Time  `json:"created_at"`
}

// MaintenanceWindow represents a scheduled maintenance period during which outage alerts are suppressed.
type MaintenanceWindow struct {
	ID          string    `json:"id"`
	UserID      string    `json:"user_id"`
	MonitorID   *string   `json:"monitor_id,omitempty"` // nil applies to all monitors
	Name        string    `json:"name"`
	Description *string   `json:"description,omitempty"`
	StartTime   time.Time `json:"start_time"`
	EndTime     time.Time `json:"end_time"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

// AppSettings represents user-level preferences for monitoring and dashboard display.
type AppSettings struct {
	UserID                 string    `json:"user_id"`
	DefaultIntervalMinutes int       `json:"default_interval_minutes"`
	DefaultTimeoutSeconds  int       `json:"default_timeout_seconds"`
	DegradedThresholdMs    int       `json:"degraded_threshold_ms"`
	DashboardTimezone      string    `json:"dashboard_timezone"`
	UpdatedAt              time.Time `json:"updated_at"`
}
