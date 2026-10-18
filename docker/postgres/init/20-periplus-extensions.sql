-- Runs once on an empty data directory (after the PostGIS image's own init script).
-- Migrations create the extensions too (IF NOT EXISTS); this makes a fresh dev database usable immediately.
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS postgis_raster;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
