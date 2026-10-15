PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS ingest_request_windows (
  contributor_id TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ingest_request_windows_expiry ON ingest_request_windows(window_start);
CREATE TABLE IF NOT EXISTS images (
  image_id TEXT PRIMARY KEY,
  source_url TEXT NOT NULL,
  source_page_url TEXT NOT NULL DEFAULT '',
  file_path TEXT,
  mime_type TEXT,
  file_size INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT,
  prompt TEXT NOT NULL DEFAULT '',
  negative_prompt TEXT NOT NULL DEFAULT '',
  tags_json TEXT NOT NULL DEFAULT '[]',
  model_name TEXT NOT NULL DEFAULT '',
  creator_name TEXT NOT NULL DEFAULT '',
  loras_json TEXT NOT NULL DEFAULT '[]',
  reactions_json TEXT NOT NULL DEFAULT '{}',
  image_width INTEGER NOT NULL DEFAULT 0,
  image_height INTEGER NOT NULL DEFAULT 0,
  style_category TEXT NOT NULL DEFAULT 'uncertain' CHECK(style_category IN ('anime','realistic','uncertain')),
  style_confidence REAL NOT NULL DEFAULT 0,
  style_signals_json TEXT NOT NULL DEFAULT '[]',
  download_status TEXT NOT NULL DEFAULT 'pending' CHECK(download_status IN ('pending','ready','failed')),
  download_attempts INTEGER NOT NULL DEFAULT 0,
  download_error TEXT NOT NULL DEFAULT '',
  discovered_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS images_category_id ON images(style_category, image_id DESC);
CREATE INDEX IF NOT EXISTS images_download_status ON images(download_status, discovered_at);
CREATE INDEX IF NOT EXISTS images_sha256 ON images(sha256) WHERE sha256 IS NOT NULL;
CREATE INDEX IF NOT EXISTS images_file_usage ON images(file_path,file_size) WHERE file_path IS NOT NULL AND file_path<>'' AND file_size>0;
CREATE INDEX IF NOT EXISTS images_numeric_order ON images(length(image_id) DESC, image_id DESC);
-- Terminal collection skips prevent oversized images from being rediscovered and retried.
CREATE TABLE IF NOT EXISTS image_collection_skips (
  image_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0,
  skipped_at TEXT NOT NULL
);
-- Per-tab transfer preferences use a hash of a browser-generated random capability.
CREATE TABLE IF NOT EXISTS download_lanes (
  lane_key TEXT PRIMARY KEY CHECK(length(lane_key)=64),
  concurrency INTEGER NOT NULL DEFAULT 32 CHECK(concurrency BETWEEN 4 AND 32),
  updated_at TEXT NOT NULL,
  last_served_at TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS image_download_lanes (
  image_id TEXT PRIMARY KEY REFERENCES images(image_id) ON DELETE CASCADE,
  lane_key TEXT NOT NULL REFERENCES download_lanes(lane_key) ON DELETE CASCADE,
  download_status TEXT NOT NULL DEFAULT 'pending' CHECK(download_status IN ('pending','ready','failed'))
);
CREATE INDEX IF NOT EXISTS image_download_lane_queue ON image_download_lanes(lane_key,image_id);
CREATE INDEX IF NOT EXISTS image_download_lane_status ON image_download_lanes(lane_key,download_status);
CREATE TRIGGER IF NOT EXISTS image_download_lane_status_changed AFTER UPDATE OF download_status ON images
WHEN OLD.download_status<>NEW.download_status BEGIN
  UPDATE image_download_lanes SET download_status=NEW.download_status WHERE image_id=NEW.image_id;
END;
-- Community votes are independent of the source site's reactions_json metadata.
CREATE TABLE IF NOT EXISTS community_reaction_settings (
  setting_key TEXT PRIMARY KEY,
  setting_value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS community_reactions (
  image_id TEXT NOT NULL REFERENCES images(image_id) ON DELETE CASCADE,
  visitor_hash TEXT NOT NULL CHECK(length(visitor_hash)=64),
  reaction_type TEXT NOT NULL CHECK(reaction_type IN ('upvote','heart','laugh','wow')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(image_id, visitor_hash, reaction_type)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS community_reaction_counts (
  image_id TEXT PRIMARY KEY REFERENCES images(image_id) ON DELETE CASCADE,
  upvote INTEGER NOT NULL DEFAULT 0 CHECK(upvote>=0),
  heart INTEGER NOT NULL DEFAULT 0 CHECK(heart>=0),
  laugh INTEGER NOT NULL DEFAULT 0 CHECK(laugh>=0),
  wow INTEGER NOT NULL DEFAULT 0 CHECK(wow>=0)
);
CREATE INDEX IF NOT EXISTS community_reaction_ranking ON community_reaction_counts(upvote DESC, length(image_id) DESC, image_id DESC);
CREATE TRIGGER IF NOT EXISTS community_reaction_added AFTER INSERT ON community_reactions BEGIN
  INSERT INTO community_reaction_counts(image_id,upvote,heart,laugh,wow)
  VALUES(NEW.image_id,NEW.reaction_type='upvote',NEW.reaction_type='heart',NEW.reaction_type='laugh',NEW.reaction_type='wow')
  ON CONFLICT(image_id) DO UPDATE SET
    upvote=upvote+excluded.upvote,heart=heart+excluded.heart,laugh=laugh+excluded.laugh,wow=wow+excluded.wow;
END;
CREATE TRIGGER IF NOT EXISTS community_reaction_removed AFTER DELETE ON community_reactions BEGIN
  UPDATE community_reaction_counts SET upvote=upvote-(OLD.reaction_type='upvote'),
    heart=heart-(OLD.reaction_type='heart'),laugh=laugh-(OLD.reaction_type='laugh'),wow=wow-(OLD.reaction_type='wow')
  WHERE image_id=OLD.image_id;
END;
CREATE TABLE IF NOT EXISTS community_reaction_windows (
  bucket_key TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  request_count INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS community_reaction_windows_expiry ON community_reaction_windows(expires_at);
CREATE VIRTUAL TABLE IF NOT EXISTS images_fts USING fts5(
  image_id UNINDEXED, prompt, negative_prompt, tags, model_name, lora_names,
  tokenize='unicode61 remove_diacritics 2'
);
