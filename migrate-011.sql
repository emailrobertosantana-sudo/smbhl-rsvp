-- Migration 011: Add etransfer_phone to season_pricing
ALTER TABLE season_pricing ADD COLUMN etransfer_phone TEXT;

