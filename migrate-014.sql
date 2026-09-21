-- Migration 014: Add email tracking columns to polls table
ALTER TABLE polls ADD COLUMN last_sent_at TEXT DEFAULT NULL;
ALTER TABLE polls ADD COLUMN sent_count INTEGER DEFAULT 0;

