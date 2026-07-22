# BOM Squad Equivalence Model

**Spec version 1.0.0 · Normative · T1.4**

This document specifies the semantics of chip equivalence: the two relations stored in `data/mappings/equivalences.json`, exactly how coverage math (T6.2) consumes them, and the confidence model. It operates strictly inside the envelopes fixed by [docs/data-model.md](data-model.md) — the file shape of §5.9 and the machine `coverage` envelope of §5.4.3 — and MUST NOT be read as altering any field name, type, or structure defined there. Where this document and `data-model.md` disagree on structure, `data-model.md` wins; where they disagree on equivalence or coverage _semantics_, this document wins.

The key words MUST, MUST NOT, REQUIRED, SHOULD, SHOULD NOT, MAY, and OPTIONAL are per RFC 2119.

Consumers of this spec: T1.2 (schema for `equivalences.json`), T3.5 (curated edge data), T6.2 (coverage engine — the worked examples in §11 are its unit tests, verbatim), T6.3 (Prospector, via coverage output), T6.5 (chip-detail chunks surface edges).

---

## 1. The two relations

Coverage answers one question per BOM row: _does HDL exist that a core developer could use for this socket?_ ("Socket" = the requirement expressed by a BOM row's `chip_id`.) Two curated relations extend the plain has-an-implementation test, and the distinction between them is load-bearing:

1. **Symmetric equivalence classes** (`classes`). A set of distinct chips that are interchangeable _for coverage purposes in both directions_. Canonical example: YM3438 ≈ YM2612 — the YM3438 is a CMOS die shrink of the same OPN2 design; an implementation of either satisfies a socket for the other. A class is a strong claim: full mutual substitutability at the same confidence as a direct implementation (§8).

2. **Directional `provides` edges** (`provides`). `A provides B` asserts: an implementation of A can serve a socket for B. The reverse is NOT implied. Canonical example: `m68010 provides m68000` — the 68010 executes the 68000 ISA upward-compatibly; a 68000 core cannot serve a 68010 socket (missing VBR, MOVEC, RTD, loop mode). A `provides` edge is a weaker claim than class membership and costs confidence (§8).

**Canonical non-example** — the relation that MUST NOT be modelled: NES **RP2A03 vs M6502**. The 2A03 is not a plain 6502: it lacks decimal (BCD) mode and embeds the NES APU.

- `m6502 provides rp2a03` is false: a 6502 core supplies no APU.
- `rp2a03 provides m6502` is rejected too, though the CPU half arguably qualifies. Decision and rationale in §6.3.

Neither relation ever rewrites a BOM. A socket satisfied via a class-mate or a `provides` edge keeps its own `chip_id` in the machine record; equivalence affects only `coverage` (`implemented`, `missing`, `confidence`, `percent`). The site can explain _how_ a socket is satisfiable from the edges themselves, which ship in chip-detail chunks (T6.5).

## 2. File shape

Fixed by data-model.md §5.9; reproduced here with the semantics this spec attaches. File: `data/mappings/equivalences.json`.

```json
{
  "classes": [
    {
      "chips": ["ym2612", "ym3438"],
      "note": "YM3438 is a CMOS die shrink of the YM2612 (OPN2); register- and timing-compatible, minor analog output-level differences; interchangeable for coverage. Source: Yamaha datasheets, MAME src/devices/sound/ymopn.cpp."
    }
  ],
  "provides": [
    {
      "note": "68010 executes the full 68000 ISA upward-compatibly. Caveat: MOVE from SR is privileged on the 68010, but arcade/console 68000 software runs in supervisor mode, where behavior is identical. Source: Motorola M68000 Family Programmer's Reference.",
      "provider": "m68010",
      "provides": "m68000"
    }
  ]
}
```

- `classes[]` — entry: `chips` (REQUIRED, ≥ 2 curated chip ids, sorted, unique) + `note` (REQUIRED, §9). Classes MUST be pairwise disjoint. Array sorted by `chips[0]`.
- `provides[]` — entry: `provider` (REQUIRED), `provides` (REQUIRED), `note` (REQUIRED, §9). `provider` ≠ `provides`; no duplicate (`provider`, `provides`) pairs; array sorted by (`provider`, `provides`).
- Every chip ref MUST be a **curated** chip id. `unknown:` refs are forbidden on either side (schema-level: the bare-slug grammar admits no colon). Rationale: `unknown:` stubs are ephemeral (data-model §6.3) and an interchangeability claim about an _unidentified_ part is unfalsifiable — there is nothing to justify the note against. When the device is mapped, edges become possible.
- Chip refs resolve through `aliases.json` (single hop, data-model §3.3) before validation; alias use emits `STALE_REFERENCE`.
- Class membership and edges are curated _claims_, not identities: unlike ids they carry no permanence guarantee and MUST be corrected or removed when falsified.

## 3. Choosing the right mechanism: the decision ladder

Equivalence is the _last_ tool, not the first. Curators MUST walk this ladder top-down and stop at the first rung that fits:

| #   | Situation                                                                  | Mechanism                                                                                                                      | Example                                                                                                    |
| --- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| 1   | Same part, different MAME device names / branding of the _identical_ die   | **Device map, many-to-one** — both keys map to one chip id (`data/mappings/mame-device-map.json`)                              | `sega_315_5216` and `sega_315_5211a` variants that MAME names separately but curators identify as one part |
| 2   | Same part, second-sourced or relabeled, no behavioral delta worth tracking | **One chip record**, extra entry in `names[]`                                                                                  | Sharp LH0080 listed as a name on `z80` (if curators decide not to track it separately)                     |
| 3   | Distinct parts, interchangeable in both directions for coverage            | **Class**                                                                                                                      | `ym2612` ≈ `ym3438`                                                                                        |
| 4   | Distinct parts, substitution valid in exactly one direction                | **`provides` edge**                                                                                                            | `m68010` → `m68000`                                                                                        |
| 5   | Substitution valid only under a machine-dependent condition                | **No edge.** Document in the chips' `notes`; see §6                                                                            | `rp2a03` vs `m6502`                                                                                        |
| 6   | One _specific implementation_ genuinely covers several chips               | **`implementation.chip_ids[]` multi-claim** — a per-implementation fact, recorded on the implementation, not a chip-level edge | a configurable 6502/65C02 core claims both ids                                                             |

Rungs 1–2 mean classes stay rare: pure relabels collapse at mapping time. Rung 6 is the pressure valve that keeps chip-level edges sound — "this particular HDL handles both" is recorded where it is true, without asserting anything about the chips in general.

## 4. Formal semantics

### 4.1 Inputs

At coverage time (after alias resolution, device mapping, overlays):

- `Chips_cur` — the set of curated chip ids in the build.
- `I ⊆ Chips_cur` — the **implemented set**: every id appearing in any `implementation.chip_ids[]`. Existence of one implementation record suffices; `accuracy` (including `partial`) does not affect membership. (PLAN non-goal: no quality scoring in coverage. The Prospector MAY weight accuracy separately — T6.3.) `unknown:` ids can never be in `I` (data-model §5.2).
- `classes` — disjoint sets `K₁ … Kₘ`, each `Kᵢ ⊆ Chips_cur`, `|Kᵢ| ≥ 2`.
- `provides` — pairs `(p, q)` with `p, q ∈ Chips_cur`, `p ≠ q`.

### 4.2 Class lifting

```
class(x) = the unique K in classes with x ∈ K, else {x}     // total over Chips_cur
IC = { class(x) : x ∈ I }                                   // implemented classes
PE = { (class(p), class(q)) : (p, q) ∈ provides }           // lifted provides edges
```

Every `provides` edge is interpreted **class-wise**: an edge touching one class member touches the whole class, on both endpoints. Rationale: a class asserts full interchangeability; if `A provides B` and `B ≈ B'`, refusing `A provides B'` would contradict the class. Lifting is exactly one class-hop per endpoint — it is the meaning of the class abstraction, not transitivity. Consequence: each fact is stated once; an edge duplicating an existing edge _after lifting_ is a validation failure (§10), so the file never encodes the same class-pair twice.

### 4.3 satisfied(c)

For a chip ref `c` occurring in a machine BOM:

```
satisfied(c):
  if c is unknown:*                          → false   (reason: unmapped-device)
  else if class(c) ∈ IC                      → true    (tier: direct if c ∈ I, else class)
  else if ∃ P ∈ IC : (P, class(c)) ∈ PE     → true    (tier: provided)
  else                                       → false   (reason: no-implementation)
```

**Satisfaction tiers** (internal to the pipeline; they drive confidence in §8 and MAY be exposed to T6.3 in-process, but MUST NOT appear in the dist envelope):

| Tier          | Meaning                                        |
| ------------- | ---------------------------------------------- |
| `direct`      | the exact chip has an implementation (`c ∈ I`) |
| `class`       | a class-mate has an implementation             |
| `provided`    | satisfied only via a lifted `provides` edge    |
| `unsatisfied` | none of the above                              |

Properties (T6.2 MUST preserve; good invariants to assert in tests):

- **Total and terminating.** Defined for every chip ref; no recursion, no fixpoint — at most one `provides` hop, ever (§5).
- **Pure.** Coverage is a function of (`chips[]`, `I`, `classes`, `provides`) only. The §11 fixtures therefore name no machines.
- **Monotone.** Adding an implementation, adding an edge, or merging classes never turns a satisfied chip unsatisfied. Curation can only improve coverage.
- **`unknown:` is never satisfied.** `I` and all edges range over curated ids only.
- **Ignored devices never appear.** Device-map `ignore` entries are dropped before BOM assembly (data-model §6.5) and are invisible to coverage.

## 5. Transitivity

### 5.1 Classes: transitively closed by construction

There is no pairwise "equivalent-to" edge form. A class _is_ its own transitive closure: interchangeability is asserted over the whole member set at once, and the disjointness rule forces curators to merge overlapping classes rather than chain them. No closure computation exists anywhere in the pipeline.

### 5.2 `provides`: single-hop, NO transitive closure

`satisfied()` traverses **at most one** `provides` edge. If `A provides B` and `B provides C`, the pipeline does NOT conclude `A provides C`.

Rationale:

1. **Soundness over completeness.** Every edge is a human-verified claim carrying a mandatory justification (§9). A computed A→C edge would be a claim nobody made, with no note and no reviewer. Coverage feeds the Prospector; a false "satisfied" hides exactly the work the project exists to surface. A false "unsatisfied" merely costs one explicit edge.
2. **Caveats do not compose.** Real edges carry domain caveats in their notes ("supervisor-mode software unaffected", "SSG section only"). `A→B` under caveat X and `B→C` under caveat Y compose into a claim that holds under neither X nor Y alone — and v1 has no machine-readable conditions (§6) for a checker to reason about. Example: a defensible `huc6280 → m65c02` (superset CPU core) chained onto a _loose_ `m65c02 → m6502` would manufacture `huc6280 → m6502` — false for any 6502 software using undocumented NMOS opcodes, a common arcade/console reality.
3. **The graph is tiny.** Dozens of curated edges. Writing the closure explicitly is cheap and puts a note on every hop that actually gets used.

**Curator duty (closure by hand):** when adding an edge creates a chain (`A→B` exists, curator adds `B→C`), the curator MUST consider the direct edge `A→C` and either add it with its own note or record in the new edge's note why it does not hold. T3.5 review enforces this.

### 5.3 Cycle policy

The **lifted** graph `(classes ∪ singletons, PE)` MUST be a DAG. Any cycle is a build failure (`EQUIVALENCE_CONFLICT`, §10):

- A 2-cycle (`A provides B` and `B provides A`, directly or after lifting) asserts mutual substitutability — that is a class, and MUST be expressed as one. The error message MUST say so.
- Longer cycles cannot arise from genuine capability supersets (strict partial order) and always indicate a modelling error.

Although evaluation (§4.3) never chains edges — so a cycle could not loop the engine — the DAG rule is enforced anyway: it keeps the data honest and keeps the door open for any future closure semantics without a data migration.

## 6. Conditional equivalence

### 6.1 Decision: v1 has NO conditional edges

The envelope (§2) has no condition field, and this spec deliberately does not want one yet. A machine-readable condition ("satisfies unless decimal mode is used") is only useful if the pipeline can _evaluate_ it, which requires per-machine software-behavior facts (does this game use BCD? does it read the APU?) that no data source in v1 provides. An unevaluatable condition is a note wearing a costume.

### 6.2 The curator playbook (what to do instead)

A substitution that holds "except when …" lands on exactly one of three rungs:

| Case  | The condition is…                                           | Action                                                                                                                                                                                                                                              |
| ----- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A** | negligible for essentially every consumer in this domain    | Assert the edge (or class); state the caveat and why it is negligible **verbatim in the mandatory `note`**. The note ships to the site. Example: `m68010 → m68000` — MOVE from SR privilege difference is invisible to supervisor-mode arcade code. |
| **B** | machine-dependent, and realistically triggered              | **Do NOT assert the edge.** Record the relationship in both chips' `notes` fields so the research is not lost. The socket stays honestly unsatisfied. Example: `rp2a03` vs `m6502` (§6.3).                                                          |
| **C** | a property of one specific implementation, not of the chips | Use `implementation.chip_ids[]` multi-claim on that implementation (ladder rung 6). Example: a 2A03 core built around a full 6502 core with BCD intact and independently usable MAY claim `m6502` too — after its author verifies it.               |

Rule of thumb: an edge note may _excuse_ a caveat (case A) but MUST NOT _scope_ the claim ("only if…", "except for machines that…"). If the truthful note needs an "only if" about the consuming machine, the edge is case B and MUST NOT exist.

A future spec version MAY introduce a condition field (additive, minor bump per data-model §10) once a data source exists that could evaluate conditions; the confidence machinery (§8) already has the natural slot (conditional ⇒ ≤ `medium`, like `provided`).

### 6.3 The 2A03 doctrine (normative for T3.5)

Both possible edges between `rp2a03` and `m6502` are rejected:

- **`m6502 provides rp2a03`: false outright.** The 2A03 socket needs the embedded APU; a 6502 core supplies none of it. Not conditional — wrong.
- **`rp2a03 provides m6502`: rejected as case B.** The 2A03's CPU half is a 6502 with decimal mode absent. A 6502 socket is satisfied only if the machine's software never uses BCD — a per-machine software fact the equivalence layer cannot see, and BCD use is real in 6502 arcade/computer code (scorekeeping is the classic case). Asserting the edge would poison the Prospector with false positives on exactly the boards being ranked; withholding it costs almost nothing, because plain-6502 implementations are plentiful — the edge would add no coverage the direct route does not already provide.
- The relationship MUST still be documented in the `notes` of both chip records, and a specific 2A03 implementation that truly contains a complete, BCD-capable, independently usable 6502 MAY multi-claim `m6502` in its own `chip_ids` (case C).

Contrast with `m68010 → m68000` (case A): both edges have caveats, but the 68010's caveat is negligible domain-wide while the 2A03's is machine-dependent and commonly triggered. That line — _who_ the caveat depends on — is the whole test.

## 7. Coverage computation

### 7.1 Basis: distinct chip refs

Coverage counts **distinct chip refs**, not BOM rows and not instances:

```
CH = { chip_id of every row in machine.chips }        // a set; includes unknown:*
```

- Two rows sharing a `chip_id` under different roles (`maincpu` z80 + `audiocpu` z80) contribute one element: implementing the chip once unlocks every socket that uses it, which is the question coverage answers.
- The `count` field (collapsed identical instances) is irrelevant here; instance-weighted accounting is the quality report's job (`mapped_instance_share`, T1.7).
- Device-map `ignore` entries never reach the BOM, so they are structurally excluded.
- This basis is forced by the envelope: `coverage.missing[]` entries carry `chip_id` only (no role), so the unit of coverage is the distinct chip ref.

### 7.2 The numbers

```
mapped_total = |CH|
implemented  = |{ c ∈ CH : satisfied(c) }|
missing      = [ { "chip_id": c, "reason": reason(c) } : c ∈ CH, not satisfied(c) ]
                 sorted by chip_id asc
percent      = mapped_total = 0 ? 0
             : Math.round((100 * implemented / mapped_total) * 10) / 10
```

- `mapped_total` includes `unknown:` refs (they passed _through_ mapping and are visibly unresolved — matches data-model §5.4.3's example, where the unknown row is inside the 11). Empty BOM: `mapped_total = 0`, `implemented = 0`, `percent = 0`, `missing = []`, confidence `low` (§8); the machine also trips the `ZERO_MAPPED_CHIPS` quality warning (T1.7).
- Rounding and serialization per data-model §8.4: `Math.round` (half toward +∞); integral results serialize without a decimal point (`100`, not `100.0`; `50`, not `50.0`); non-integral keep one decimal (`33.3`, `81.8`).
- Invariants (assert in T6.2 tests): `implemented + missing.length = mapped_total`; `missing[].chip_id` are exactly the unsatisfied members of `CH`, unique, sorted.

### 7.3 `missing[].reason` assignment

The envelope fixes the enum `no-implementation | unknown-chip | unmapped-device`. Assignment is total:

| Reason              | Rule                                                                                                                                                                                                                                                                                                                                                      | The fix is…                                                 |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `unmapped-device`   | `chip_id` matches `^unknown:`                                                                                                                                                                                                                                                                                                                             | curation: add a device-map entry                            |
| `no-implementation` | any other unsatisfied chip (curated, but no implementation, no class-mate implementation, no incoming lifted edge from an implemented class)                                                                                                                                                                                                              | engineering: write or find HDL (or curate a justified edge) |
| `unknown-chip`      | **RESERVED — never emitted in v1.** Every BOM ref is either a curated chip (whose `function` is a real taxonomy value — data-model §5.1) or an `unknown:` stub; v1 has no "identified but unclassifiable" middle state. The value is retained for a future version that admits curated placeholder chips. T6.2 MUST NOT emit it; emitting it is a defect. | —                                                           |

Note the 2A03 case lands on `no-implementation`, not `unknown-chip`: it is a perfectly well-known chip that happens to lack HDL (§6.3).

### 7.4 Family coverage

Per-family coverage (PLAN §3.6, T6.2) uses the same envelope and the same formulas over the union basis:

```
CH_F = ⋃ { CH(m) : machine m ∈ family F }
```

`satisfied()`, `mapped_total`, `implemented`, `missing`, `percent`, and confidence (§8, with `n`, `u`, `p` computed over `CH_F`) are otherwise identical. Union is well-defined: `unknown:` keys dedupe across members (same key = same unidentified device type), and no machine belongs to two families (`FAMILY_CONFLICT`). The family record's `coverage` object is emitted by T6.5 in family chunks with exactly this envelope.

## 8. Confidence

### 8.1 What confidence means

`coverage.confidence` rates **how much the reported numbers can be trusted**, not how good they are. A machine can be 50% covered at `high` confidence (we know exactly what is missing) and 100% covered at `medium` (the 100% leans on substitution claims). The two axes — percent and confidence — are deliberately independent.

### 8.2 Exact computation

Over the machine's basis `CH` (or `CH_F` for a family), let:

```
n = |CH|
u = |{ c ∈ CH : c matches ^unknown: }|
p = |{ c ∈ CH : tier(c) = provided }|
```

```
confidence(n, u, p) =
  "low"     if n = 0, or (u ≥ 1 and 3·u ≥ n)
  "medium"  else if u ≥ 1 or p ≥ 1
  "high"    otherwise                            // u = 0 and p = 0
```

Integer arithmetic only (`3·u ≥ n` — no floats, no rounding hazard). Truth table:

| Condition         | Confidence | Why                                                                                |
| ----------------- | ---------- | ---------------------------------------------------------------------------------- |
| `n = 0`           | `low`      | an empty BOM says nothing about the board                                          |
| `u = 0`, `p = 0`  | `high`     | every chip identified; every satisfied chip direct or class-satisfied              |
| `u = 0`, `p ≥ 1`  | `medium`   | the numbers lean on at least one directional substitution claim                    |
| `u ≥ 1`, `3u < n` | `medium`   | unidentified silicon present, but a minority                                       |
| `u ≥ 1`, `3u ≥ n` | `low`      | a third or more of the BOM is unidentified — the percent is decoration, not signal |

### 8.3 Rationale for each rule

- **`class`-tier satisfaction does NOT degrade.** A class asserts full interchangeability at coverage granularity — that is its defining claim (§1). If a curator is not confident enough for that, the relationship is not a class; they must use a `provides` edge (which does degrade) or none. This gives curators a crisp calibration rule: _classes are confidence-preserving; when in doubt, provide, don't equate._
- **Any `provided`-tier satisfaction caps at `medium`.** A directional edge is a curated, sound claim, but satisfying a socket through it still implies adaptation work and rests on a substitution argument rather than the part itself. One such chip is enough to make the machine's headline number claim-dependent; binary (any `p ≥ 1`) is therefore right, and no amount of `provided` satisfaction alone reaches `low` — the cost of a sound edge is bounded, unlike ignorance.
- **Any `unknown:` chip caps at `medium`** — mandated by data-model §5.4.3 and independently justified: an unidentified device is unbounded risk (it may be the hard 20%).
- **Unknown-dominated BOMs are `low`.** At `u/n ≥ 1/3` the unresolved share exceeds what the resolved share can vouch for; the threshold is a normative constant of this spec (changing it is a minor spec bump), NOT a T1.7 config value — coverage semantics must be identical for every build of a given spec version.
- **Misses do not degrade.** An unsatisfied curated chip (`no-implementation`) affects `percent`, not `confidence`: we are _sure_ it is missing. (See E3.)
- `u ≥ 1` and `p ≥ 1` together still give `medium` (both cap at the same level); only the `3u ≥ n` share rule reaches `low`.

Worked check against data-model §5.4.3's illustration (`implemented: 9, mapped_total: 11`, one `unknown:` row, `confidence: "high"`): the values there illustrate envelope mechanics only; under this spec that machine computes `confidence: "medium"` (`u = 1 ≥ 1`, `3 < 11`). T6.2 MUST follow this spec.

## 9. Provenance: the `note` contract

`note` is REQUIRED on every class and every edge (schema-enforced, non-empty). Its content contract:

1. **State the technical relationship**: what kind of claim this is — die shrink, second source, register-compatible superset, ISA superset, integrated superset block.
2. **For `provides`: state the direction rationale** — what the provider adds, and (when not obvious) why the reverse fails.
3. **State known caveats and why they are negligible** (§6.2 case A). An excusing caveat belongs in the note verbatim; a scoping caveat ("only if…") means the edge must not exist.
4. **Cite a source** for any claim not self-evident from the two chips' own curated records: datasheet, manufacturer programmer's reference, MAME source path, service manual. Recommended form: a terminal `Source: <ref>[, <ref>]`.

The note must be specific enough that a reviewer could _falsify_ it. "Compatible" alone fails review. Notes ship to the site (chip-detail chunks) and are the user-visible explanation of every satisfaction path, so they are written for readers, not for the pipeline. The linter (T1.6) SHOULD warn on notes shorter than 40 characters.

`source_urls` exists on overlays only, not on equivalence entries — the envelope has exactly `note`, so citations live inside it (see the examples in §2).

## 10. Validation

Checks run in the "validate curated inputs" stage of the pipeline order (data-model §9), before coverage. All string comparisons bytewise.

| #   | Rule                                                                                                                                                   | Enforced by   | Failure code                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- | --------------------------------------------------------------------- |
| 1   | File shape: required fields, types, `note` non-empty, `chips` minItems 2, `uniqueItems`, chip-id regex (bare slug — structurally excludes `unknown:`)  | schema (T1.2) | `SCHEMA_VIOLATION`                                                    |
| 2   | Canonical order: `classes` sorted by `chips[0]`, each `chips` sorted asc; `provides` sorted by (`provider`, `provides`); key order per data-model §8.2 | linter (T1.6) | serialization-contract violation (data-model §8)                      |
| 3   | Every chip ref resolves, after single-hop alias resolution, to a live curated chip                                                                     | pipeline      | `DANGLING_REFERENCE` (alias use additionally warns `STALE_REFERENCE`) |
| 4   | Classes pairwise disjoint                                                                                                                              | pipeline      | `EQUIVALENCE_CONFLICT`                                                |
| 5   | No self-edge: `provider` ≠ `provides`                                                                                                                  | pipeline      | `EQUIVALENCE_CONFLICT`                                                |
| 6   | No duplicate (`provider`, `provides`) pair                                                                                                             | pipeline      | `EQUIVALENCE_CONFLICT`                                                |
| 7   | No self-loop after lifting: `provider` and `provides` in one class                                                                                     | pipeline      | `EQUIVALENCE_CONFLICT`                                                |
| 8   | No duplicate lifted pair: two edges collapsing to the same (class, class) pair (each fact stated once — §4.2)                                          | pipeline      | `EQUIVALENCE_CONFLICT`                                                |
| 9   | Lifted graph is a DAG (§5.3); a 2-cycle's error message MUST suggest merging into a class                                                              | pipeline      | `EQUIVALENCE_CONFLICT`                                                |

**`EQUIVALENCE_CONFLICT`** is minted by this spec as a failure gate (exit non-zero, nothing published) and registers into the data-model §9 failure table — an additive extension per data-model §10, parallel in spirit to `FAMILY_CONFLICT`. Error messages MUST name the entries involved (chip ids / class members) and, when multiple violations exist, report all of them in a deterministic order (sorted by the involved chip ids).

Decisions the task list required, recorded: self-edges forbidden (rule 5, and rule 7 closes the lifted loophole); duplicates forbidden raw and lifted (rules 6, 8); endpoints MUST be curated chips — referencing unmapped (`unknown:`) chips is NOT allowed (§2 rationale); `provides` cycle policy: hard-fail DAG (rule 9, §5.3).

<!-- CONTINUED2 -->
