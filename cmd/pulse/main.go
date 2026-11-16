package main

import (
	"context"
	"flag"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/Mourya20/pulse-uptime-monitor/internal/checker"
	"github.com/Mourya20/pulse-uptime-monitor/internal/config"
	"github.com/Mourya20/pulse-uptime-monitor/internal/db"
	"github.com/Mourya20/pulse-uptime-monitor/internal/engine"
)

func main() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)

	daemonFlag := flag.Bool("daemon", false, "Run continuously as a persistent background daemon")
	flag.BoolVar(daemonFlag, "d", false, "Run continuously as a persistent background daemon (shorthand)")
	intervalFlag := flag.Duration("interval", 1*time.Minute, "Polling interval between cycles in daemon mode")
	flag.Parse()

	isDaemon := *daemonFlag || os.Getenv("PULSE_DAEMON") == "true"
	if isDaemon {
		log.Printf("[Pulse] Keep-Alive & Uptime Monitor starting in continuous DAEMON mode (cycle interval: %v)...\n", *intervalFlag)
	} else {
		log.Println("[Pulse] Keep-Alive & Uptime Monitor starting (single-cycle runner mode)...")
	}

	// 1. Load configuration
	cfg, err := config.LoadFromEnv()
	if err != nil {
		log.Fatalf("[Pulse] Configuration error: %v\n", err)
	}

	// 2. Set up graceful cancellation context
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// 3. Connect to PostgreSQL database
	dbPool, err := db.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("[Pulse] Database connection failed: %v\n", err)
	}
	defer dbPool.Close()

	// 4. Initialize monitoring checker and engine
	chk := checker.NewChecker()
	eng := engine.NewEngine(cfg, dbPool, chk)

	// Single cycle execution helper
	runCycle := func() {
		cycleCtx, cancel := context.WithTimeout(ctx, 4*time.Minute)
		defer cancel()

		runStart := time.Now()
		if err := eng.Run(cycleCtx); err != nil && ctx.Err() == nil {
			log.Printf("[Pulse] Monitoring cycle finished with errors: %v (elapsed: %v)\n", err, time.Since(runStart))
		} else {
			log.Printf("[Pulse] Monitoring cycle completed successfully in %v.\n", time.Since(runStart))
		}
	}

	// 5. Execute monitoring
	runCycle()

	if !isDaemon {
		return
	}

	// In daemon mode, loop continuously every interval
	ticker := time.NewTicker(*intervalFlag)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			log.Println("[Pulse] Shutdown signal received. Exiting daemon cleanly.")
			return
		case <-ticker.C:
			runCycle()
		}
	}
}
