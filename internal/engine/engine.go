package engine

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/Mourya20/pulse-uptime-monitor/internal/checker"
	"github.com/Mourya20/pulse-uptime-monitor/internal/config"
	"github.com/Mourya20/pulse-uptime-monitor/internal/db"
	"github.com/Mourya20/pulse-uptime-monitor/internal/model"
)

// Engine coordinates scheduled keep-alive and uptime monitoring execution.
type Engine struct {
	cfg     *config.Config
	repo    db.Repository
	checker *checker.Checker
}

// NewEngine creates an Engine instance.
func NewEngine(cfg *config.Config, repo db.Repository, chk *checker.Checker) *Engine {
	if chk == nil {
		chk = checker.NewChecker()
	}
	return &Engine{
		cfg:     cfg,
		repo:    repo,
		checker: chk,
	}
}

// Run executes a single monitoring cycle across due monitors within bounded limits.
func (e *Engine) Run(ctx context.Context) error {
	log.Println("[Pulse] Starting monitoring cycle...")

	// 1. Acquire advisory lock to prevent overlapping executions
	unlock, acquired, err := e.repo.AcquireAdvisoryLock(ctx, e.cfg.LockKey)
	if err != nil {
		return fmt.Errorf("failed to acquire runner advisory lock: %w", err)
	}
	if !acquired {
		log.Println("[Pulse] Another runner instance is currently executing. Exiting cleanly.")
		return nil
	}
	defer unlock()

	// 2. Mark any unpaused monitors that exceeded their grace period as UNKNOWN
	staleCount, err := e.repo.MarkStaleMonitors(ctx)
	if err != nil {
		log.Printf("[Pulse] Warning: failed to evaluate stale monitors: %v\n", err)
	} else if staleCount > 0 {
		log.Printf("[Pulse] Marked %d stale monitor(s) as UNKNOWN (exceeded check interval grace period).\n", staleCount)
	}

	// 3. Claim due monitors in a bounded batch
	batchSize := e.cfg.BatchSize
	if batchSize <= 0 {
		batchSize = 100
	}

	monitors, err := e.repo.ClaimDueMonitors(ctx, batchSize)
	if err != nil {
		return fmt.Errorf("failed to claim due monitors: %w", err)
	}

	if len(monitors) == 0 {
		log.Println("[Pulse] No monitors are currently due for execution.")
		return nil
	}

	log.Printf("[Pulse] Claimed %d due monitor(s) (batch limit: %d) for keep-alive and check execution.\n", len(monitors), batchSize)

	// 4. Process monitors concurrently with bounded worker pool
	concurrency := e.cfg.Concurrency
	if concurrency <= 0 {
		concurrency = 10
	}
	if concurrency > len(monitors) {
		concurrency = len(monitors)
	}

	workChan := make(chan model.Monitor, len(monitors))
	for _, m := range monitors {
		workChan <- m
	}
	close(workChan)

	var wg sync.WaitGroup
	var errOnce sync.Once
	var firstErr error

	for i := 0; i < concurrency; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-ctx.Done():
					return
				case m, ok := <-workChan:
					if !ok {
						return
					}
					if ctx.Err() != nil {
						return
					}
					if err := e.processMonitor(ctx, m); err != nil {
						log.Printf("[Pulse] Error processing monitor %s (%s): %v\n", m.Name, m.URL, err)
						errOnce.Do(func() {
							firstErr = err
						})
					}
				}
			}
		}()
	}

	wg.Wait()

	if ctx.Err() != nil {
		log.Printf("[Pulse] Monitoring cycle interrupted by context cancellation/timeout: %v\n", ctx.Err())
		return ctx.Err()
	}

	log.Println("[Pulse] Monitoring cycle finished successfully.")
	return firstErr
}

// processMonitor handles the full probe lifecycle for a single monitor.
func (e *Engine) processMonitor(ctx context.Context, m model.Monitor) error {
	now := time.Now().UTC()

	// Check if this monitor is in an active maintenance window
	inMaintenance, err := e.repo.IsMonitorInMaintenance(ctx, m.UserID, m.ID, now)
	if err != nil {
		log.Printf("[Pulse] Warning: maintenance check failed for %s, assuming false: %v\n", m.ID, err)
		inMaintenance = false
	}

	// Execute HTTP keep-alive probe
	result := e.checker.Check(ctx, &m, inMaintenance)

	log.Printf("[Pulse] Monitor %q (%s) -> Status: %s, Code: %d, Latency: %dms, Retry: %v\n",
		m.Name, m.URL, result.Status, result.StatusCode, result.ResponseTimeMs, result.IsRetry)

	// Persist the probe result in checks table
	checkRecord := &model.Check{
		MonitorID:      m.ID,
		UserID:         m.UserID,
		CheckedAt:      now,
		Status:         result.Status,
		StatusCode:     result.StatusCode,
		ResponseTimeMs: result.ResponseTimeMs,
		ErrorMessage:   result.ErrorMessage,
		IsRetry:        result.IsRetry,
	}

	if err := e.repo.RecordCheck(ctx, checkRecord); err != nil {
		return fmt.Errorf("failed to record check: %w", err)
	}

	// Process incident detection / recovery, advance next_check_at, and update monitor status
	if err := e.repo.ProcessIncidentAndStatus(ctx, &m, result, inMaintenance, now); err != nil {
		return fmt.Errorf("failed to process incident and monitor status: %w", err)
	}

	return nil
}
