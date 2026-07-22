# schemas

JSON Schema 2020-12 definitions that define the canonical data model for every entity in the project: chips, implementations, machines, cores, mappings, overlays, and build outputs. These schemas are the single source of truth for validation — all curated data under `data/` and generated outputs under `dist/` must conform exactly. Each schema includes required/optional fields, slug regexes, enums, and `additionalProperties: false` to catch additions early.

**Edit policy:** CURATED. Schemas are hand-edited via PR. Changes to schema structure require discussion and a new phase; new fields must update the corresponding entities across all three code paths (normalizer, emitter, and test fixtures).
