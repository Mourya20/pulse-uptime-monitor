package checker

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Mourya20/pulse-uptime-monitor/internal/model"
)

func TestStatusClassification(t *testing.T) {
	tests := []struct {
		name           string
		code           int
		latencyMs      int
		thresholdMs    int
		inMaintenance  bool
		err            error
		expectedStatus string
	}{
		{"200 OK fast", 200, 150, 1000, false, nil, model.StatusUp},
		{"204 No Content", 204, 80, 1000, false, nil, model.StatusUp},
		{"301 Redirect", 301, 120, 1000, false, nil, model.StatusUp},
		{"302 Found", 302, 110, 1000, false, nil, model.StatusUp},
		{"200 Degraded latency", 200, 1500, 1000, false, nil, model.StatusDegraded},
		{"404 Not Found", 404, 50, 1000, false, nil, model.StatusDown},
		{"500 Server Error", 500, 50, 1000, false, nil, model.StatusDown},
		{"502 Bad Gateway", 502, 60, 1000, false, nil, model.StatusDown},
		{"Network Error", 0, 0, 1000, false, context.DeadlineExceeded, model.StatusDown},
		{"During Maintenance", 200, 100, 1000, true, nil, model.StatusMaintenance},
		{"During Maintenance with failure", 500, 100, 1000, true, nil, model.StatusMaintenance},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			status, _ := ClassifyStatus(tt.code, tt.latencyMs, tt.thresholdMs, tt.inMaintenance, tt.err)
			if status != tt.expectedStatus {
				t.Errorf("ClassifyStatus() = %v, want %v", status, tt.expectedStatus)
			}
		})
	}
}

func TestIsStale(t *testing.T) {
	// Grace period for interval = 5 is 5*2 + 10 = 20 minutes
	now := time.Now()

	// Never checked -> stale
	if !IsStale(nil, 5) {
		t.Errorf("expected nil lastCheckedAt to be stale")
	}

	// Checked 5 minutes ago -> not stale
	recent := now.Add(-5 * time.Minute)
	if IsStale(&recent, 5) {
		t.Errorf("expected 5m ago to NOT be stale")
	}

	// Checked 19 minutes ago -> not stale
	justBefore := now.Add(-19 * time.Minute)
	if IsStale(&justBefore, 5) {
		t.Errorf("expected 19m ago to NOT be stale")
	}

	// Checked 25 minutes ago -> stale (exceeds 20m grace)
	pastGrace := now.Add(-25 * time.Minute)
	if !IsStale(&pastGrace, 5) {
		t.Errorf("expected 25m ago to be stale")
	}
}

func TestIsRetryable(t *testing.T) {
	if !IsRetryable(0, context.DeadlineExceeded) {
		t.Errorf("expected network error to be retryable")
	}
	if !IsRetryable(500, nil) {
		t.Errorf("expected 500 to be retryable")
	}
	if !IsRetryable(502, nil) {
		t.Errorf("expected 502 to be retryable")
	}
	if IsRetryable(404, nil) {
		t.Errorf("expected 404 to NOT be retryable")
	}
	if IsRetryable(200, nil) {
		t.Errorf("expected 200 to NOT be retryable")
	}
}

func TestCheckerExecutionSuccess(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("OK"))
	}))
	defer server.Close()

	c := NewCheckerWithClient(server.Client(), 10*time.Millisecond, true)

	m := &model.Monitor{
		URL:                 server.URL,
		TimeoutSeconds:      5,
		DegradedThresholdMs: 1000,
	}

	res := c.Check(context.Background(), m, false)
	if res.Status != model.StatusUp {
		t.Errorf("expected Status UP, got %v", res.Status)
	}
	if res.StatusCode != 200 {
		t.Errorf("expected status code 200, got %d", res.StatusCode)
	}
	if res.IsRetry {
		t.Errorf("expected no retry for 200 OK")
	}
	if res.ResponseTimeMs <= 0 {
		t.Errorf("expected positive response time, got %d", res.ResponseTimeMs)
	}
}

func TestCheckerRetryRecovery(t *testing.T) {
	var attempts int32

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt32(&attempts, 1)
		if n == 1 {
			// First attempt fails with 503
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		// Second attempt succeeds
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	c := NewCheckerWithClient(server.Client(), 10*time.Millisecond, true)

	m := &model.Monitor{
		URL:                 server.URL,
		TimeoutSeconds:      5,
		DegradedThresholdMs: 1000,
	}

	res := c.Check(context.Background(), m, false)
	if res.Status != model.StatusUp {
		t.Errorf("expected Status UP after retry, got %v", res.Status)
	}
	if res.StatusCode != 200 {
		t.Errorf("expected status code 200, got %d", res.StatusCode)
	}
	if !res.IsRetry {
		t.Errorf("expected IsRetry to be true")
	}
	if atomic.LoadInt32(&attempts) != 2 {
		t.Errorf("expected 2 attempts, got %d", attempts)
	}
}

func TestCheckerRetryFailure(t *testing.T) {
	var attempts int32

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&attempts, 1)
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer server.Close()

	c := NewCheckerWithClient(server.Client(), 10*time.Millisecond, true)

	m := &model.Monitor{
		URL:                 server.URL,
		TimeoutSeconds:      5,
		DegradedThresholdMs: 1000,
	}

	res := c.Check(context.Background(), m, false)
	if res.Status != model.StatusDown {
		t.Errorf("expected Status DOWN, got %v", res.Status)
	}
	if res.StatusCode != 502 {
		t.Errorf("expected status code 502, got %d", res.StatusCode)
	}
	if !res.IsRetry {
		t.Errorf("expected IsRetry to be true")
	}
	if atomic.LoadInt32(&attempts) != 2 {
		t.Errorf("expected 2 attempts, got %d", attempts)
	}
}

func TestCheckerTimeout(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(300 * time.Millisecond)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	// Short timeout
	client := server.Client()
	client.Timeout = 50 * time.Millisecond

	c := NewCheckerWithClient(client, 10*time.Millisecond, true)

	m := &model.Monitor{
		URL:                 server.URL,
		TimeoutSeconds:      1,
		DegradedThresholdMs: 1000,
	}

	res := c.Check(context.Background(), m, false)
	if res.Status != model.StatusDown {
		t.Errorf("expected Status DOWN on timeout, got %v", res.Status)
	}
	if res.RootCause != "Connection timeout" {
		t.Errorf("expected RootCause 'Connection timeout', got %q", res.RootCause)
	}
}

func TestCheckerMaintenanceMode(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	c := NewCheckerWithClient(server.Client(), 10*time.Millisecond, true)

	m := &model.Monitor{
		URL:                 server.URL,
		TimeoutSeconds:      5,
		DegradedThresholdMs: 1000,
	}

	// In maintenance mode: keep-alive request sent, but status marked as MAINTENANCE
	res := c.Check(context.Background(), m, true)
	if res.Status != model.StatusMaintenance {
		t.Errorf("expected Status MAINTENANCE, got %v", res.Status)
	}
}
