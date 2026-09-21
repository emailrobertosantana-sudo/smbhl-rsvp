-- Migration 015: Add show_on_rsvp column to polls table
ALTER TABLE polls ADD COLUMN show_on_rsvp INTEGER NOT NULL DEFAULT 0;

