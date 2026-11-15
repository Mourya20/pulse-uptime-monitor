package config

import (
	"errors"
	"os"
	"strconv"
	"time"
)

var (
	ErrMissingDatabaseURL = errors.New("DATABASE_URL environment variable is required")
)

// Config holds runtime configuration for the Go monitoring engine.
type Config struct {
	DatabaseURL       string
	DefaultTimeout    time.Duration
	Concurrency       int
	LockKey           int64
	StaleGraceMinutes int
}

// LoadFromEnv loads configuration from environment variables.
func LoadFromEnv() (*Config, error) {
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		return nil, ErrMissingDatabaseURL
	}

	timeoutSec := 90
	if val := os.Getenv("DEFAULT_TIMEOUT_SECONDS"); val != "" {
		if parsed, err := strconv.Atoi(val); err == nil && parsed > 0 {
			timeoutSec = parsed
		}
	}

	concurrency := 10
	if val := os.Getenv("CONCURRENCY"); val != "" {
		if parsed, err := strconv.Atoi(val); err == nil && parsed > 0 {
			concurrency = parsed
		}
	}

	return &Config{
		DatabaseURL:       dbURL,
		DefaultTimeout:    time.Duration(timeoutSec) * time.Second,
		Concurrency:       concurrency,
		LockKey:           7428912384912, // Consistent advisory lock ID for Pulse
		StaleGraceMinutes: 10,
	}, nil
}
