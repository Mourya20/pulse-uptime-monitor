package engine

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/Mourya20/pulse-uptime-monitor/internal/checker"
	"github.com/Mourya20/pulse-uptime-monitor/internal/config"
	"github.com/Mourya20/pulse-uptime-monitor/internal/model"
)

// MockRepository implements db.Repository in-memory for testing.
type MockRepository struct {
	mu           sync.Mutex
	lockAcquired bool

	dueMonitors []model.Monitor
	checks      []*model.Check
	incidents   []*model.Incident
	monitors    map[string]*model.Monitor
	maintenance map[string]bool // monitorID -> inMaintenance
}

func NewMockRepository() *MockRepository {
	return &MockRepository{
		lockAcquired: true,
		monitors:     make(map[string]*model.Monitor),
		maintenance:  make(map[string]bool),
	}
}

func (m *MockRepository) AcquireAdvisoryLock(ctx context.Context, lockKey int64) (func(), bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if !m.lockAcquired {
		return nil, false, nil
	}
	m.lockAcquired = false // Lock taken
	unlock := func() {
		m.mu.Lock()
		m.lockAcquired = true
		m.mu.Unlock()
	}
	return unlock, true, nil
}

func (m *MockRepository) ClaimDueMonitors(ctx context.Context, limit int) ([]model.Monitor, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if limit <= 0 || limit > len(m.dueMonitors) {
		limit = len(m.dueMonitors)
	}

	res := m.dueMonitors[:limit]
	m.dueMonitors = m.dueMonitors[limit:]
	return res, nil
}

func (m *MockRepository) MarkStaleMonitors(ctx context.Context) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	var count int64
	for _, mon := range m.monitors {
		if !mon.IsPaused && mon.CurrentStatus != model.StatusUnknown && checker.IsStale(mon.LastCheckedAt, mon.IntervalMinutes) {
			mon.CurrentStatus = model.StatusUnknown
			count++
		}
	}
	return count, nil
}

func (m *MockRepository) IsMonitorInMaintenance(ctx context.Context, userID, monitorID string, at time.Time) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.maintenance[monitorID], nil
}

func (m *MockRepository) RecordCheck(ctx context.Context, check *model.Check) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.checks = append(m.checks, check)
	return nil
}

func (m *MockRepository) ProcessIncidentAndStatus(ctx context.Context, mon *model.Monitor, res checker.Result, inMaintenance bool, checkedAt time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	// Update monitor status
	finalStatus := res.Status
	if inMaintenance {
		finalStatus = model.StatusMaintenance
	}
	if existing, ok := m.monitors[mon.ID]; ok {
		existing.CurrentStatus = finalStatus
		existing.LastCheckedAt = &checkedAt
		nextCheck := checkedAt.Add(time.Duration(existing.IntervalMinutes) * time.Minute)
		existing.NextCheckAt = &nextCheck
	}

	// 1. If Down outside maintenance -> create incident if none active
	if res.Status == model.StatusDown && !inMaintenance {
		var active *model.Incident
		for _, inc := range m.incidents {
			if inc.MonitorID == mon.ID && inc.ResolvedAt == nil {
				active = inc
				break
			}
		}

		if active == nil {
			var codePtr *int
			if res.StatusCode > 0 {
				c := res.StatusCode
				codePtr = &c
			}
			m.incidents = append(m.incidents, &model.Incident{
				ID:           "inc-1",
				MonitorID:    mon.ID,
				UserID:       mon.UserID,
				StartedAt:    checkedAt,
				RootCause:    res.RootCause,
				HTTPStatus:   codePtr,
				ErrorDetails: res.ErrorMessage,
			})
		}
	}

	// 2. If Up/Degraded -> resolve any active incident
	if res.Status == model.StatusUp || res.Status == model.StatusDegraded {
		for _, inc := range m.incidents {
			if inc.MonitorID == mon.ID && inc.ResolvedAt == nil {
				inc.ResolvedAt = &checkedAt
				dur := int(checkedAt.Sub(inc.StartedAt).Seconds())
				inc.DurationSeconds = &dur
			}
		}
	}

	return nil
}

func (m *MockRepository) Close() {}

func TestEngine_SuccessRun(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	repo := NewMockRepository()
	mon := model.Monitor{
		ID:                  "m-1",
		UserID:              "u-1",
		Name:                "Test Service",
		URL:                 server.URL,
		IntervalMinutes:     5,
		TimeoutSeconds:      5,
		DegradedThresholdMs: 1000,
	}
	repo.dueMonitors = []model.Monitor{mon}
	repo.monitors[mon.ID] = &mon

	chk := checker.NewCheckerWithClient(server.Client(), 10*time.Millisecond, true)
	cfg := &config.Config{Concurrency: 1, BatchSize: 10, LockKey: 123}

	eng := NewEngine(cfg, repo, chk)
	if err := eng.Run(context.Background()); err != nil {
		t.Fatalf("unexpected engine run error: %v", err)
	}

	if len(repo.checks) != 1 {
		t.Fatalf("expected 1 check, got %d", len(repo.checks))
	}
	if repo.checks[0].Status != model.StatusUp {
		t.Errorf("expected Check Status UP, got %s", repo.checks[0].Status)
	}
	if repo.monitors["m-1"].CurrentStatus != model.StatusUp {
		t.Errorf("expected Monitor Status UP, got %s", repo.monitors["m-1"].CurrentStatus)
	}
	if len(repo.incidents) != 0 {
		t.Errorf("expected 0 incidents, got %d", len(repo.incidents))
	}
	if repo.monitors["m-1"].NextCheckAt == nil {
		t.Errorf("expected NextCheckAt to be populated after probe")
	}
}

func TestEngine_IncidentCreationAndRecovery(t *testing.T) {
	statusCode := http.StatusInternalServerError

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(statusCode)
	}))
	defer server.Close()

	repo := NewMockRepository()
	mon := model.Monitor{
		ID:                  "m-2",
		UserID:              "u-1",
		Name:                "Failing API",
		URL:                 server.URL,
		IntervalMinutes:     5,
		TimeoutSeconds:      5,
		DegradedThresholdMs: 1000,
	}
	repo.dueMonitors = []model.Monitor{mon}
	repo.monitors[mon.ID] = &mon

	chk := checker.NewCheckerWithClient(server.Client(), 10*time.Millisecond, true)
	cfg := &config.Config{Concurrency: 1, BatchSize: 10, LockKey: 123}

	eng := NewEngine(cfg, repo, chk)

	// Run 1: Fails with 500 -> Incident should be created
	if err := eng.Run(context.Background()); err != nil {
		t.Fatalf("unexpected run error: %v", err)
	}

	if len(repo.incidents) != 1 {
		t.Fatalf("expected 1 active incident, got %d", len(repo.incidents))
	}
	if repo.incidents[0].ResolvedAt != nil {
		t.Errorf("expected active incident not resolved")
	}

	// Run 2: Still failing -> should NOT create duplicate incident
	repo.dueMonitors = []model.Monitor{mon}
	if err := eng.Run(context.Background()); err != nil {
		t.Fatalf("unexpected run error: %v", err)
	}

	if len(repo.incidents) != 1 {
		t.Fatalf("expected still 1 incident (no duplicate), got %d", len(repo.incidents))
	}

	// Run 3: Service recovers (200 OK) -> Incident should be resolved
	statusCode = http.StatusOK
	repo.dueMonitors = []model.Monitor{mon}
	if err := eng.Run(context.Background()); err != nil {
		t.Fatalf("unexpected run error: %v", err)
	}

	if repo.incidents[0].ResolvedAt == nil {
		t.Errorf("expected incident to be resolved on recovery")
	}
	if repo.monitors["m-2"].CurrentStatus != model.StatusUp {
		t.Errorf("expected monitor status UP, got %s", repo.monitors["m-2"].CurrentStatus)
	}
}

func TestEngine_MaintenanceWindowSuppression(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Server fails with 503
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer server.Close()

	repo := NewMockRepository()
	mon := model.Monitor{
		ID:                  "m-maint",
		UserID:              "u-1",
		Name:                "Maint Monitor",
		URL:                 server.URL,
		IntervalMinutes:     5,
		TimeoutSeconds:      5,
		DegradedThresholdMs: 1000,
	}
	repo.dueMonitors = []model.Monitor{mon}
	repo.monitors[mon.ID] = &mon
	repo.maintenance[mon.ID] = true // Active maintenance

	chk := checker.NewCheckerWithClient(server.Client(), 10*time.Millisecond, true)
	cfg := &config.Config{Concurrency: 1, BatchSize: 10, LockKey: 123}

	eng := NewEngine(cfg, repo, chk)

	if err := eng.Run(context.Background()); err != nil {
		t.Fatalf("unexpected run error: %v", err)
	}

	// Keep-alive request was executed and recorded
	if len(repo.checks) != 1 {
		t.Fatalf("expected 1 check recorded during maintenance, got %d", len(repo.checks))
	}
	// Monitor status is MAINTENANCE
	if repo.monitors["m-maint"].CurrentStatus != model.StatusMaintenance {
		t.Errorf("expected status MAINTENANCE, got %s", repo.monitors["m-maint"].CurrentStatus)
	}
	// Normal outage incident is SUPPRESSED
	if len(repo.incidents) != 0 {
		t.Errorf("expected 0 incidents during maintenance, got %d", len(repo.incidents))
	}
}

func TestEngine_StaleMonitorDetection(t *testing.T) {
	repo := NewMockRepository()
	staleTime := time.Now().Add(-30 * time.Minute) // Grace for 5m interval is 5*2+10 = 20m. 30m is stale.

	staleMon := model.Monitor{
		ID:              "m-stale",
		UserID:          "u-1",
		Name:            "Stale Monitor",
		URL:             "http://example.com/health",
		IntervalMinutes: 5,
		CurrentStatus:   model.StatusUp,
		LastCheckedAt:   &staleTime,
	}
	repo.monitors[staleMon.ID] = &staleMon

	cfg := &config.Config{Concurrency: 1, BatchSize: 10, LockKey: 123}
	eng := NewEngine(cfg, repo, nil)

	if err := eng.Run(context.Background()); err != nil {
		t.Fatalf("unexpected run error: %v", err)
	}

	if repo.monitors["m-stale"].CurrentStatus != model.StatusUnknown {
		t.Errorf("expected stale monitor to be marked UNKNOWN, got %s", repo.monitors["m-stale"].CurrentStatus)
	}
}

func TestEngine_BoundedBatch(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	repo := NewMockRepository()
	for i := 1; i <= 5; i++ {
		id := "m-" + string(rune('0'+i))
		m := model.Monitor{
			ID:                  id,
			UserID:              "u-1",
			Name:                "Batch Service " + id,
			URL:                 server.URL,
			IntervalMinutes:     5,
			TimeoutSeconds:      2,
			DegradedThresholdMs: 1000,
		}
		repo.dueMonitors = append(repo.dueMonitors, m)
		repo.monitors[id] = &m
	}

	chk := checker.NewCheckerWithClient(server.Client(), 10*time.Millisecond, true)
	// Set BatchSize to 3
	cfg := &config.Config{Concurrency: 2, BatchSize: 3, LockKey: 123}
	eng := NewEngine(cfg, repo, chk)

	if err := eng.Run(context.Background()); err != nil {
		t.Fatalf("unexpected run error: %v", err)
	}

	// Exactly 3 monitors should have been processed
	if len(repo.checks) != 3 {
		t.Fatalf("expected 3 checks from bounded batch, got %d", len(repo.checks))
	}
	// 2 remaining monitors must remain due!
	if len(repo.dueMonitors) != 2 {
		t.Fatalf("expected 2 unprocessed monitors to remain due, got %d", len(repo.dueMonitors))
	}
}

func TestEngine_AdvisoryLockSkip(t *testing.T) {
	repo := NewMockRepository()
	repo.lockAcquired = false // Lock already held by another runner

	cfg := &config.Config{Concurrency: 1, LockKey: 123}
	eng := NewEngine(cfg, repo, nil)

	// Should exit cleanly without error
	if err := eng.Run(context.Background()); err != nil {
		t.Errorf("expected clean exit on lock skip, got error: %v", err)
	}
}
