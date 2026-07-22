# data/cores

One JSON file per FPGA core record (e.g., `mister-arcade-outrun.json`), seeded from the MiSTer GitHub org and extended to other platforms. Records the core name, platform, repository, open-source flag, and the machines/families it emulates. See [PLAN.md §3.4](../../PLAN.md#34-cores-curated--scraped) for the full schema.

**Edit policy:** CURATED. Hand-edited via PR. Seeded by automation (MAME machine name matching); corrections and new platforms added by hand. Every machine_id must resolve to an actual extracted machine; platform must be in the defined enum.
