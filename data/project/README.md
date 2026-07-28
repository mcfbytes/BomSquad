# data/project

One JSON file per curation-facing project or organization, filename `<project_id>.json`, carrying the single
`project` row (data-model.md §4.2). A `project` groups one or more `implementation` rows under a common
repository owner or umbrella (e.g. a MiSTer-devel core author, an emulator project) — it is metadata about
who maintains the work, not a table any other table's identity depends on.

**Edit policy:** CURATED. Hand-edited via PR. `name` is required; `url`, `author` and `notes` are nullable —
omit rather than guess (Standing rule 3). `implementation.project_id`, when set, MUST resolve to a file here.
