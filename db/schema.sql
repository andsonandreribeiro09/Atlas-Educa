PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS journals (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  official_site_url TEXT,
  official_oai_url TEXT,
  educa_source_url TEXT NOT NULL,
  educa_first_year INTEGER,
  educa_latest_year INTEGER,
  educa_harvest_status TEXT NOT NULL DEFAULT 'pending',
  official_harvest_status TEXT NOT NULL DEFAULT 'pending',
  comparison_status TEXT NOT NULL DEFAULT 'pending',
  last_processed_at TEXT,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS articles (
  id INTEGER PRIMARY KEY,
  journal_id TEXT NOT NULL REFERENCES journals(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('educa', 'official')),
  source_identifier TEXT NOT NULL,
  title TEXT NOT NULL,
  normalized_title TEXT NOT NULL,
  authors_json TEXT NOT NULL DEFAULT '[]',
  publication_date TEXT,
  publication_year INTEGER NOT NULL,
  volume TEXT,
  issue TEXT,
  doi TEXT,
  url TEXT,
  document_type TEXT NOT NULL DEFAULT 'article',
  section TEXT,
  source_citation TEXT,
  harvested_at TEXT NOT NULL,
  UNIQUE (journal_id, source, source_identifier)
);

CREATE TABLE IF NOT EXISTS comparisons (
  id INTEGER PRIMARY KEY,
  journal_id TEXT NOT NULL REFERENCES journals(id) ON DELETE CASCADE,
  official_article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  educa_article_id INTEGER REFERENCES articles(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('matched', 'missing_candidate', 'outside_educa_coverage')),
  match_method TEXT,
  match_score REAL,
  compared_at TEXT NOT NULL,
  UNIQUE (journal_id, official_article_id)
);

CREATE TABLE IF NOT EXISTS processing_runs (
  id INTEGER PRIMARY KEY,
  journal_id TEXT NOT NULL REFERENCES journals(id) ON DELETE CASCADE,
  phase TEXT NOT NULL,
  status TEXT NOT NULL,
  records_processed INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_articles_journal_source_year
ON articles (journal_id, source, publication_year);

CREATE INDEX IF NOT EXISTS idx_articles_journal_source_doi
ON articles (journal_id, source, doi)
WHERE doi IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_articles_journal_source_title
ON articles (journal_id, source, normalized_title);

CREATE INDEX IF NOT EXISTS idx_comparisons_journal_status
ON comparisons (journal_id, status);

CREATE INDEX IF NOT EXISTS idx_processing_runs_journal_phase
ON processing_runs (journal_id, phase, started_at);

PRAGMA optimize;
