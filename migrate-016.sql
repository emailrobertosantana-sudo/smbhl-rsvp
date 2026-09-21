-- Migration 016: Add show_results column to polls table (default: 0 / private voting)
ALTER TABLE polls ADD COLUMN show_results INTEGER NOT NULL DEFAULT 0;

