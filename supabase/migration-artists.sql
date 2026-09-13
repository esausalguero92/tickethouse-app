-- ════════════════════════════════════════════════════════════════════
-- migration-artists.sql
-- Adds: artists table, event_artists junction table
-- ════════════════════════════════════════════════════════════════════

-- Artists master table
CREATE TABLE IF NOT EXISTS artists (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  bio         TEXT,
  genres      TEXT[] DEFAULT '{}',
  photo_url   TEXT,
  instagram   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS artists_updated_at ON artists;
CREATE TRIGGER artists_updated_at
  BEFORE UPDATE ON artists
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Event ↔ Artist junction
CREATE TABLE IF NOT EXISTS event_artists (
  event_id    UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  artist_id   UUID NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  role        TEXT DEFAULT 'performer',
  sort_order  INTEGER DEFAULT 0,
  PRIMARY KEY (event_id, artist_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS event_artists_event_idx  ON event_artists(event_id);
CREATE INDEX IF NOT EXISTS event_artists_artist_idx ON event_artists(artist_id);

-- RLS: allow public read-only access to artists
ALTER TABLE artists ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_artists ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "artists_public_read" ON artists;
CREATE POLICY "artists_public_read" ON artists
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "event_artists_public_read" ON event_artists;
CREATE POLICY "event_artists_public_read" ON event_artists
  FOR SELECT USING (true);

-- service_role bypasses RLS — admin operations use service_role key
