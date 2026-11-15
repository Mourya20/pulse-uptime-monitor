package main

import (
	"context"
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
	log.Println("[Pulse] Keep-Alive & Uptime Monitor starting...")

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

	// 5. Execute scheduled monitoring cycle
	runStart := time.Now()
	if err := eng.Run(ctx); err != nil {
		log.Fatalf("[Pulse] Monitoring cycle finished with errors: %v (elapsed: %v)\n", err, time.Since(runStart))
	}

	log.Printf("[Pulse] Monitoring cycle completed successfully in %v.\n", time.Since(runStart))
}
