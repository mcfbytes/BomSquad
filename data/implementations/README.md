# data/implementations

One JSON file per open-source HDL implementation (filename = slug). Records the repository, language, license, accuracy level, target platforms (MiSTer, Pocket, etc.), and known consumers (which cores use it). Verified licenses are critical — read from the repo, never guessed. See [PLAN.md §3.2](../../PLAN.md#32-implementations-curated) for the full schema.

**Edit policy:** CURATED. Hand-edited via PR. Every chip_id must exist in `data/chips/`. Licenses verified from source repositories. `known_consumers` is derived at build time; do not hand-maintain it in the curated files.
