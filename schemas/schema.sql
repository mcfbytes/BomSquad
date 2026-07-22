-- BOM Squad — complete SQLite schema.
--
-- Spec: docs/data-model.md 2.0.0 (Appendix A tables, Appendix B views)
--     + docs/coverage.md   2.0.0 §3.4 (four coverage views)
--     + docs/data-quality.md 2.0.0 Appendix Q (six quality views)
--
-- 36 tables · 21 views · 34 explicit indexes.
-- The counts above are read back from sqlite_master by pipeline/test/schema.test.ts,
-- which fails if this comment and the DDL disagree.
--
-- Dialect: SQLite >= 3.44. Verified against node:sqlite 3.51.3 (build side) and
-- @sqlite.org/sqlite-wasm 3.53.0 (browser side, docs/adr/0001-browser-database.md).
-- Nothing here is engine-specific: STRICT (3.37), WITHOUT ROWID (3.8.2), partial
-- indexes (3.8.0), expression indexes (3.9.0), GLOB character classes (all versions).
-- No generated columns, no RETURNING, no window functions, no triggers.
--
-- ---------------------------------------------------------------------------
-- Deltas from data-model.md Appendix A. Every one is a constraint TIGHTENING on
-- a table with no published rows, so none carries a migration. Each deletes
-- hand-written validation somewhere else.
--
--  D1  Slug / identifier grammar CHECKs (§3.2) on every key column.
--      data-model §5.4 routes the slug grammar to "a linter — SQLite GLOB cannot
--      express the full regex". It can: a conjunction of four GLOB terms is exactly
--      ^[a-z0-9]+(?:-[a-z0-9]+)*$ (see "grammar" comments below). The linter row of
--      §5.4 is therefore deleted.
--  D2  ux_chip_equivalence_pair — the unordered-pair unique index proposed in
--      coverage.md §5.2. Adopted. Deletes coverage checks V4 and the 2-cycle half of V5.
--  D3  trim(x) <> '' on every NOT NULL prose/display column. Deletes coverage check V7a.
--  D4  Non-blank + shape CHECKs on URL columns (http/https, no spaces).
--  D5  chip_name / system_name: name <> the row's own id, and a 'retired_id' name must
--      itself be slug-shaped. Narrows data-quality §3.3 RETIRED_ID_COLLISION to the
--      genuinely cross-table half.
--  D6  ux_machine_chip_tag / ux_machine_chip_correction_tag — the partial unique index
--      that restores the real key (machine_id, mame_tag) -> chip. MAME tags are unique
--      within a machine, so two chips in one socket is a 2NF violation, not data.
--      The tagless ':device' sentinel is the genuine exception and is excluded.
--  D7  implementation: verified_against_hardware = 1 requires notes (data-model §1.4
--      states the rule in prose; it is expressible).
--  D8  machine_chip_correction: op='remove' carries no value columns; op='set' must set
--      at least one. Both are no-op/contradictory corrections the loader would silently ignore.
--  D9  manufacturer.country restricted to ISO 3166-1 alpha-2 shape.
--  D10 implementation: an 'original_silicon' row carries no repo_url, hdl_language_id,
--      license_id or accuracy_id. Physical silicon is not a codebase; without this the
--      quality views raise licence/accuracy warnings no curator can ever clear.
--  D11 threshold — a typed table (REAL, NOT NULL, >= 0) replacing the untyped
--      dataset_meta 'threshold.*' rows the quality views used to CAST. A malformed or
--      missing threshold now fails the load instead of silently disabling a gate.
--
-- Deliberate NON-delta: implementation_kind.kind_id takes the underscore-permitting
-- identifier grammar, not the strict slug. data-model §3.2 says slug applies to every
-- lookup key, but the seeded literals are 'fpga_hdl' / 'software_emulation' /
-- 'original_silicon'; renaming them is a data migration, not a grammar fix.
-- Flagged for reconciliation.
--
-- No reusable view filters on a kind: every one of them exposes kind_id as a column
-- (coverage.md §3.2) and the caller filters. A kind literal appears below only where the
-- fact is intrinsic to that kind — 'fpga_hdl' in v_prospector, which is by definition
-- about FPGA cores, and 'original_silicon' in D10 and in the two warning branches D10
-- makes unclearable. Nothing else names a kind.
-- ---------------------------------------------------------------------------
--
-- GRAMMARS (docs/data-model.md §3.2), each as a GLOB conjunction:
--
--   slug            ^[a-z0-9]+(?:-[a-z0-9]+)*$        x GLOB '[a-z0-9]*'          -- non-empty, opens alnum
--                                                 AND x NOT GLOB '*[^a-z0-9-]*'  -- alphabet
--                                                 AND x NOT GLOB '*-'            -- no trailing separator
--                                                 AND x NOT GLOB '*--*'          -- no empty segment
--                                                 AND length(x) <= 64
--   identifier      ^[a-z0-9]+(?:[_-][a-z0-9]+)*$     as slug, alphabet [a-z0-9_-], no '--' '__' '-_' '_-'
--   spdx_id         ^[A-Za-z0-9.+-]{1,64}$
--   mame_shortname  ^[a-z0-9_]{1,32}$
--   mame_device_key ^[a-z0-9_]{1,64}$
--   mame_tag        ^:device$|^[a-z0-9_]+(?:[.:][a-z0-9_]+)*$
--   sourcefile      ^[a-z0-9_]+(?:/[a-z0-9_]+)*\.cpp$
--   repo_path       ^[A-Za-z0-9._+-]+(?:/[A-Za-z0-9._+-]+)*$   1–256 characters
--   meta_key        ^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$         1–64 characters
--   date            ^[0-9]{4}-[0-9]{2}-[0-9]{2}$
--   url             ^https?://.+$ with no space
--
-- Every grammar above is proved equal to its JSON Schema `pattern` by brute force in
-- pipeline/test/schema.test.ts: the same corpus is offered to the DDL and to the regex,
-- and any string the two disagree about fails the test.
--
-- INDEX POLICY. One index per foreign key whose child column is not already the
-- leftmost column of the table's primary key (a WITHOUT ROWID table's PK *is* its
-- B-tree, and every index on it carries the PK columns as a suffix, so a leftmost-PK
-- FK is already indexed and a second index would be dead weight). Plus the columns
-- the canonical queries of data-model.md §6 join or filter on. Nothing else: every
-- index below names the query or the ON DELETE action it serves.

PRAGMA page_size = 4096;
PRAGMA encoding = 'UTF-8';
-- must not be executed inside a transaction: SQLite silently ignores this pragma
-- between BEGIN and COMMIT, leaving a database with no referential enforcement at all
-- and no error to say so. applySchema() reads the value back and throws if it is not 1.
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- 0. Schema identity
-- ---------------------------------------------------------------------------

-- The schema's own version, written by the DDL, so a database is self-identifying the
-- instant it exists and before any row file is read. There is exactly one copy of it:
-- the major component here. dataset_meta.schema_version is the *dataset's* claim about
-- which schema it was built for — a different subject, stored once, in one place.
PRAGMA user_version = 2;

-- ---------------------------------------------------------------------------
-- 1. Lookup tables (data-model §1.1)
-- ---------------------------------------------------------------------------

CREATE TABLE manufacturer (
  manufacturer_id TEXT PRIMARY KEY
    CHECK (manufacturer_id GLOB '[a-z0-9]*' AND manufacturer_id NOT GLOB '*[^a-z0-9-]*'
           AND manufacturer_id NOT GLOB '*-' AND manufacturer_id NOT GLOB '*--*'
           AND length(manufacturer_id) <= 64),
  name            TEXT NOT NULL CHECK (trim(name) <> ''),
  country         TEXT CHECK (country IS NULL OR (length(country) = 2 AND country GLOB '[A-Z][A-Z]')),
  notes           TEXT CHECK (notes IS NULL OR trim(notes) <> '')
) STRICT, WITHOUT ROWID;

CREATE TABLE manufacturer_alias (
  alias           TEXT PRIMARY KEY CHECK (trim(alias) <> ''),
  manufacturer_id TEXT NOT NULL REFERENCES manufacturer(manufacturer_id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
-- FK child lookup for ON DELETE CASCADE; also "every spelling of this manufacturer" on the manufacturer page.
CREATE INDEX ix_manufacturer_alias_manufacturer ON manufacturer_alias(manufacturer_id);

CREATE TABLE license (
  license_id      TEXT PRIMARY KEY  -- grammar: spdx_id (§3.2 exempts license_id from slug)
    CHECK (license_id GLOB '?*' AND license_id NOT GLOB '*[^A-Za-z0-9.+-]*'
           AND length(license_id) <= 64),
  name            TEXT NOT NULL CHECK (trim(name) <> ''),
  url             TEXT CHECK (url IS NULL OR ((url GLOB 'http://?*' OR url GLOB 'https://?*')
                                              AND url NOT GLOB '* *')),
  is_osi_approved INTEGER NOT NULL CHECK (is_osi_approved IN (0,1))
) STRICT, WITHOUT ROWID;

CREATE TABLE chip_function (
  function_id     TEXT PRIMARY KEY
    CHECK (function_id GLOB '[a-z0-9]*' AND function_id NOT GLOB '*[^a-z0-9-]*'
           AND function_id NOT GLOB '*-' AND function_id NOT GLOB '*--*'
           AND length(function_id) <= 64),
  label           TEXT NOT NULL CHECK (trim(label) <> ''),
  description     TEXT NOT NULL CHECK (trim(description) <> ''),
  prospector_band TEXT NOT NULL CHECK (prospector_band IN ('hard','medium','soft'))
) STRICT, WITHOUT ROWID;

CREATE TABLE chip_family (
  family_id       TEXT PRIMARY KEY
    CHECK (family_id GLOB '[a-z0-9]*' AND family_id NOT GLOB '*[^a-z0-9-]*'
           AND family_id NOT GLOB '*-' AND family_id NOT GLOB '*--*'
           AND length(family_id) <= 64),
  name            TEXT NOT NULL CHECK (trim(name) <> ''),
  manufacturer_id TEXT REFERENCES manufacturer(manufacturer_id) ON DELETE RESTRICT,
  description     TEXT CHECK (description IS NULL OR trim(description) <> '')
) STRICT, WITHOUT ROWID;
-- FK child lookup for ON DELETE RESTRICT; also "families owned by this manufacturer".
CREATE INDEX ix_chip_family_manufacturer ON chip_family(manufacturer_id);

CREATE TABLE chip_role (
  role_id     TEXT PRIMARY KEY
    CHECK (role_id GLOB '[a-z0-9]*' AND role_id NOT GLOB '*[^a-z0-9-]*'
           AND role_id NOT GLOB '*-' AND role_id NOT GLOB '*--*'
           AND length(role_id) <= 64),
  label       TEXT NOT NULL CHECK (trim(label) <> ''),
  description TEXT CHECK (description IS NULL OR trim(description) <> '')
) STRICT, WITHOUT ROWID;

CREATE TABLE system_kind (
  kind_id TEXT PRIMARY KEY
    CHECK (kind_id GLOB '[a-z0-9]*' AND kind_id NOT GLOB '*[^a-z0-9-]*'
           AND kind_id NOT GLOB '*-' AND kind_id NOT GLOB '*--*'
           AND length(kind_id) <= 64),
  label   TEXT NOT NULL CHECK (trim(label) <> '')
) STRICT, WITHOUT ROWID;

CREATE TABLE hdl_language (
  language_id TEXT PRIMARY KEY
    CHECK (language_id GLOB '[a-z0-9]*' AND language_id NOT GLOB '*[^a-z0-9-]*'
           AND language_id NOT GLOB '*-' AND language_id NOT GLOB '*--*'
           AND length(language_id) <= 64),
  label       TEXT NOT NULL CHECK (trim(label) <> '')
) STRICT, WITHOUT ROWID;

CREATE TABLE fpga_platform (
  platform_id TEXT PRIMARY KEY
    CHECK (platform_id GLOB '[a-z0-9]*' AND platform_id NOT GLOB '*[^a-z0-9-]*'
           AND platform_id NOT GLOB '*-' AND platform_id NOT GLOB '*--*'
           AND length(platform_id) <= 64),
  label       TEXT NOT NULL CHECK (trim(label) <> ''),
  notes       TEXT CHECK (notes IS NULL OR trim(notes) <> '')
) STRICT, WITHOUT ROWID;

-- The generic discriminator (data-model §1.8). Grammar: identifier, not slug — see
-- the "Deliberate NON-delta" note in the header.
CREATE TABLE implementation_kind (
  kind_id     TEXT PRIMARY KEY
    CHECK (kind_id GLOB '[a-z0-9]*' AND kind_id NOT GLOB '*[^a-z0-9_-]*'
           AND kind_id NOT GLOB '*[_-]' AND kind_id NOT GLOB '*[_-][_-]*'
           AND length(kind_id) <= 64),
  label       TEXT NOT NULL CHECK (trim(label) <> ''),
  description TEXT NOT NULL CHECK (trim(description) <> '')
) STRICT, WITHOUT ROWID;

CREATE TABLE accuracy_level (
  accuracy_id TEXT PRIMARY KEY
    CHECK (accuracy_id GLOB '[a-z0-9]*' AND accuracy_id NOT GLOB '*[^a-z0-9-]*'
           AND accuracy_id NOT GLOB '*-' AND accuracy_id NOT GLOB '*--*'
           AND length(accuracy_id) <= 64),
  label       TEXT NOT NULL CHECK (trim(label) <> ''),
  description TEXT NOT NULL CHECK (trim(description) <> '')
) STRICT, WITHOUT ROWID;

-- ---------------------------------------------------------------------------
-- 2. Chips (data-model §1.2)
-- ---------------------------------------------------------------------------

CREATE TABLE chip (
  chip_id          TEXT PRIMARY KEY
    CHECK (chip_id GLOB '[a-z0-9]*' AND chip_id NOT GLOB '*[^a-z0-9-]*'
           AND chip_id NOT GLOB '*-' AND chip_id NOT GLOB '*--*'
           AND length(chip_id) <= 64),
  display_name     TEXT NOT NULL CHECK (trim(display_name) <> ''),
  function_id      TEXT NOT NULL REFERENCES chip_function(function_id) ON DELETE RESTRICT,
  manufacturer_id  TEXT REFERENCES manufacturer(manufacturer_id) ON DELETE RESTRICT,
  family_id        TEXT REFERENCES chip_family(family_id) ON DELETE RESTRICT,
  model            TEXT CHECK (model IS NULL OR trim(model) <> ''),
  description      TEXT CHECK (description IS NULL OR trim(description) <> ''),
  typical_clock_hz INTEGER CHECK (typical_clock_hz IS NULL OR typical_clock_hz > 0),
  package          TEXT CHECK (package IS NULL OR trim(package) <> ''),
  year_introduced  INTEGER CHECK (year_introduced IS NULL OR (year_introduced BETWEEN 1950 AND 2100)),
  notes            TEXT CHECK (notes IS NULL OR trim(notes) <> '')
) STRICT, WITHOUT ROWID;
-- FK child lookup; serves the taxonomy facet "every chip of function X" and Q4's band join.
CREATE INDEX ix_chip_function ON chip(function_id);
-- FK child lookup; serves the manufacturer page's chip list.
CREATE INDEX ix_chip_manufacturer ON chip(manufacturer_id);
-- FK child lookup; serves the family grouping facet that data-model §1.9 added chip_family for.
CREATE INDEX ix_chip_family ON chip(family_id);

CREATE TABLE chip_name (
  chip_id TEXT NOT NULL REFERENCES chip(chip_id) ON DELETE CASCADE,
  name    TEXT NOT NULL CHECK (trim(name) <> ''),
  kind    TEXT NOT NULL CHECK (kind IN ('alias','retired_id')),
  PRIMARY KEY (chip_id, name),
  -- A row naming its own chip is a no-op that would shadow the live id (§3.4).
  CHECK (name <> chip_id),
  -- A retired id was once a chip_id, so it must still be shaped like one.
  CHECK (kind <> 'retired_id' OR (name GLOB '[a-z0-9]*' AND name NOT GLOB '*[^a-z0-9-]*'
                                  AND name NOT GLOB '*-' AND name NOT GLOB '*--*'
                                  AND length(name) <= 64))
) STRICT, WITHOUT ROWID;
-- Makes name -> chip a function (data-model §3.4); serves the alias resolver.
CREATE UNIQUE INDEX ux_chip_name_name ON chip_name(name);

CREATE TABLE chip_datasheet (
  chip_id TEXT NOT NULL REFERENCES chip(chip_id) ON DELETE CASCADE,
  url     TEXT NOT NULL CHECK ((url GLOB 'http://?*' OR url GLOB 'https://?*') AND url NOT GLOB '* *'),
  title   TEXT CHECK (title IS NULL OR trim(title) <> ''),
  PRIMARY KEY (chip_id, url)
) STRICT, WITHOUT ROWID;

CREATE TABLE mame_device (
  mame_device   TEXT PRIMARY KEY  -- grammar: mame_device_key
    CHECK (mame_device GLOB '?*' AND mame_device NOT GLOB '*[^a-z0-9_]*'
           AND length(mame_device) <= 64),
  chip_id       TEXT REFERENCES chip(chip_id) ON DELETE RESTRICT,
  ignore_reason TEXT CHECK (ignore_reason IS NULL OR trim(ignore_reason) <> ''),
  note          TEXT CHECK (note IS NULL OR trim(note) <> ''),
  -- Mapped xor ignored, never both, never neither (data-model §1.2).
  CHECK ((chip_id IS NULL) <> (ignore_reason IS NULL))
) STRICT, WITHOUT ROWID;
-- FK child lookup; serves the chip page's "MAME devices that are this part" list.
CREATE INDEX ix_mame_device_chip ON mame_device(chip_id);

CREATE TABLE chip_equivalence (
  from_chip_id TEXT NOT NULL REFERENCES chip(chip_id) ON DELETE CASCADE,
  to_chip_id   TEXT NOT NULL REFERENCES chip(chip_id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('equivalent','provides')),
  note         TEXT NOT NULL CHECK (trim(note) <> ''),
  PRIMARY KEY (from_chip_id, to_chip_id),
  CHECK (from_chip_id <> to_chip_id),
  CHECK (kind <> 'equivalent' OR from_chip_id < to_chip_id)
) STRICT, WITHOUT ROWID;
-- D2 / coverage.md §5.2: at most one edge per unordered pair. Kills mutual `provides`
-- and an `equivalent` shadowed by a `provides` without any hand-written check.
CREATE UNIQUE INDEX ux_chip_equivalence_pair
  ON chip_equivalence(MIN(from_chip_id, to_chip_id), MAX(from_chip_id, to_chip_id));
-- FK child lookup; serves v_chip_satisfies' socket-side branches.
CREATE INDEX ix_chip_equivalence_to ON chip_equivalence(to_chip_id);

-- ---------------------------------------------------------------------------
-- 3. Hardware (data-model §1.3)
-- ---------------------------------------------------------------------------

CREATE TABLE system (
  system_id       TEXT PRIMARY KEY
    CHECK (system_id GLOB '[a-z0-9]*' AND system_id NOT GLOB '*[^a-z0-9-]*'
           AND system_id NOT GLOB '*-' AND system_id NOT GLOB '*--*'
           AND length(system_id) <= 64),
  name            TEXT NOT NULL CHECK (trim(name) <> ''),
  kind_id         TEXT NOT NULL REFERENCES system_kind(kind_id) ON DELETE RESTRICT,
  manufacturer_id TEXT REFERENCES manufacturer(manufacturer_id) ON DELETE RESTRICT,
  year_introduced INTEGER CHECK (year_introduced IS NULL OR (year_introduced BETWEEN 1950 AND 2100)),
  description     TEXT CHECK (description IS NULL OR trim(description) <> ''),
  notes           TEXT CHECK (notes IS NULL OR trim(notes) <> '')
) STRICT, WITHOUT ROWID;
-- FK child lookup; serves the "arcade / console / handheld" browse facet.
CREATE INDEX ix_system_kind ON system(kind_id);
-- FK child lookup; serves the manufacturer page's system list.
CREATE INDEX ix_system_manufacturer ON system(manufacturer_id);

CREATE TABLE system_name (
  system_id TEXT NOT NULL REFERENCES system(system_id) ON DELETE CASCADE,
  name      TEXT NOT NULL CHECK (trim(name) <> ''),
  kind      TEXT NOT NULL CHECK (kind IN ('alias','retired_id')),
  PRIMARY KEY (system_id, name),
  CHECK (name <> system_id),
  CHECK (kind <> 'retired_id' OR (name GLOB '[a-z0-9]*' AND name NOT GLOB '*[^a-z0-9-]*'
                                  AND name NOT GLOB '*-' AND name NOT GLOB '*--*'
                                  AND length(name) <= 64))
) STRICT, WITHOUT ROWID;
-- Makes name -> system a function (data-model §3.4); serves the alias resolver.
CREATE UNIQUE INDEX ux_system_name_name ON system_name(name);

-- THE BOM.
CREATE TABLE system_chip (
  system_id TEXT NOT NULL REFERENCES system(system_id) ON DELETE CASCADE,
  role_id   TEXT NOT NULL REFERENCES chip_role(role_id) ON DELETE RESTRICT,
  chip_id   TEXT NOT NULL REFERENCES chip(chip_id)      ON DELETE RESTRICT,
  quantity  INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 1),
  clock_hz  INTEGER CHECK (clock_hz IS NULL OR clock_hz > 0),
  note      TEXT CHECK (note IS NULL OR trim(note) <> ''),
  PRIMARY KEY (system_id, role_id, chip_id)
) STRICT, WITHOUT ROWID;
-- Q4 (v_chip_gap.system_count) and v_system_chip_effective's NOT EXISTS on (system_id, chip_id).
CREATE INDEX ix_system_chip_chip ON system_chip(chip_id);
-- FK child lookup for ON DELETE RESTRICT on chip_role; role_id is not a PK prefix.
CREATE INDEX ix_system_chip_role ON system_chip(role_id);

CREATE TABLE system_driver (
  mame_sourcefile TEXT PRIMARY KEY  -- grammar: sourcefile
    CHECK (mame_sourcefile GLOB '*.cpp' AND length(mame_sourcefile) <= 128
           AND substr(mame_sourcefile, 1, length(mame_sourcefile) - 4) GLOB '[a-z0-9_]*'
           AND substr(mame_sourcefile, 1, length(mame_sourcefile) - 4) NOT GLOB '*[^a-z0-9_/]*'
           AND substr(mame_sourcefile, 1, length(mame_sourcefile) - 4) NOT GLOB '*/'
           AND substr(mame_sourcefile, 1, length(mame_sourcefile) - 4) NOT GLOB '*//*'),
  system_id       TEXT NOT NULL REFERENCES system(system_id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
-- FK child lookup for ON DELETE CASCADE; serves the system page's "driver rules" list.
CREATE INDEX ix_system_driver_system ON system_driver(system_id);

-- Generated from MAME. Zero curated columns.
--
-- PARENTS-ONLY. Extraction records parent machines and drops clone rows (TASKS T2.3),
-- so this table holds no clone and therefore needs no parent pointer: clone_count is a
-- base fact MAME states about the parent — how many sets the filter folded away — not
-- an aggregate over rows in this database. Ingesting clone rows later would need a
-- parent_machine_id column back, which is a schema change, not a data change.
CREATE TABLE machine (
  machine_id        TEXT PRIMARY KEY  -- grammar: mame_shortname
    CHECK (machine_id GLOB '?*' AND machine_id NOT GLOB '*[^a-z0-9_]*'
           AND length(machine_id) <= 32),
  name              TEXT NOT NULL CHECK (trim(name) <> ''),
  mame_sourcefile   TEXT NOT NULL  -- grammar: sourcefile
    CHECK (mame_sourcefile GLOB '*.cpp' AND length(mame_sourcefile) <= 128
           AND substr(mame_sourcefile, 1, length(mame_sourcefile) - 4) GLOB '[a-z0-9_]*'
           AND substr(mame_sourcefile, 1, length(mame_sourcefile) - 4) NOT GLOB '*[^a-z0-9_/]*'
           AND substr(mame_sourcefile, 1, length(mame_sourcefile) - 4) NOT GLOB '*/'
           AND substr(mame_sourcefile, 1, length(mame_sourcefile) - 4) NOT GLOB '*//*'),
  mame_year         TEXT CHECK (mame_year IS NULL OR trim(mame_year) <> ''),
  mame_manufacturer TEXT CHECK (mame_manufacturer IS NULL OR trim(mame_manufacturer) <> ''),
  clone_count       INTEGER CHECK (clone_count IS NULL OR clone_count >= 1),
  driver_status     TEXT CHECK (driver_status IS NULL OR driver_status IN ('good','imperfect','preliminary')),
  is_bios           INTEGER NOT NULL CHECK (is_bios IN (0,1)),
  is_device         INTEGER NOT NULL CHECK (is_device IN (0,1)),
  is_mechanical     INTEGER NOT NULL CHECK (is_mechanical IN (0,1))
) STRICT, WITHOUT ROWID;
-- v_machine_system joins system_driver on this column; also "every machine in a driver".
CREATE INDEX ix_machine_sourcefile ON machine(mame_sourcefile);

CREATE TABLE machine_chip (
  machine_id TEXT NOT NULL REFERENCES machine(machine_id) ON DELETE CASCADE,
  mame_tag   TEXT NOT NULL  -- grammar: mame_tag
    CHECK (mame_tag = ':device'
           OR (mame_tag GLOB '[a-z0-9_]*' AND mame_tag NOT GLOB '*[^a-z0-9_.:]*'
               AND mame_tag NOT GLOB '*[.:]' AND mame_tag NOT GLOB '*[.:][.:]*')),
  chip_id    TEXT NOT NULL REFERENCES chip(chip_id) ON DELETE RESTRICT,
  clock_hz   INTEGER CHECK (clock_hz IS NULL OR clock_hz > 0),
  quantity   INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 1),
  PRIMARY KEY (machine_id, mame_tag, chip_id)
) STRICT, WITHOUT ROWID;
-- D6. The real functional dependency is (machine_id, mame_tag) -> chip_id, clock_hz,
-- quantity: a MAME tag names one socket in one machine, and one socket holds one part.
-- Without this, ('outrun','maincpu','m68000') and ('outrun','maincpu','z80') both insert
-- and every coverage number for the system inflates. ':device' rows carry no tag — they
-- are the tagless <device_ref> sentinel — so they are excluded, not keyed.
CREATE UNIQUE INDEX ux_machine_chip_tag
  ON machine_chip(machine_id, mame_tag) WHERE mame_tag <> ':device';
-- Q4 (v_chip_gap.machine_count); also v_machine_bom's NOT EXISTS, which probes
-- (chip_id, machine_id) and so is served by this index's PK suffix, not by the PK itself.
CREATE INDEX ix_machine_chip_chip ON machine_chip(chip_id);

CREATE TABLE machine_unmapped_device (
  machine_id  TEXT NOT NULL REFERENCES machine(machine_id) ON DELETE CASCADE,
  mame_device TEXT NOT NULL  -- grammar: mame_device_key. Deliberately NOT an FK: the row
                             -- exists precisely because mame_device has no such row.
    CHECK (mame_device GLOB '?*' AND mame_device NOT GLOB '*[^a-z0-9_]*'
           AND length(mame_device) <= 64),
  quantity    INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 1),
  PRIMARY KEY (machine_id, mame_device)
) STRICT, WITHOUT ROWID;
-- v_mame_device_worklist's GROUP BY, and data-quality §3.5 STALE_EXTRACT.
CREATE INDEX ix_machine_unmapped_device ON machine_unmapped_device(mame_device);

-- ---------------------------------------------------------------------------
-- 4. Implementations (data-model §1.4)
-- ---------------------------------------------------------------------------

CREATE TABLE project (
  project_id TEXT PRIMARY KEY
    CHECK (project_id GLOB '[a-z0-9]*' AND project_id NOT GLOB '*[^a-z0-9-]*'
           AND project_id NOT GLOB '*-' AND project_id NOT GLOB '*--*'
           AND length(project_id) <= 64),
  name       TEXT NOT NULL CHECK (trim(name) <> ''),
  url        TEXT CHECK (url IS NULL OR ((url GLOB 'http://?*' OR url GLOB 'https://?*')
                                         AND url NOT GLOB '* *')),
  author     TEXT CHECK (author IS NULL OR trim(author) <> ''),
  notes      TEXT CHECK (notes IS NULL OR trim(notes) <> '')
) STRICT, WITHOUT ROWID;

CREATE TABLE implementation (
  implementation_id         TEXT PRIMARY KEY
    CHECK (implementation_id GLOB '[a-z0-9]*' AND implementation_id NOT GLOB '*[^a-z0-9-]*'
           AND implementation_id NOT GLOB '*-' AND implementation_id NOT GLOB '*--*'
           AND length(implementation_id) <= 64),
  name                      TEXT NOT NULL CHECK (trim(name) <> ''),
  kind_id                   TEXT NOT NULL REFERENCES implementation_kind(kind_id) ON DELETE RESTRICT,
  project_id                TEXT REFERENCES project(project_id)                   ON DELETE RESTRICT,
  repo_url                  TEXT CHECK (repo_url IS NULL OR
                                        ((repo_url GLOB 'http://?*' OR repo_url GLOB 'https://?*')
                                         AND repo_url NOT GLOB '* *')),
  hdl_language_id           TEXT REFERENCES hdl_language(language_id)             ON DELETE RESTRICT,
  license_id                TEXT REFERENCES license(license_id)                   ON DELETE RESTRICT,
  accuracy_id               TEXT REFERENCES accuracy_level(accuracy_id)           ON DELETE RESTRICT,
  verified_against_hardware INTEGER CHECK (verified_against_hardware IS NULL
                                           OR verified_against_hardware IN (0,1)),
  resource_notes            TEXT CHECK (resource_notes IS NULL OR trim(resource_notes) <> ''),
  last_reviewed             TEXT CHECK (last_reviewed IS NULL OR
                                        last_reviewed GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  notes                     TEXT CHECK (notes IS NULL OR trim(notes) <> ''),
  -- data-model §1.4: "1 requires a citation in notes".
  CHECK (verified_against_hardware IS NULL OR verified_against_hardware = 0 OR notes IS NOT NULL),
  -- D10. Original silicon is the part as manufactured, not a codebase: it has no
  -- repository, no HDL language, no SPDX licence and no accuracy to assess (it *is* the
  -- reference). This names the one seeded kind whose attribute set is empty rather than
  -- privileging any kind; every other kind, present or future, is unconstrained here.
  CHECK (kind_id <> 'original_silicon'
         OR (repo_url IS NULL AND hdl_language_id IS NULL
             AND license_id IS NULL AND accuracy_id IS NULL))
) STRICT, WITHOUT ROWID;
-- The kind discriminator: every coverage view and every §6 query filters on it.
CREATE INDEX ix_implementation_kind ON implementation(kind_id);
-- FK child lookup; serves the project page's implementation list and Q3's repo_url COALESCE.
CREATE INDEX ix_implementation_project ON implementation(project_id);
-- FK child lookup; serves the license facet and data-quality IMPL_UNVERIFIED_LICENSE.
CREATE INDEX ix_implementation_license ON implementation(license_id);
-- FK child lookup; serves the HDL-language facet.
CREATE INDEX ix_implementation_hdl_language ON implementation(hdl_language_id);
-- FK child lookup; serves the accuracy facet and data-quality IMPL_UNVERIFIED_ACCURACY.
CREATE INDEX ix_implementation_accuracy ON implementation(accuracy_id);

CREATE TABLE implementation_chip (
  implementation_id TEXT NOT NULL REFERENCES implementation(implementation_id) ON DELETE CASCADE,
  chip_id           TEXT NOT NULL REFERENCES chip(chip_id) ON DELETE RESTRICT,
  PRIMARY KEY (implementation_id, chip_id)
) STRICT, WITHOUT ROWID;
-- Q1 / v_chip_implementation_count / v_chip_satisfied all join from the chip side.
CREATE INDEX ix_implementation_chip_chip ON implementation_chip(chip_id);

CREATE TABLE implementation_system (
  implementation_id TEXT NOT NULL REFERENCES implementation(implementation_id) ON DELETE CASCADE,
  system_id         TEXT NOT NULL REFERENCES system(system_id) ON DELETE RESTRICT,
  PRIMARY KEY (implementation_id, system_id)
) STRICT, WITHOUT ROWID;
-- Q2: v_system_core and v_prospector's NOT EXISTS both probe by system_id.
CREATE INDEX ix_implementation_system_system ON implementation_system(system_id);

CREATE TABLE implementation_path (
  implementation_id TEXT NOT NULL REFERENCES implementation(implementation_id) ON DELETE CASCADE,
  path              TEXT NOT NULL  -- grammar: repo_path
    CHECK (path GLOB '[A-Za-z0-9._+-]*' AND path NOT GLOB '*[^A-Za-z0-9._+/-]*'
           AND path NOT GLOB '*/' AND path NOT GLOB '*//*' AND length(path) <= 256),
  is_top            INTEGER NOT NULL DEFAULT 0 CHECK (is_top IN (0,1)),
  PRIMARY KEY (implementation_id, path)
) STRICT, WITHOUT ROWID;
-- At most one top-level module per implementation (data-model §1.4); replaces v1's array order.
CREATE UNIQUE INDEX ux_implementation_path_top ON implementation_path(implementation_id) WHERE is_top = 1;

CREATE TABLE implementation_platform (
  implementation_id TEXT NOT NULL REFERENCES implementation(implementation_id) ON DELETE CASCADE,
  platform_id       TEXT NOT NULL REFERENCES fpga_platform(platform_id) ON DELETE RESTRICT,
  PRIMARY KEY (implementation_id, platform_id)
) STRICT, WITHOUT ROWID;
-- Q2: v_system_core groups by platform_id and v_prospector filters on it.
CREATE INDEX ix_implementation_platform_platform ON implementation_platform(platform_id);

CREATE TABLE implementation_machine (
  implementation_id TEXT NOT NULL REFERENCES implementation(implementation_id) ON DELETE CASCADE,
  machine_id        TEXT NOT NULL REFERENCES machine(machine_id) ON DELETE RESTRICT,
  PRIMARY KEY (implementation_id, machine_id)
) STRICT, WITHOUT ROWID;
-- The reverse index v1 stored as machine.cores[]: "which implementations run this machine".
CREATE INDEX ix_implementation_machine_machine ON implementation_machine(machine_id);

CREATE TABLE implementation_dependency (
  consumer_id TEXT NOT NULL REFERENCES implementation(implementation_id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL REFERENCES implementation(implementation_id) ON DELETE RESTRICT,
  note        TEXT CHECK (note IS NULL OR trim(note) <> ''),
  PRIMARY KEY (consumer_id, provider_id),
  CHECK (consumer_id <> provider_id)
) STRICT, WITHOUT ROWID;
-- Q3 read backwards ("who consumes jt51?"), which is v1's known_consumers[].
CREATE INDEX ix_implementation_dependency_provider ON implementation_dependency(provider_id);

-- ---------------------------------------------------------------------------
-- 5. Corrections and build metadata (data-model §1.5, §5)
-- ---------------------------------------------------------------------------

CREATE TABLE machine_correction (
  machine_id      TEXT PRIMARY KEY REFERENCES machine(machine_id) ON DELETE CASCADE,
  name            TEXT CHECK (name IS NULL OR trim(name) <> ''),
  year            INTEGER CHECK (year IS NULL OR (year BETWEEN 1950 AND 2100)),
  manufacturer_id TEXT REFERENCES manufacturer(manufacturer_id) ON DELETE RESTRICT,
  reason          TEXT NOT NULL CHECK (trim(reason) <> ''),
  source_url      TEXT CHECK (source_url IS NULL OR
                              ((source_url GLOB 'http://?*' OR source_url GLOB 'https://?*')
                               AND source_url NOT GLOB '* *'))
) STRICT, WITHOUT ROWID;
-- FK child lookup for ON DELETE RESTRICT on manufacturer; manufacturer_id is not the PK.
CREATE INDEX ix_machine_correction_manufacturer ON machine_correction(manufacturer_id);

-- Per-machine system assignment. Not a correction: one MAME driver .cpp routinely hosts
-- several distinct systems (nintendo/vsnes.cpp is VS. UniSystem *and* VS. DualSystem),
-- so the driver rule is a bulk default and this is the per-machine truth. A row here is
-- authoritative; 'reason' is optional because an assignment is not an apology.
-- ON DELETE RESTRICT on system_id: deleting a system must not silently delete the
-- curator's deliberate assignment and resurrect the very system_driver default it
-- overrode. NULL system_id is the one deliberate "this machine belongs to no system".
CREATE TABLE machine_system (
  machine_id TEXT PRIMARY KEY REFERENCES machine(machine_id) ON DELETE CASCADE,
  system_id  TEXT REFERENCES system(system_id) ON DELETE RESTRICT,  -- NULL = deliberately no system
  reason     TEXT CHECK (reason IS NULL OR trim(reason) <> '')
) STRICT, WITHOUT ROWID;
-- FK child lookup for ON DELETE RESTRICT; also "machines assigned to this system".
CREATE INDEX ix_machine_system_system ON machine_system(system_id);

CREATE TABLE machine_chip_correction (
  machine_id TEXT NOT NULL REFERENCES machine(machine_id) ON DELETE CASCADE,
  mame_tag   TEXT NOT NULL  -- grammar: mame_tag
    CHECK (mame_tag = ':device'
           OR (mame_tag GLOB '[a-z0-9_]*' AND mame_tag NOT GLOB '*[^a-z0-9_.:]*'
               AND mame_tag NOT GLOB '*[.:]' AND mame_tag NOT GLOB '*[.:][.:]*')),
  chip_id    TEXT NOT NULL REFERENCES chip(chip_id) ON DELETE RESTRICT,
  op         TEXT NOT NULL CHECK (op IN ('add','remove','set')),
  clock_hz   INTEGER CHECK (clock_hz IS NULL OR clock_hz > 0),
  quantity   INTEGER CHECK (quantity IS NULL OR quantity >= 1),
  reason     TEXT NOT NULL CHECK (trim(reason) <> ''),
  source_url TEXT CHECK (source_url IS NULL OR
                         ((source_url GLOB 'http://?*' OR source_url GLOB 'https://?*')
                          AND source_url NOT GLOB '* *')),
  PRIMARY KEY (machine_id, mame_tag, chip_id),
  -- data-model §5.1 step 1 ignores the value columns on a remove; carrying them is a curator error.
  CHECK (op <> 'remove' OR (clock_hz IS NULL AND quantity IS NULL)),
  -- data-model §5.1 step 3 COALESCEs both columns; a set with neither is a no-op that would rot silently.
  CHECK (op <> 'set' OR clock_hz IS NOT NULL OR quantity IS NOT NULL)
) STRICT, WITHOUT ROWID;
-- D6, on the correction table for the same reason as on machine_chip: a correction that
-- puts a second chip in an already-occupied socket is the very anomaly it must not create.
CREATE UNIQUE INDEX ux_machine_chip_correction_tag
  ON machine_chip_correction(machine_id, mame_tag) WHERE mame_tag <> ':device';
-- FK child lookup for ON DELETE RESTRICT on chip; chip_id is not a PK prefix.
CREATE INDEX ix_machine_chip_correction_chip ON machine_chip_correction(chip_id);

-- Free-form build facts: mame_version, dataset_version, schema_version, build_date,
-- threshold_version. Numeric policy lives in `threshold`, not here.
CREATE TABLE dataset_meta (
  key   TEXT PRIMARY KEY  -- grammar: meta_key
    CHECK (key GLOB '[a-z]*' AND key NOT GLOB '*[^a-z0-9_.]*' AND key NOT GLOB '*.'
           AND key NOT GLOB '*..*' AND length(key) <= 64),
  value TEXT NOT NULL CHECK (trim(value) <> '')
) STRICT, WITHOUT ROWID;

-- D11. Quality thresholds, typed. The quality views read policy from here, and a REAL
-- NOT NULL column is what makes a gate fail loudly instead of quietly: an untyped EAV
-- value that no longer parses CASTs to 0.0 and disables its own comparison, and a
-- missing row makes the comparison NULL, which is never true. Rows are written by the
-- loader from pipeline/config/quality-thresholds.json, which asserts that every name the
-- views read is present. `name` uses the meta_key grammar because it is a dotted config path.
CREATE TABLE threshold (
  name  TEXT PRIMARY KEY  -- grammar: meta_key
    CHECK (name GLOB '[a-z]*' AND name NOT GLOB '*[^a-z0-9_.]*' AND name NOT GLOB '*.'
           AND name NOT GLOB '*..*' AND length(name) <= 64),
  value REAL NOT NULL CHECK (value >= 0)
) STRICT, WITHOUT ROWID;

-- ---------------------------------------------------------------------------
-- 6. Views — data-model.md Appendix B (normative, verbatim)
-- ---------------------------------------------------------------------------

-- Precedence, one sentence: a machine_system row wins; otherwise the system_driver rule
-- for the machine's source file applies; otherwise the machine belongs to no system.
CREATE VIEW v_machine_system AS
SELECT m.machine_id,
       CASE WHEN ms.machine_id IS NOT NULL THEN ms.system_id ELSE sd.system_id END AS system_id
FROM machine m
LEFT JOIN machine_system ms ON ms.machine_id = m.machine_id
LEFT JOIN system_driver sd ON sd.mame_sourcefile = m.mame_sourcefile;

CREATE VIEW v_machine AS
SELECT m.machine_id,
       COALESCE(mc.name, m.name) AS name,
       vms.system_id,
       COALESCE(mc.year, CASE WHEN m.mame_year GLOB '[0-9][0-9][0-9][0-9]'
                              THEN CAST(m.mame_year AS INTEGER) END) AS year,
       COALESCE(mc.manufacturer_id, ma.manufacturer_id) AS manufacturer_id,
       m.mame_sourcefile, m.driver_status, m.clone_count
FROM machine m
LEFT JOIN machine_correction mc  ON mc.machine_id  = m.machine_id
LEFT JOIN v_machine_system vms   ON vms.machine_id = m.machine_id
LEFT JOIN manufacturer_alias ma  ON ma.alias       = m.mame_manufacturer;

CREATE VIEW v_machine_bom AS
SELECT mc.machine_id, mc.chip_id, mc.mame_tag AS role, mc.quantity, mc.clock_hz, 'machine' AS via
FROM machine_chip mc
UNION ALL
SELECT vms.machine_id, sc.chip_id, sc.role_id, sc.quantity, sc.clock_hz, 'system'
FROM v_machine_system vms
JOIN system_chip sc ON sc.system_id = vms.system_id
WHERE NOT EXISTS (SELECT 1 FROM machine_chip m2
                  WHERE m2.machine_id = vms.machine_id AND m2.chip_id = sc.chip_id);

CREATE VIEW v_chip_satisfies AS
SELECT chip_id AS socket_chip_id, chip_id AS provider_chip_id, 'self' AS via FROM chip
UNION ALL
SELECT to_chip_id,   from_chip_id, 'equivalent' FROM chip_equivalence WHERE kind = 'equivalent'
UNION ALL
SELECT from_chip_id, to_chip_id,   'equivalent' FROM chip_equivalence WHERE kind = 'equivalent'
UNION ALL
SELECT to_chip_id,   from_chip_id, 'provides'   FROM chip_equivalence WHERE kind = 'provides';

CREATE VIEW v_chip_implementation_count AS
SELECT ic.chip_id, i.kind_id, COUNT(*) AS implementation_count
FROM implementation_chip ic
JOIN implementation i ON i.implementation_id = ic.implementation_id
GROUP BY ic.chip_id, i.kind_id;

CREATE VIEW v_system_chip_effective AS
SELECT system_id, chip_id, 'curated' AS via FROM system_chip
UNION
SELECT vms.system_id, mc.chip_id, 'mame'
FROM v_machine_system vms
JOIN machine_chip mc ON mc.machine_id = vms.machine_id
WHERE vms.system_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM system_chip sc
                  WHERE sc.system_id = vms.system_id AND sc.chip_id = mc.chip_id);

CREATE VIEW v_system_unmapped AS
SELECT vms.system_id, COUNT(DISTINCT mud.mame_device) AS unmapped_device_count
FROM v_machine_system vms
JOIN machine_unmapped_device mud ON mud.machine_id = vms.machine_id
WHERE vms.system_id IS NOT NULL
GROUP BY vms.system_id;

-- (kind, system, platform) triples that already have a system-level implementation.
-- kind_id is a column, not a filter, so this is reusable; v_prospector supplies the kind.
CREATE VIEW v_system_core AS
SELECT DISTINCT i.kind_id, isy.system_id, ip.platform_id, i.implementation_id
FROM implementation_system isy
JOIN implementation i           ON i.implementation_id  = isy.implementation_id
JOIN implementation_platform ip ON ip.implementation_id = i.implementation_id;

CREATE VIEW v_mame_device_worklist AS
SELECT mud.mame_device,
       COUNT(DISTINCT mud.machine_id) AS machine_count,
       SUM(mud.quantity)              AS instance_count
FROM machine_unmapped_device mud
GROUP BY mud.mame_device;

-- ---------------------------------------------------------------------------
-- 7. Views — coverage.md §3.4 (normative, verbatim)
--    kind_id is a column, never a parameter (coverage.md §3.2).
-- ---------------------------------------------------------------------------

CREATE VIEW v_chip_satisfied AS
SELECT DISTINCT
       i.kind_id,
       s.socket_chip_id                     AS chip_id,
       s.via,
       CASE s.via WHEN 'self'       THEN 1
                  WHEN 'equivalent' THEN 2
                  ELSE                   3 END AS evidence_rank,
       s.provider_chip_id
FROM v_chip_satisfies s
JOIN implementation_chip ic ON ic.chip_id           = s.provider_chip_id
JOIN implementation i       ON i.implementation_id  = ic.implementation_id;

CREATE VIEW v_chip_evidence AS
SELECT b.kind_id,
       b.chip_id,
       b.evidence_rank,
       CASE b.evidence_rank WHEN 1 THEN 'self' WHEN 2 THEN 'equivalent' ELSE 'provides' END AS best_via,
       CASE b.evidence_rank WHEN 1 THEN 'high' WHEN 2 THEN 'medium'     ELSE 'low'      END AS confidence,
       (SELECT MIN(s.provider_chip_id)
          FROM v_chip_satisfied s
         WHERE s.kind_id       = b.kind_id
           AND s.chip_id       = b.chip_id
           AND s.evidence_rank = b.evidence_rank) AS provider_chip_id
FROM (SELECT kind_id, chip_id, MIN(evidence_rank) AS evidence_rank
      FROM v_chip_satisfied
      GROUP BY kind_id, chip_id) b;

CREATE VIEW v_system_chip_coverage AS
SELECT ik.kind_id,
       e.system_id,
       e.chip_id,
       COALESCE(ev.best_via, 'unsatisfied') AS satisfied_via,
       COALESCE(ev.evidence_rank, 4)        AS evidence_rank,
       ev.provider_chip_id,
       ev.confidence                        AS chip_confidence
FROM implementation_kind ik
CROSS JOIN (SELECT DISTINCT system_id, chip_id FROM v_system_chip_effective) e
LEFT JOIN v_chip_evidence ev ON ev.kind_id = ik.kind_id AND ev.chip_id = e.chip_id;

CREATE VIEW v_system_coverage_by_kind AS
SELECT ik.kind_id,
       s.system_id,
       COUNT(cc.chip_id)                                           AS chips_total,
       COUNT(CASE WHEN cc.evidence_rank = 1 THEN 1 END)            AS chips_direct,
       COUNT(CASE WHEN cc.evidence_rank = 2 THEN 1 END)            AS chips_equivalent,
       COUNT(CASE WHEN cc.evidence_rank = 3 THEN 1 END)            AS chips_provided,
       COUNT(CASE WHEN cc.evidence_rank < 4 THEN 1 END)            AS chips_satisfied,
       CASE WHEN COUNT(cc.chip_id) = 0 THEN 0.0
            ELSE 1.0 * COUNT(CASE WHEN cc.evidence_rank < 4 THEN 1 END) / COUNT(cc.chip_id)
       END                                                         AS satisfied_share,
       COALESCE(u.unmapped_device_count, 0)                        AS unmapped_device_count,
       CASE
         WHEN COUNT(cc.chip_id) = 0                                          THEN 'low'
         WHEN 2 * COALESCE(u.unmapped_device_count, 0) >= COUNT(cc.chip_id)  THEN 'low'
         WHEN COALESCE(u.unmapped_device_count, 0) >= 1                      THEN 'medium'
         WHEN COUNT(CASE WHEN cc.evidence_rank IN (2,3) THEN 1 END) >= 1     THEN 'medium'
         ELSE                                                                     'high'
       END                                                         AS confidence
FROM implementation_kind ik
CROSS JOIN system s
LEFT JOIN v_system_chip_coverage cc ON cc.kind_id = ik.kind_id AND cc.system_id = s.system_id
LEFT JOIN v_system_unmapped u       ON u.system_id = s.system_id
GROUP BY ik.kind_id, s.system_id, u.unmapped_device_count;

-- ---------------------------------------------------------------------------
-- 7b. Views — data-model.md Appendix B, continued.
--     Q2 and Q4 read the generic coverage views of §7, so they are created after them.
--     Both were previously built on a private, fpga-only copy of the coverage
--     arithmetic; the copy is deleted and these are its only consumers.
-- ---------------------------------------------------------------------------

-- Q2. The one view in this schema that is *about* FPGA cores, so it is the one place a
-- kind filter belongs. Every number comes from v_system_coverage_by_kind, so the
-- project's headline metric has exactly one SQL definition, and 'confidence',
-- 'chips_equivalent' and 'chips_provided' come along for free.
CREATE VIEW v_prospector AS
SELECT p.platform_id, c.system_id, c.chips_total, c.chips_direct, c.chips_equivalent,
       c.chips_provided, c.chips_satisfied, c.satisfied_share, c.unmapped_device_count,
       c.confidence
FROM fpga_platform p
CROSS JOIN v_system_coverage_by_kind c
WHERE c.kind_id = 'fpga_hdl'
  AND NOT EXISTS (SELECT 1 FROM v_system_core f
                  WHERE f.kind_id    = c.kind_id
                    AND f.system_id  = c.system_id
                    AND f.platform_id = p.platform_id);

-- Q4. One row per (kind, chip) that no implementation of that kind can satisfy, directly
-- or through an edge. The caller filters the kind; the view names none.
CREATE VIEW v_chip_gap AS
SELECT ik.kind_id, c.chip_id, c.display_name, c.function_id, cf.prospector_band,
       (SELECT COUNT(DISTINCT sc.system_id)  FROM system_chip  sc WHERE sc.chip_id = c.chip_id) AS system_count,
       (SELECT COUNT(DISTINCT mc.machine_id) FROM machine_chip mc WHERE mc.chip_id = c.chip_id) AS machine_count
FROM implementation_kind ik
CROSS JOIN chip c
JOIN chip_function cf ON cf.function_id = c.function_id
WHERE NOT EXISTS (SELECT 1 FROM v_chip_evidence e
                  WHERE e.kind_id = ik.kind_id AND e.chip_id = c.chip_id);

-- ---------------------------------------------------------------------------
-- 8. Views — data-quality.md Appendix Q (normative, verbatim)
--    Views take no parameters (data-quality §7), so policy is read from the typed
--    `threshold` table. No CAST: the column is already REAL NOT NULL, and the loader
--    guarantees every name read below exists.
-- ---------------------------------------------------------------------------

CREATE VIEW v_quality_instance AS
SELECT m.mapped_instances,
       u.unmapped_instances,
       m.mapped_instances + u.unmapped_instances AS total_instances,
       CASE WHEN m.mapped_instances + u.unmapped_instances = 0 THEN 1.0
            ELSE 1.0 * m.mapped_instances / (m.mapped_instances + u.unmapped_instances)
       END AS mapped_instance_share
FROM (SELECT COALESCE(SUM(quantity), 0) AS mapped_instances   FROM machine_chip) m
CROSS JOIN
     (SELECT COALESCE(SUM(quantity), 0) AS unmapped_instances FROM machine_unmapped_device) u;

CREATE VIEW v_quality_device AS
SELECT (SELECT COUNT(*) FROM mame_device WHERE chip_id       IS NOT NULL) AS devices_mapped,
       (SELECT COUNT(*) FROM mame_device WHERE ignore_reason IS NOT NULL) AS devices_ignored,
       (SELECT COUNT(DISTINCT mame_device) FROM machine_unmapped_device)  AS devices_unmapped;

CREATE VIEW v_machine_instance AS
SELECT m.machine_id,
       COALESCE((SELECT SUM(quantity) FROM machine_chip c
                 WHERE c.machine_id = m.machine_id), 0) AS mapped_instances,
       COALESCE((SELECT SUM(quantity) FROM machine_unmapped_device d
                 WHERE d.machine_id = m.machine_id), 0) AS unmapped_instances
FROM machine m;

CREATE VIEW v_system_instance AS
SELECT vms.system_id,
       SUM(mi.mapped_instances)   AS mapped_instances,
       SUM(mi.unmapped_instances) AS unmapped_instances,
       CASE WHEN SUM(mi.mapped_instances) + SUM(mi.unmapped_instances) = 0 THEN 0.0
            ELSE 1.0 * SUM(mi.unmapped_instances)
                 / (SUM(mi.mapped_instances) + SUM(mi.unmapped_instances)) END AS unmapped_share
FROM v_machine_system vms
JOIN v_machine_instance mi ON mi.machine_id = vms.machine_id
WHERE vms.system_id IS NOT NULL
GROUP BY vms.system_id;

CREATE VIEW v_quality_completeness AS
SELECT 'chip' AS entity, 'manufacturer_id' AS column_name,
       COUNT(*) AS rows_total, COUNT(manufacturer_id) AS rows_present FROM chip
UNION ALL SELECT 'chip', 'description',      COUNT(*), COUNT(description)      FROM chip
UNION ALL SELECT 'chip', 'family_id',        COUNT(*), COUNT(family_id)        FROM chip
UNION ALL SELECT 'chip', 'model',            COUNT(*), COUNT(model)            FROM chip
UNION ALL SELECT 'chip', 'package',          COUNT(*), COUNT(package)          FROM chip
UNION ALL SELECT 'chip', 'typical_clock_hz', COUNT(*), COUNT(typical_clock_hz) FROM chip
UNION ALL SELECT 'chip', 'year_introduced',  COUNT(*), COUNT(year_introduced)  FROM chip
UNION ALL SELECT 'chip', 'datasheet',        COUNT(*),
       (SELECT COUNT(DISTINCT chip_id) FROM chip_datasheet) FROM chip
UNION ALL SELECT 'implementation', 'license_id',    COUNT(*), COUNT(license_id)    FROM implementation
UNION ALL SELECT 'implementation', 'accuracy_id',   COUNT(*), COUNT(accuracy_id)   FROM implementation
UNION ALL SELECT 'implementation', 'hdl_language_id', COUNT(*), COUNT(hdl_language_id) FROM implementation
UNION ALL SELECT 'implementation', 'project_id',   COUNT(*), COUNT(project_id)    FROM implementation
UNION ALL SELECT 'implementation', 'repo_url',     COUNT(*), COUNT(repo_url)      FROM implementation
UNION ALL SELECT 'implementation', 'last_reviewed', COUNT(*), COUNT(last_reviewed) FROM implementation
UNION ALL SELECT 'implementation', 'verified_against_hardware', COUNT(*),
       COUNT(verified_against_hardware) FROM implementation
UNION ALL SELECT 'system', 'manufacturer_id', COUNT(*), COUNT(manufacturer_id) FROM system
UNION ALL SELECT 'system', 'year_introduced', COUNT(*), COUNT(year_introduced) FROM system
UNION ALL SELECT 'system', 'description',     COUNT(*), COUNT(description)     FROM system
UNION ALL SELECT 'mame_device', 'note',       COUNT(*), COUNT(note)            FROM mame_device;

CREATE VIEW v_quality_warning AS
SELECT 'MAPPED_INSTANCE_SHARE_LOW' AS code, NULL AS subject,
       ROUND(mapped_instance_share, 4) AS impact,
       'dataset mapped-instance share is below the warn threshold' AS detail
FROM v_quality_instance
WHERE mapped_instance_share <
      (SELECT value FROM threshold WHERE name = 'mapped_instance_share.warn_below')

UNION ALL
SELECT 'UNMAPPED_DEVICE_HIGH_IMPACT', w.mame_device, w.instance_count,
       'unmapped MAME device is above both issue-generator thresholds'
FROM v_mame_device_worklist w
WHERE w.instance_count >=
      (SELECT value FROM threshold WHERE name = 'issue_generator.min_instance_count')
  AND w.machine_count >=
      (SELECT value FROM threshold WHERE name = 'issue_generator.min_machine_count')

UNION ALL
SELECT 'CHIP_MISSING_METADATA', c.chip_id,
       (c.manufacturer_id IS NULL) + (c.description IS NULL),
       'chip is missing manufacturer and/or description'
FROM chip c
WHERE c.manufacturer_id IS NULL OR c.description IS NULL

-- The kind filter is the D10 CHECK read as a warning: original silicon is structurally
-- forbidden a licence and an accuracy, so warning about their absence would emit a
-- finding no curator could ever clear.
UNION ALL
SELECT 'IMPL_UNVERIFIED_LICENSE', i.implementation_id, NULL,
       'implementation has no verified license'
FROM implementation i WHERE i.license_id IS NULL AND i.kind_id <> 'original_silicon'

UNION ALL
SELECT 'IMPL_UNVERIFIED_ACCURACY', i.implementation_id, NULL,
       'implementation has no assessed accuracy level'
FROM implementation i WHERE i.accuracy_id IS NULL AND i.kind_id <> 'original_silicon'

UNION ALL
SELECT 'IMPL_STALE_REVIEW', i.implementation_id,
       CAST(julianday((SELECT value FROM dataset_meta WHERE key = 'build_date'))
            - julianday(i.last_reviewed) AS INTEGER),
       'implementation last_reviewed is older than the staleness threshold'
FROM implementation i
WHERE i.last_reviewed IS NOT NULL
  AND julianday((SELECT value FROM dataset_meta WHERE key = 'build_date'))
      - julianday(i.last_reviewed)
      > (SELECT value FROM threshold WHERE name = 'stale_review_days')

UNION ALL
SELECT 'IMPL_UNTARGETED', i.implementation_id, NULL,
       'implementation targets neither a chip nor a system'
FROM implementation i
WHERE NOT EXISTS (SELECT 1 FROM implementation_chip   x WHERE x.implementation_id = i.implementation_id)
  AND NOT EXISTS (SELECT 1 FROM implementation_system y WHERE y.implementation_id = i.implementation_id)

UNION ALL
SELECT 'IMPL_MACHINES_WITHOUT_SYSTEM', i.implementation_id,
       (SELECT COUNT(*) FROM implementation_machine m WHERE m.implementation_id = i.implementation_id),
       'chip-level implementation claims machines but no system'
FROM implementation i
WHERE EXISTS     (SELECT 1 FROM implementation_machine m WHERE m.implementation_id = i.implementation_id)
  AND NOT EXISTS (SELECT 1 FROM implementation_system  y WHERE y.implementation_id = i.implementation_id)

UNION ALL
SELECT 'SYSTEM_NO_CHIPS', s.system_id, NULL,
       'system has no curated and no observed chips'
FROM system s
WHERE NOT EXISTS (SELECT 1 FROM v_system_chip_effective e WHERE e.system_id = s.system_id)

UNION ALL
SELECT 'SYSTEM_UNMAPPED_SHARE_HIGH', si.system_id, ROUND(si.unmapped_share, 4),
       'system unmapped device-instance share is above the warn threshold'
FROM v_system_instance si
WHERE si.unmapped_share >
      (SELECT value FROM threshold WHERE name = 'system_unmapped_share.warn_above')

UNION ALL
SELECT 'MACHINE_ZERO_MAPPED_CHIPS', m.machine_id,
       (SELECT COALESCE(SUM(quantity), 0) FROM machine_unmapped_device d
        WHERE d.machine_id = m.machine_id),
       'machine has no mapped chips in its effective BOM'
FROM machine m
WHERE NOT EXISTS (SELECT 1 FROM v_machine_bom b WHERE b.machine_id = m.machine_id)

UNION ALL
SELECT 'EQUIVALENCE_MUTUAL_PROVIDES', e.from_chip_id || ' -> ' || e.to_chip_id, NULL,
       'mutual provides edge should be a single equivalent edge'
FROM chip_equivalence e
WHERE e.kind = 'provides'
  AND e.from_chip_id < e.to_chip_id
  AND EXISTS (SELECT 1 FROM chip_equivalence r
              WHERE r.kind = 'provides'
                AND r.from_chip_id = e.to_chip_id
                AND r.to_chip_id   = e.from_chip_id)

-- chip.display_name and system.name sit outside ux_chip_name_name / ux_system_name_name,
-- so one entity's display name may equal another's alias and the resolver would answer
-- with the wrong row. Cross-table, so no UNIQUE index can reach it (data-quality §3.3 has
-- the same shape); one query is the whole check.
UNION ALL
SELECT 'CHIP_NAME_COLLISION', c.chip_id, NULL,
       'chip display_name is another chip''s alias or retired id'
FROM chip c
WHERE EXISTS (SELECT 1 FROM chip_name n WHERE n.name = c.display_name AND n.chip_id <> c.chip_id)

UNION ALL
SELECT 'SYSTEM_NAME_COLLISION', s.system_id, NULL,
       'system name is another system''s alias or retired id'
FROM system s
WHERE EXISTS (SELECT 1 FROM system_name n WHERE n.name = s.name AND n.system_id <> s.system_id)

-- Second-sourced parts genuinely break family -> manufacturer (a Sharp Z80 is a chip of
-- the Zilog Z80 family), so this is a warning that names the disagreement, never a
-- constraint that forbids it (data-model §2.3).
UNION ALL
SELECT 'CHIP_MANUFACTURER_FAMILY_MISMATCH', c.chip_id, NULL,
       'chip manufacturer differs from its family''s manufacturer'
FROM chip c
JOIN chip_family f ON f.family_id = c.family_id
WHERE c.manufacturer_id IS NOT NULL
  AND f.manufacturer_id IS NOT NULL
  AND c.manufacturer_id <> f.manufacturer_id;
