package db

import (
	"context"
	"fmt"
	"time"

	"github.com/Mourya20/pulse-uptime-monitor/internal/checker"
	"github.com/Mourya20/pulse-uptime-monitor/internal/model"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Repository defines all database interactions required by the monitoring engine.
type Repository interface {
	ClaimDueMonitors(ctx context.Context) ([]model.Monitor, error)
	IsMonitorInMaintenance(ctx context.Context, userID, monitorID string, at time.Time) (bool, error)
	RecordCheck(ctx context.Context, check *model.Check) error
	ProcessIncidentAndStatus(ctx context.Context, m *model.Monitor, res checker.Result, inMaintenance bool, checkedAt time.Time) error
	AcquireAdvisoryLock(ctx context.Context, lockKey int64) (func(), bool, error)
	Close()
}

// PgxDB implements Repository using pgxpool and raw SQL.
type PgxDB struct {
	pool *pgxpool.Pool
}

// Connect establishes a connection pool to PostgreSQL.
func Connect(ctx context.Context, databaseURL string) (*PgxDB, error) {
	cfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("failed to parse database URL: %w", err)
	}

	cfg.MaxConns = 10
	cfg.MinConns = 2
	cfg.MaxConnIdleTime = 5 * time.Minute

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("failed to create database connection pool: %w", err)
	}

	// Verify connection
	pingCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	if err := pool.Ping(pingCtx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("failed to ping database: %w", err)
	}

	return &PgxDB{pool: pool}, nil
}

// Close closes the underlying pool.
func (d *PgxDB) Close() {
	if d.pool != nil {
		d.pool.Close()
	}
}

// AcquireAdvisoryLock acquires a PostgreSQL session-level advisory lock using a dedicated connection.
// Returns an unlock cleanup function and true if the lock was acquired, or false if already locked.
func (d *PgxDB) AcquireAdvisoryLock(ctx context.Context, lockKey int64) (func(), bool, error) {
	conn, err := d.pool.Acquire(ctx)
	if err != nil {
		return nil, false, fmt.Errorf("failed to acquire connection for advisory lock: %w", err)
	}

	var acquired bool
	err = conn.QueryRow(ctx, "SELECT pg_try_advisory_lock($1)", lockKey).Scan(&acquired)
	if err != nil {
		conn.Release()
		return nil, false, fmt.Errorf("error querying pg_try_advisory_lock: %w", err)
	}

	if !acquired {
		conn.Release()
		return nil, false, nil
	}

	unlock := func() {
		defer conn.Release()
		unlockCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, _ = conn.Exec(unlockCtx, "SELECT pg_advisory_unlock($1)", lockKey)
	}

	return unlock, true, nil
}

// ClaimDueMonitors selects due monitors and atomically advances their next_check_at
// in a short transaction, preventing duplicate processing and catch-up bursts.
func (d *PgxDB) ClaimDueMonitors(ctx context.Context) ([]model.Monitor, error) {
	tx, err := d.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, fmt.Errorf("failed to begin transaction to claim monitors: %w", err)
	}
	defer tx.Rollback(ctx)

	query := `
		SELECT id, user_id, name, url, interval_minutes, timeout_seconds, degraded_threshold_ms,
		       is_paused, current_status, last_checked_at, next_check_at, created_at, updated_at
		FROM public.monitors
		WHERE is_paused = false
		  AND (next_check_at IS NULL OR next_check_at <= NOW())
		ORDER BY next_check_at ASC NULLS FIRST
		FOR UPDATE SKIP LOCKED;
	`

	rows, err := tx.Query(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("querying due monitors failed: %w", err)
	}
	defer rows.Close()

	var monitors []model.Monitor
	var monitorIDs []string

	for rows.Next() {
		var m model.Monitor
		err := rows.Scan(
			&m.ID, &m.UserID, &m.Name, &m.URL, &m.IntervalMinutes,
			&m.TimeoutSeconds, &m.DegradedThresholdMs, &m.IsPaused,
			&m.CurrentStatus, &m.LastCheckedAt, &m.NextCheckAt,
			&m.CreatedAt, &m.UpdatedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("scanning monitor row failed: %w", err)
		}
		monitors = append(monitors, m)
		monitorIDs = append(monitorIDs, m.ID)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("rows iteration failed: %w", err)
	}

	// Advance next_check_at for all claimed monitors to NOW() + interval
	if len(monitorIDs) > 0 {
		updateQuery := `
			UPDATE public.monitors
			SET next_check_at = NOW() + (interval_minutes || ' minutes')::INTERVAL,
			    updated_at = NOW()
			WHERE id = ANY($1);
		`
		if _, err := tx.Exec(ctx, updateQuery, monitorIDs); err != nil {
			return nil, fmt.Errorf("failed to advance next_check_at for claimed monitors: %w", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("failed to commit claimed monitors transaction: %w", err)
	}

	return monitors, nil
}

// IsMonitorInMaintenance checks if a monitor or all monitors for the user are in an active maintenance window.
func (d *PgxDB) IsMonitorInMaintenance(ctx context.Context, userID, monitorID string, at time.Time) (bool, error) {
	query := `
		SELECT EXISTS(
			SELECT 1 FROM public.maintenance_windows
			WHERE user_id = $1
			  AND (monitor_id IS NULL OR monitor_id = $2)
			  AND start_time <= $3
			  AND end_time >= $3
		);
	`
	var inMaintenance bool
	err := d.pool.QueryRow(ctx, query, userID, monitorID, at).Scan(&inMaintenance)
	if err != nil {
		return false, fmt.Errorf("failed to check maintenance status: %w", err)
	}
	return inMaintenance, nil
}

// RecordCheck saves the check execution result to the checks table.
func (d *PgxDB) RecordCheck(ctx context.Context, c *model.Check) error {
	query := `
		INSERT INTO public.checks (
			id, monitor_id, user_id, checked_at, status, status_code, response_time_ms, error_message, is_retry
		) VALUES (
			gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8
		);
	`
	_, err := d.pool.Exec(ctx, query,
		c.MonitorID, c.UserID, c.CheckedAt, c.Status,
		c.StatusCode, c.ResponseTimeMs, c.ErrorMessage, c.IsRetry,
	)
	if err != nil {
		return fmt.Errorf("failed to insert check record: %w", err)
	}
	return nil
}

// ProcessIncidentAndStatus manages incident transitions and updates monitor status in a single transaction.
func (d *PgxDB) ProcessIncidentAndStatus(ctx context.Context, m *model.Monitor, res checker.Result, inMaintenance bool, checkedAt time.Time) error {
	tx, err := d.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("failed to begin incident transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	// Determine final display status for monitor
	finalStatus := res.Status
	if inMaintenance {
		finalStatus = model.StatusMaintenance
	}

	// 1. Process outage incidents
	if res.Status == model.StatusDown && !inMaintenance {
		// Outage detected outside maintenance: check if active incident already exists
		var existingID string
		err := tx.QueryRow(ctx, `
			SELECT id FROM public.incidents
			WHERE monitor_id = $1 AND resolved_at IS NULL
			LIMIT 1;
		`, m.ID).Scan(&existingID)

		if err == pgx.ErrNoRows {
			// No active incident: create new incident
			var httpStatus *int
			if res.StatusCode > 0 {
				code := res.StatusCode
				httpStatus = &code
			}

			insertIncident := `
				INSERT INTO public.incidents (
					id, monitor_id, user_id, started_at, root_cause, http_status, error_details
				) VALUES (
					gen_random_uuid(), $1, $2, $3, $4, $5, $6
				);
			`
			_, err = tx.Exec(ctx, insertIncident,
				m.ID, m.UserID, checkedAt, res.RootCause, httpStatus, res.ErrorMessage,
			)
			if err != nil {
				return fmt.Errorf("failed to create incident: %w", err)
			}
		} else if err != nil {
			return fmt.Errorf("failed to query active incident: %w", err)
		}
	} else if res.Status == model.StatusUp || res.Status == model.StatusDegraded {
		// Service recovered: resolve any active incident
		var incidentID string
		var startedAt time.Time

		err := tx.QueryRow(ctx, `
			SELECT id, started_at FROM public.incidents
			WHERE monitor_id = $1 AND resolved_at IS NULL
			LIMIT 1;
		`, m.ID).Scan(&incidentID, &startedAt)

		if err == nil {
			// Found active incident: resolve it
			updateIncident := `
				UPDATE public.incidents
				SET resolved_at = $1,
				    duration_seconds = GREATEST(0, EXTRACT(EPOCH FROM ($1 - started_at))::INT)
				WHERE id = $2;
			`
			if _, err := tx.Exec(ctx, updateIncident, checkedAt, incidentID); err != nil {
				return fmt.Errorf("failed to resolve active incident: %w", err)
			}
		} else if err != pgx.ErrNoRows {
			return fmt.Errorf("failed querying incident for recovery: %w", err)
		}
	}

	// 2. Update monitor status and last_checked_at
	updateMonitor := `
		UPDATE public.monitors
		SET current_status = $1,
		    last_checked_at = $2,
		    updated_at = $2
		WHERE id = $3;
	`
	if _, err := tx.Exec(ctx, updateMonitor, finalStatus, checkedAt, m.ID); err != nil {
		return fmt.Errorf("failed to update monitor status: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("failed to commit incident and monitor update: %w", err)
	}

	return nil
}
