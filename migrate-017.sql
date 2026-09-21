-- Migration 017: Add previous_role and archive_reason to contacts for player archive
ALTER TABLE contacts ADD COLUMN previous_role TEXT;
ALTER TABLE contacts ADD COLUMN archive_reason TEXT;

