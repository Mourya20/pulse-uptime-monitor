package checker

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/Mourya20/pulse-uptime-monitor/internal/model"
	"github.com/Mourya20/pulse-uptime-monitor/internal/security"
)

const (
	DefaultTimeoutSeconds    = 15
	MaxProbeTimeoutSeconds   = 30
	DefaultDegradedThreshold = 1000
	DefaultRetryBackoff      = 1500 * time.Millisecond
	MaxResponseBodyReadLimit = 4096
	UserAgentHeader          = "Pulse-KeepAlive-Monitor/1.0 (+https://github.com/Mourya20/pulse-uptime-monitor)"
)

// Result represents the outcome of probing a monitor.
type Result struct {
	Status         string
	StatusCode     int
	ResponseTimeMs int
	ErrorMessage   *string
	IsRetry        bool
	RootCause      string
}

// Checker handles executing HTTP keep-alive probes and classifying status.
type Checker struct {
	client             *http.Client
	skipSSRFForTesting bool
	backoff            time.Duration
}

// NewChecker initializes a default Checker for production use.
func NewChecker() *Checker {
	return &Checker{
		backoff: DefaultRetryBackoff,
	}
}

// NewCheckerWithClient creates a Checker with a custom HTTP client and backoff (useful for testing).
func NewCheckerWithClient(client *http.Client, backoff time.Duration, skipSSRF bool) *Checker {
	return &Checker{
		client:             client,
		backoff:            backoff,
		skipSSRFForTesting: skipSSRF,
	}
}

// IsStale determines if a monitor hasn't been checked within the documented grace period:
// Grace period = interval * 2 + 10 minutes.
func IsStale(lastCheckedAt *time.Time, intervalMinutes int) bool {
	if lastCheckedAt == nil {
		return true
	}
	graceMinutes := intervalMinutes*2 + 10
	graceDuration := time.Duration(graceMinutes) * time.Minute
	return time.Since(*lastCheckedAt) > graceDuration
}

// IsRetryable determines whether a network failure or HTTP status qualifies for an immediate retry.
func IsRetryable(statusCode int, err error) bool {
	if err != nil {
		// Network errors (dial, timeout, connection reset) are retryable
		return true
	}
	// Server 5xx errors are retryable
	return statusCode >= 500 && statusCode <= 599
}

// ClassifyStatus determines the monitor status based on HTTP code, latency and maintenance window.
func ClassifyStatus(statusCode int, responseTimeMs int, degradedThresholdMs int, inMaintenance bool, err error) (string, string) {
	if inMaintenance {
		return model.StatusMaintenance, "Scheduled maintenance in progress"
	}

	if err != nil {
		errMsg := CleanErrorMessage(err)
		return model.StatusDown, errMsg
	}

	if statusCode >= 400 {
		statusText := http.StatusText(statusCode)
		if statusText == "" {
			statusText = "HTTP Error"
		}
		return model.StatusDown, fmt.Sprintf("%d %s", statusCode, statusText)
	}

	if statusCode >= 200 && statusCode < 400 {
		if degradedThresholdMs > 0 && responseTimeMs > degradedThresholdMs {
			return model.StatusDegraded, fmt.Sprintf("Response time %dms exceeded threshold %dms", responseTimeMs, degradedThresholdMs)
		}
		return model.StatusUp, ""
	}

	return model.StatusDown, fmt.Sprintf("Unexpected HTTP status code: %d", statusCode)
}

// CleanErrorMessage produces a crisp, human-readable root cause from a network error.
func CleanErrorMessage(err error) string {
	if err == nil {
		return ""
	}
	msg := err.Error()

	switch {
	case strings.Contains(msg, "context deadline exceeded"), strings.Contains(msg, "Client.Timeout exceeded"):
		return "Connection timeout"
	case strings.Contains(msg, "connection refused"):
		return "Connection refused"
	case strings.Contains(msg, "connection reset by peer"):
		return "Connection reset by peer"
	case strings.Contains(msg, "no such host"):
		return "DNS resolution failed (no such host)"
	case strings.Contains(msg, "certificate"), strings.Contains(msg, "tls:"):
		return "SSL/TLS handshake failure"
	case strings.Contains(msg, "SSRF") || strings.Contains(msg, "private, loopback"):
		return "Blocked by SSRF policy"
	case strings.Contains(msg, "stopped after 3 redirects"):
		return "Too many redirects"
	default:
		// Truncate overly long error messages
		if len(msg) > 120 {
			return msg[:117] + "..."
		}
		return msg
	}
}

// Check executes the keep-alive HTTP probe with SSRF validation, latency measurement, and bounded retry.
func (c *Checker) Check(ctx context.Context, m *model.Monitor, inMaintenance bool) Result {
	timeoutSec := m.TimeoutSeconds
	if timeoutSec <= 0 {
		timeoutSec = DefaultTimeoutSeconds
	}
	if timeoutSec > MaxProbeTimeoutSeconds {
		timeoutSec = MaxProbeTimeoutSeconds
	}
	timeout := time.Duration(timeoutSec) * time.Second

	threshold := m.DegradedThresholdMs
	if threshold <= 0 {
		threshold = DefaultDegradedThreshold
	}

	// 1. SSRF Validation
	if !c.skipSSRFForTesting {
		if _, err := security.ValidateURL(m.URL); err != nil {
			errStr := err.Error()
			return Result{
				Status:         model.StatusDown,
				StatusCode:     0,
				ResponseTimeMs: 0,
				ErrorMessage:   &errStr,
				IsRetry:        false,
				RootCause:      CleanErrorMessage(err),
			}
		}
	}

	// Prepare HTTP client
	client := c.client
	if client == nil {
		client = security.NewSafeHTTPClient(timeout)
	}

	// Attempt 1
	code, duration, err := c.executeAttempt(ctx, client, m.URL, timeout)
	ms := int(duration.Milliseconds())
	if ms == 0 && err == nil {
		ms = 1 // Minimum 1ms for completed requests
	}

	isRetry := false

	// Retry once if retryable and context not canceled
	if IsRetryable(code, err) && ctx.Err() == nil {
		select {
		case <-ctx.Done():
			// Parent context canceled, abort retry
		case <-time.After(c.backoff):
			if ctx.Err() == nil {
				isRetry = true
				retryTimeout := timeout
				if retryTimeout > 10*time.Second {
					retryTimeout = 10 * time.Second
				}
				code, duration, err = c.executeAttempt(ctx, client, m.URL, retryTimeout)
				ms = int(duration.Milliseconds())
				if ms == 0 && err == nil {
					ms = 1
				}
			}
		}
	}

	status, rootCause := ClassifyStatus(code, ms, threshold, inMaintenance, err)

	var errPtr *string
	if err != nil {
		s := err.Error()
		errPtr = &s
	}

	return Result{
		Status:         status,
		StatusCode:     code,
		ResponseTimeMs: ms,
		ErrorMessage:   errPtr,
		IsRetry:        isRetry,
		RootCause:      rootCause,
	}
}

// executeAttempt executes a single HTTP GET request, measuring response time until headers arrive.
func (c *Checker) executeAttempt(ctx context.Context, client *http.Client, rawURL string, timeout time.Duration) (int, time.Duration, error) {
	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, rawURL, nil)
	if err != nil {
		return 0, 0, err
	}

	req.Header.Set("User-Agent", UserAgentHeader)
	req.Header.Set("Accept", "*/*")
	req.Header.Set("Cache-Control", "no-cache")

	start := time.Now()
	resp, err := client.Do(req)
	duration := time.Since(start)

	if err != nil {
		return 0, duration, err
	}
	defer resp.Body.Close()

	// Drain up to MaxResponseBodyReadLimit to free the socket for connection reuse, without retaining body.
	_, _ = io.CopyN(io.Discard, resp.Body, MaxResponseBodyReadLimit)

	return resp.StatusCode, duration, nil
}
