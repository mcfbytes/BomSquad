# BOM Squad Coverage Model

**Spec version 2.0.0 · Normative · T1.4r**

This document specifies chip equivalence and coverage. Both are SQL. Equivalence is four columns in
`chip_equivalence`; coverage is four `CREATE VIEW` statements over it. There is no coverage engine, no
`satisfied()` function, no closure computation and no scoring model — those were v1's answer and they are
deleted.

It replaces `docs/equivalences.md` (spec 1.0.0), whose domain reasoning is reused throughout and whose
mechanisms are not.

**Precedence.** [data-model.md](data-model.md) is authoritative for structure — tables, columns, keys,
`ON DELETE` behaviour, and every view in its Appendix B. This document is authoritative for equivalence and
coverage _semantics_, and it adds four views that Appendix B does not contain (§3.4). Where the two disagree
on structure, data-model.md wins.

The key words MUST, MUST NOT, REQUIRED, SHOULD, SHOULD NOT, MAY and OPTIONAL are per RFC 2119.

**Consumers.** T1.2 (row-shape validation for `data/chip_equivalence.json`), T3.5 (the curated edges),
T6.2 (which is now "run these four `CREATE VIEW` statements"), T6.3 (the Prospector, §7), T6.4/T6.5 (the site).
The worked examples in §6 are T6.2's unit tests verbatim.

**Inbound links.** `data-model.md` cites the deleted file in five places. The replacements are:

| data-model.md                       | cites                       | now read                |
| ----------------------------------- | --------------------------- | ----------------------- |
| §0 preamble (line 12)               | equivalences.md §1–§6       | coverage.md §1–§2       |
| §1.2 `chip_equivalence` table (244) | equivalences.md §9          | coverage.md §5.6        |
| §1.2 prose (249)                    | equivalences.md §5.2        | coverage.md §2.1        |
| §1.4 `implementation_chip` (401)    | equivalences.md §3 rung 6   | coverage.md §1.7 rung 6 |
| §2.5 supersession bullet (757)      | equivalences.md, throughout | coverage.md §8          |

---

## 1. The two relations

### 1.1 The question coverage answers

Per BOM row: **does an implementation of the requested kind exist that a developer could use for this socket?**
A "socket" is one `system_chip.chip_id` — the requirement, not the part fitted. Two curated relations widen the
plain has-an-implementation test, and both are rows in one table:

```
chip_equivalence(from_chip_id, to_chip_id, kind, note)
kind ∈ ('equivalent', 'provides')
```

Neither relation ever rewrites a BOM. A socket satisfied through an edge keeps its own `chip_id` in
`system_chip`; the edge shows up in `v_system_chip_coverage.satisfied_via` and `provider_chip_id`, so the site
can always explain _how_ a socket is covered and by what.

### 1.2 `equivalent` — symmetric interchange

`a equivalent b` asserts that an implementation of either part satisfies a socket for the other. It is the
strong claim: interchangeable at coverage granularity, both ways.

Canonical row:

| from_chip_id | to_chip_id | kind         |
| ------------ | ---------- | ------------ |
| `ym2612`     | `ym3438`   | `equivalent` |

The YM3438 is the CMOS die shrink of the YM2612 (OPN2). Identical register map and channel structure; the
differences are analog (the YM2612's ladder-effect DAC) and change nothing about what HDL is required. An OPN2
core covers both sockets.

### 1.3 `provides` — directional substitution

`p provides q` asserts that an implementation of `p` satisfies a socket for `q`. **The reverse is not implied
and MUST NOT be inferred.** It is the weaker claim: the socket is served by a _different, more capable_ part,
which implies adaptation work and rests on a substitution argument rather than on the part itself.

Canonical row:

| from_chip_id | to_chip_id | kind       | reading                                            |
| ------------ | ---------- | ---------- | -------------------------------------------------- |
| `m68010`     | `m68000`   | `provides` | an MC68010 implementation serves an MC68000 socket |

The 68010 executes the full 68000 user ISA upward-compatibly. The caveat — `MOVE from SR` is privileged on the
68010 — is stated in the mandatory note and is invisible to arcade 68000 code, which runs supervisor-mode. The
reverse is false: a 68000 implementation has no VBR, MOVEC, RTD or loop mode.

### 1.4 Decision: symmetry is stored **once**, mirrored in a view

> **Decision.** A symmetric pair is **one row**, canonically ordered `from_chip_id < to_chip_id`, enforced by
> `CHECK (kind <> 'equivalent' OR from_chip_id < to_chip_id)`. The mirror row is never stored. Both directions
> are produced by `v_chip_satisfies`, which is the only place in the system that knows the relation is
> symmetric.

The alternative — store both `(a,b)` and `(b,a)` so every read is a plain lookup — was rejected:

| Criterion             | One row + view                                                                                                            | Two rows                                                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Enforceable?**      | Yes, entirely. `CHECK` fixes the canonical form; the PK forbids the duplicate. The database cannot hold a malformed pair. | **No.** "For every row there exists a mirror row" is not expressible as a SQLite constraint. A missing mirror is silent, asymmetric coverage — the worst possible failure mode. |
| **Duplication**       | The `note` — a fact about the _pair_ — is stored once.                                                                    | The note is stored twice and can be edited independently. Same non-key fact in two places: an update anomaly, and the exact defect this rebuild exists to remove.               |
| **Cost to the SQL**   | Two `UNION ALL` branches in **one** view, written once. No downstream query ever sees the asymmetry.                      | Zero — but paid for with a synchronisation invariant in the loader and a build check to police it.                                                                              |
| **Curated diff / PR** | One row per real-world fact. A reviewer sees one line.                                                                    | Two lines that must agree; half the review effort is confirming they do.                                                                                                        |

"Keeps the SQL dumb" is the deciding test, and it is met: the complexity is two lines in one view, not an
invariant that has to be maintained by code. `v_chip_satisfies` is normative in
[data-model.md](data-model.md) Appendix B and is reproduced here because §1 through §4 are unreadable without
it:

```sql
-- reproduced from data-model.md Appendix B; that file is the source of truth for this text
CREATE VIEW v_chip_satisfies AS
SELECT chip_id AS socket_chip_id, chip_id AS provider_chip_id, 'self' AS via FROM chip
UNION ALL
SELECT to_chip_id,   from_chip_id, 'equivalent' FROM chip_equivalence WHERE kind = 'equivalent'
UNION ALL
SELECT from_chip_id, to_chip_id,   'equivalent' FROM chip_equivalence WHERE kind = 'equivalent'
UNION ALL
SELECT to_chip_id,   from_chip_id, 'provides'   FROM chip_equivalence WHERE kind = 'provides';
```

Read it as: _socket `socket_chip_id` is served by an implementation of `provider_chip_id`, by route `via`._
The `'self'` branch is what makes it total — every chip serves its own socket — and is why nothing downstream
needs a `COALESCE` between "direct" and "via an edge".

### 1.5 The two columns mean different things per `kind`

This is the one place in the schema where a column's meaning depends on a discriminator, and it is deliberate:

| `kind`       | `from_chip_id` | `to_chip_id` | Directional?                                           |
| ------------ | -------------- | ------------ | ------------------------------------------------------ |
| `provides`   | the provider   | the socket   | yes                                                    |
| `equivalent` | sorts first    | sorts second | no — the order carries no meaning, only canonical form |

The alternative was two tables, `chip_equivalent` and `chip_provides`, which would remove the ambiguity.
Rejected, and the reason is not brevity:

- A single PK `(from_chip_id, to_chip_id)` plus the pair-uniqueness index of §5.2 makes "this pair has at most
  one edge, of one kind" a **database constraint**. Across two tables it would be a hand-written cross-table
  check — precisely the kind of code this rebuild deletes.
- Every consumer wants the union. `v_chip_satisfies` would become a four-way `UNION ALL` over two tables
  instead of over one, and every validation rule in §5 would be written twice.
- The curated file `data/chip_equivalence.json` stays one file with one row shape.

Cost, acknowledged: a reader of a raw row must check `kind` before reading direction. §1.2/§1.3 and this table
are the mitigation.

### 1.6 Decision: `rp2a03` and `m6502` carry no edge, in **either** direction

The Ricoh RP2A03 is not a plain 6502. It omits decimal (BCD) mode and embeds the NES APU.

**`m6502 provides rp2a03` — false outright.** A 6502 socket's implementation supplies no APU. This is not a
caveat, it is a missing subsystem. Not conditional; wrong.

**`rp2a03 provides m6502` — rejected, and this is the judgement call.** The 2A03's CPU half is a 6502 with
decimal mode removed. A 6502 socket is therefore satisfied _only if the machine's software never uses BCD_ —
a fact about the software in the ROM, which no table in this schema holds and no data source in scope provides.
BCD use in 6502 arcade and computer code is real and common (score keeping is the classic case). Three reasons
to withhold the edge:

1. **The caveat is scoping, not excusing.** The test is _who does the caveat depend on?_ If it depends on the
   parts (`m68010 provides m68000`: the privilege difference is a property of the two CPUs and is invisible to
   the supervisor-mode code this domain runs) — assert it and state the caveat in the note. If it depends on
   the consuming machine's software — do not assert it. That line is the whole doctrine.
2. **A false "satisfied" hides exactly the work this project exists to surface.** Coverage feeds the
   Prospector. A false positive poisons the ranking; a false negative costs one explicit edge that a curator
   can add later with a note.
3. **The edge would buy nothing.** Plain-6502 HDL is plentiful, so a real `m6502` socket is already covered
   `self`. The edge would only ever fire where the direct route already fires.

**The pressure valve is one row.** In the relational model `implementation_chip` is an ordinary N:M junction,
so a specific 2A03 core that genuinely contains a complete, BCD-capable, independently usable 6502 claims
`m6502` by inserting one more `implementation_chip` row. That is a fact about _that implementation_, verified
by its author, and it does not assert anything about the chips in general. Because the valve is this cheap,
there is even less reason than in v1 to weaken the chip-level edge.

The relationship MUST still be written into both chips' `chip.notes`, so the research is not lost.

Example E5 (§6.5) exhibits the converse rejection in the view output: a system holding both an `rp2a03` socket
and an `m6502` socket, where 2A03 HDL exists — the 2A03 socket is `self`, the 6502 socket next to it is
`unsatisfied`.

### 1.7 The decision ladder

Equivalence is the last tool, not the first. Curators MUST walk this top-down and stop at the first rung that
fits. Rungs 1–2 are why edges stay rare; rung 6 is why chip-level edges stay sound.

| #   | Situation                                                                    | Mechanism                                                                                |
| --- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 1   | Same die, several MAME device names                                          | Several `mame_device` rows pointing at one `chip_id`                                     |
| 2   | Same part, second-sourced or relabelled, no behavioural delta worth tracking | One `chip` row plus a `chip_name` row with `kind='alias'`                                |
| 3   | Distinct parts, interchangeable both ways for coverage                       | `chip_equivalence` with `kind='equivalent'`                                              |
| 4   | Distinct parts, substitution valid in exactly one direction                  | `chip_equivalence` with `kind='provides'`                                                |
| 5   | Substitution valid only under a machine-dependent condition                  | **No edge.** Document it in both chips' `notes` (§1.6)                                   |
| 6   | One _specific implementation_ genuinely covers several parts                 | Extra `implementation_chip` rows — a fact about that implementation, not about the chips |

There is no condition field and this spec does not want one. A machine-readable condition is useful only if
something can evaluate it, which needs per-machine software-behaviour facts that no source in scope provides.
An unevaluatable condition is a note wearing a costume. Adding one later is additive, and §4.2's confidence
ladder already has the slot for it (conditional ⇒ no better than `provides`).

---

## 2. Transitivity

### 2.1 Decision: **neither relation chains.** One hop. Plain joins.

> **Decision.** `v_chip_satisfies` traverses exactly one edge. If `a provides b` and `b provides c`, the
> database does **not** conclude `a provides c`. If `a equivalent b` and `b equivalent c`, it does **not**
> conclude `a equivalent c`. There is no `WITH RECURSIVE` anywhere in the coverage path, no closure table and
> no cycle guard in evaluation.

Four reasons, in order of weight:

1. **Soundness over completeness.** Every edge is a human-verified claim carrying a mandatory justification
   (§5.6). A computed `a→c` edge is a claim nobody made, with no note and no reviewer, and the site would have
   nothing to display when a user asks _how_ a socket is covered. A false "satisfied" hides the work the
   project exists to surface; a false "unsatisfied" costs one explicit row.
2. **Caveats do not compose.** Real edges carry domain caveats. `a→b` under caveat X composed with `b→c` under
   caveat Y yields a claim that holds under neither X nor Y alone. Concretely: a defensible
   `huc6280 provides m65c02` (superset CPU core) chained onto a _loose_ `m65c02 provides m6502` manufactures
   `huc6280 provides m6502` — false for any 6502 software using undocumented NMOS opcodes, which is ordinary
   in this domain.
3. **The SQL stays dumb.** Non-transitive is a four-branch `UNION ALL` and an equi-join. Transitive is a
   recursive CTE, a visited-set guard, and a hard question about whether `equivalent` and `provides` may
   alternate within one chain. SQLite would run either; only one of them is reviewable.
4. **The graph is tiny.** Dozens of edges. Writing the closure by hand is cheap and puts a real note on every
   hop that actually gets used.

### 2.2 What the transitive reading would have produced

The `provides` ladder in the §6 fixture is `m68030 → m68020 → m68010 → m68000`, with FPGA HDL for `m68020`
only. The closure that the rejected design would compute:

```sql
-- REJECTED DESIGN, shown for contrast. Do not implement.
WITH RECURSIVE reach(socket_chip_id, provider_chip_id) AS (
  SELECT to_chip_id, from_chip_id FROM chip_equivalence WHERE kind = 'provides'
  UNION
  SELECT r.socket_chip_id, e.from_chip_id
  FROM reach r JOIN chip_equivalence e ON e.to_chip_id = r.provider_chip_id AND e.kind = 'provides'
)
SELECT socket_chip_id, provider_chip_id FROM reach ORDER BY 1, 2;
```

```
socket_chip_id | provider_chip_id
m68000         | m68010            <- stated
m68000         | m68020            <- inferred
m68000         | m68030            <- inferred
m68010         | m68020            <- stated
m68010         | m68030            <- inferred
m68020         | m68030            <- stated
```

Three stated edges become six. Under this reading, example E4 (§6.4) reports its `m68000` socket **satisfied**
by the 68020 core — a claim no curator made, unnoted, and not obviously true (a 68020 core is a 32-bit-bus
part with different exception stack frames; whether it drops into a 68000 socket is exactly the kind of thing
a human must sign off on). The single-hop reading reports it `unsatisfied`, which is the honest answer, and
the fix is one row with one note.

### 2.3 `equivalent` sets of three or more

v1 modelled symmetry as _classes_ — sets, transitively closed by construction. There are no classes here, so a
three-member set is three rows:

```
(a, b, 'equivalent')
(a, c, 'equivalent')
(b, c, 'equivalent')
```

k members cost k(k−1)/2 rows. Real sets are k = 2 almost always and k = 3 occasionally; three rows against a
recursive CTE plus a disjointness rule plus class lifting is not a close call. Each row carries its own note,
which is a gain: "the YM3438 is the die shrink of the YM2612" and "the YM3438 is the die shrink of the YM2612
and the YM2612 is what the third part second-sources" are different claims with different citations.

Missing closure inside a symmetric set is almost always an oversight rather than a considered claim, so §5.4
check **V8** warns on it and names the missing pair. It is a warning, not a failure: a curator who genuinely
means `a≈b`, `b≈c`, `a≉c` may say so in the notes and ignore it.

### 2.4 Curator duty

When adding an edge creates a chain (`a→b` exists; the curator adds `b→c`), the curator MUST consider `a→c`
and either add it with its own note or record in the new edge's note why it does not hold. T3.5 review
enforces this. This is the entire cost of non-transitivity and it is paid by the person best placed to pay it.

---

## 3. The coverage views

### 3.1 What coverage counts

The basis for a system is the set of **distinct `chip_id` values** in
`v_system_chip_effective` — the curated `system_chip` rows, plus chips observed on the system's machines for
chips the curated BOM lacks.

- **Distinct chips, not rows and not instances.** Two rows sharing a `chip_id` under different roles (a `z80`
  at `maincpu` and a `z80` at `audiocpu`) contribute **one** element: implementing the Z80 once unlocks both
  sockets, which is the question coverage answers. `system_chip.quantity` is irrelevant here.
- **Unmapped MAME devices are not in the basis.** They are `machine_unmapped_device` rows, counted separately
  by `v_system_unmapped` and surfaced as `unmapped_device_count`. They are silicon we have not identified, so
  they cannot be scored — they degrade _confidence_ (§4.3), not the fraction. This is the structural
  replacement for v1's `unknown:` chip refs, which polluted the basis.
- **Ignored devices never appear.** A `mame_device` row with `ignore_reason` set (screens, speakers) produces
  neither a `machine_chip` row nor a `machine_unmapped_device` row.

### 3.2 Decision: `kind_id` is a **column**, not a parameter

> **Decision.** Coverage is computed for **every** `implementation_kind` and exposes `kind_id` as the first
> column. Callers filter: `WHERE kind_id = 'fpga_hdl'`. No view is parameterised, no view hardcodes a kind.

SQLite views take no arguments. The three ways out are: one view per kind (a schema change every time
`implementation_kind` gains a row — which violates data-model.md §0.2's rule that a lookup table exists
precisely so that adding a member is a pure data change); a table-valued function (a C extension; unavailable
in the browser build); or the kind as a column. The third is the dumb, correct answer, and it is also the
useful one — "how much of this board has reached FPGA versus how much MAME already emulates" is a real
question, and it is one `GROUP BY kind_id` away.

The `implementation_kind` `CROSS JOIN` also makes the view _total_: a kind with no implementations at all
still yields a row per system, with `chips_satisfied = 0`. See E8 (§6.8), where `original_silicon` returns
0.0% rather than no row.

### 3.3 Decision: FPGA platform is **not** a coverage dimension

> **Decision.** Coverage is never filtered by `fpga_platform`. Platform is a property of _system-level
> implementations_ and belongs where `v_system_core` and `v_prospector` already use it.

`implementation_platform` records where an implementation is _known to run_. Chip-level HDL is portable RTL —
`jt51` is Verilog that synthesises anywhere, and it has no platform rows and should not have any. Filtering
chip coverage by `platform_id` would therefore report ~0% for every system on every platform: not a
conservative answer, a wrong one, because absence of a platform row means "portable / not recorded", never
"does not run there".

The genuine platform question — "will this fit on a DE10-Nano?" — is a resource question answered by
`implementation.resource_notes`, not by set membership. The Prospector slices by platform where the fact is
real: _does a core for this system already exist on this platform_ (§7).

### 3.4 The views (normative)

These four views are additions to [data-model.md](data-model.md) Appendix B — a **minor** spec bump under its
change-control rule ("adding a view … is a minor bump"). They add no table and no column. They are runnable as
written and are verified in §6.

```sql
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
```

Four views, one job each:

1. `v_chip_satisfied` — every (kind, socket, route) triple that exists. `DISTINCT` collapses the case of two
   implementations claiming the same chip: coverage is existence, not a count.
2. `v_chip_evidence` — the **best** route per (kind, chip), by `MIN(evidence_rank)`. This is where a chip that
   is both directly implemented and reachable through an edge is correctly reported as direct.
3. `v_system_chip_coverage` — the per-socket answer, one row per (kind, system, chip). `LEFT JOIN` is what
   turns "no evidence" into `satisfied_via = 'unsatisfied'`, so the view is total over the basis.
4. `v_system_coverage_by_kind` — a plain `GROUP BY` of view 3, so the totals **cannot** disagree with the
   detail; and the confidence column of §4.3.

### 3.5 Column reference

`v_chip_evidence` / `v_system_chip_coverage`:

| Column                       | Domain                                          | Meaning                                                                                                                                                                                              |
| ---------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `evidence_rank`              | 1, 2, 3, 4                                      | 1 self · 2 equivalent · 3 provides · 4 unsatisfied (detail view only)                                                                                                                                |
| `best_via` / `satisfied_via` | `self`, `equivalent`, `provides`, `unsatisfied` | the strongest route found                                                                                                                                                                            |
| `provider_chip_id`           | chip id or NULL                                 | which chip's implementation covers the socket; equals `chip_id` when `self`; NULL exactly when unsatisfied. Ties at the same rank resolve to `MIN(provider_chip_id)`, so the value is deterministic. |
| `chip_confidence`            | `high`, `medium`, `low`, NULL                   | §4.2. NULL **exactly** when `satisfied_via = 'unsatisfied'`                                                                                                                                          |

`v_system_coverage_by_kind`:

| Column                  | Type    | Meaning                                                                  |
| ----------------------- | ------- | ------------------------------------------------------------------------ |
| `chips_total`           | INTEGER | distinct chips in the basis (§3.1); 0 for a system with no BOM           |
| `chips_direct`          | INTEGER | rank 1 — the chip's own implementation                                   |
| `chips_equivalent`      | INTEGER | rank 2 — covered only through an `equivalent` edge                       |
| `chips_provided`        | INTEGER | rank 3 — covered only through a `provides` edge                          |
| `chips_satisfied`       | INTEGER | `= chips_direct + chips_equivalent + chips_provided`                     |
| `satisfied_share`       | REAL    | `chips_satisfied / chips_total`, or exactly `0.0` when `chips_total = 0` |
| `unmapped_device_count` | INTEGER | distinct unmapped MAME devices across the system's machines              |
| `confidence`            | TEXT    | `high` · `medium` · `low` (§4.3)                                         |

Invariants (assert these in T6.2):

```
chips_direct + chips_equivalent + chips_provided = chips_satisfied ≤ chips_total
chips_total = 0  ⟹  satisfied_share = 0.0 AND confidence = 'low'
(satisfied_via = 'unsatisfied')  ⟺  (evidence_rank = 4)  ⟺  (chip_confidence IS NULL)
```

**Presentation and assertions.** `satisfied_share` is an IEEE-754 double computed at query time; it is
deterministic but not exact for thirds. Tests MUST assert on the integer counts and on
`ROUND(100.0 * satisfied_share, 1)`, never on the raw REAL. The site formats with the same `ROUND`.

### 3.6 Relationship to data-model.md Appendix B

`v_system_coverage_by_kind` **is** Appendix B's coverage view. It used to be a strict generalisation of a
second one: `v_system_coverage`, together with `v_chip_fpga_direct` and `v_chip_fpga_satisfied`, computed the
same numbers with `kind_id = 'fpga_hdl'` hardcoded, and the equality

```sql
SELECT * FROM v_system_coverage_by_kind WHERE kind_id = 'fpga_hdl'
```

was verified over the fixture and over an 800-system synthetic dataset with 300 edges — zero mismatches in
both. That agreement was the finding, not the reassurance: **the project's headline metric had two
independent SQL definitions that had to be edited in lockstep**, and the specialised one could not compute
`chips_equivalent`, `chips_provided` or `confidence`, so `v_prospector` — built on it — could not report
them either.

All three specialised views are therefore **deleted**. Appendix B now reads this document's views:
`v_prospector` is built on `v_system_coverage_by_kind` and gains the three missing columns for free, and
`v_chip_gap` is built on `v_chip_evidence` and gains a `kind_id` column. Check V10 is retired with them —
there is nothing left to reconcile, which is a better outcome than a gate that proved two copies agreed.

The one place a kind literal survives is inside `v_prospector`, which is by definition about FPGA cores.
`v_system_fpga_core` is generalised to `v_system_core`, carrying `kind_id` as a column exactly as §3.2
requires of every reusable view.

### 3.7 Cost

Measured on Node 24 / SQLite 3.51.3 with a synthetic dataset of 2 000 chips, 800 systems, 9 600 `system_chip`
rows, 900 implementations and 300 edges:

| Query                                                | Time   |
| ---------------------------------------------------- | ------ |
| `v_system_coverage_by_kind` — all kinds, all systems | 31 ms  |
| … `WHERE kind_id = 'fpga_hdl'` (800 rows)            | 23 ms  |
| … one system                                         | 15 ms  |
| `v_system_coverage` (the deleted baseline, 800 rows) | 160 ms |
| `v_system_chip_coverage` — all 28 800 rows           | 12 ms  |
| `v_chip_evidence` — all rows                         | 1.4 ms |

Two honest notes. First, SQLite materialises `v_system_chip_coverage` before applying a `WHERE`, so asking for
one system costs nearly as much as asking for all of them; at 15 ms that is irrelevant, and the SPA holds the
whole database in memory anyway. Second, the generic view is _faster_ than the specialised one it replaced,
because `v_chip_evidence` is computed once instead of re-joined per system — so deleting the specialisation
costs nothing at all. No index is required or proposed.

---

## 4. Confidence

### 4.1 What confidence means

Confidence rates **how much the reported fraction can be trusted**, not how good the fraction is. A system can
be 50% covered at `high` confidence — we know exactly what is missing — and 100% covered at `low` — the board
still has unidentified silicon on it. The two axes are deliberately independent, and the site MUST show them
together.

Two things damage trust, and only two:

- **Substitution.** A socket covered through an edge rests on a curated claim rather than on HDL named for
  that part.
- **Ignorance.** Unmapped MAME devices mean the denominator is wrong: there is silicon we have not identified,
  so the fraction is computed over an incomplete basis.

A **miss does not damage trust.** An unsatisfied chip lowers the fraction and leaves confidence alone: we are
_certain_ it is missing. E3 and E4 (§6.3, §6.4) are the worked cases.

### 4.2 Per-chip confidence

`v_chip_evidence.confidence` / `v_system_chip_coverage.chip_confidence`, a three-value text column derived
directly from `evidence_rank`:

| rank | `best_via`    | confidence | Meaning                                                               |
| ---- | ------------- | ---------- | --------------------------------------------------------------------- |
| 1    | `self`        | `high`     | an implementation names this part. Observed fact.                     |
| 2    | `equivalent`  | `medium`   | covered through a symmetric curated claim.                            |
| 3    | `provides`    | `low`      | covered through a directional curated claim; implies adaptation work. |
| 4    | `unsatisfied` | NULL       | no claim is being made, so there is nothing to rate.                  |

NULL rather than a fourth value: confidence qualifies a satisfaction claim, and an unsatisfied socket makes
none. This keeps the domain at three values and gives the checkable invariant of §3.5.

`equivalent` sits above `provides` because it is the stronger assertion (interchangeable both ways, typically
the same design) and because the curator chose it over `provides` deliberately — §1.7 rungs 3 and 4 are a
calibration decision, and the ranking is what makes that decision visible.

### 4.3 Per-system confidence

`v_system_coverage_by_kind.confidence`, evaluated top-down exactly as written in §3.4:

| #   | Condition                                 | Confidence | Why                                                                                        |
| --- | ----------------------------------------- | ---------- | ------------------------------------------------------------------------------------------ |
| 1   | `chips_total = 0`                         | `low`      | an empty BOM says nothing about the board                                                  |
| 2   | `2 × unmapped_device_count ≥ chips_total` | `low`      | a third or more of the observed silicon is unidentified (§4.4); the fraction is decoration |
| 3   | `unmapped_device_count ≥ 1`               | `medium`   | unidentified silicon is present but a minority                                             |
| 4   | `chips_equivalent + chips_provided ≥ 1`   | `medium`   | the fraction leans on at least one substitution claim                                      |
| 5   | otherwise                                 | `high`     | every counted chip is identified, and every covered one is covered directly                |

Design notes:

- **Binary, not proportional, for substitution.** One edge-covered chip is enough to make the headline number
  claim-dependent, and no amount of edge coverage alone reaches `low`: the cost of a sound edge is bounded,
  unlike the cost of ignorance. This is why rule 4 sits below rules 2–3 and cannot produce `low`.
- **Per-system confidence does not distinguish `equivalent` from `provides`.** That distinction is available
  losslessly per chip (§4.2) and via `chips_equivalent` / `chips_provided`, which are separate columns
  precisely so a caller can weight them. Collapsing them at the system level keeps the column to three values.
- **Integer arithmetic only.** `2 × u ≥ n` — no floats, no rounding hazard, no threshold constant hidden in a
  config file. Coverage semantics must be identical for every build of a given spec version.

### 4.4 The unmapped-device threshold

v1 used `3u ≥ n` where `u` (unknown chip refs) was counted _inside_ `n`. Here unmapped devices are a separate
table and are **not** in `chips_total`, so the same threshold — _at least a third of the observed silicon is
unidentified_ — is a different inequality:

```
u / (n + u) ≥ 1/3   ⟺   3u ≥ n + u   ⟺   2u ≥ n
```

The threshold did not change; the base did. Verified sweep:

| `chips_total` | `unmapped` | `u/(n+u)` | confidence |
| ------------- | ---------- | --------- | ---------- |
| 0             | 0          | —         | `low`      |
| 1             | 0          | 0.000     | `high`     |
| 1             | 1          | 0.500     | `low`      |
| 2             | 1          | 0.333     | `low`      |
| 3             | 1          | 0.250     | `medium`   |
| 4             | 1          | 0.200     | `medium`   |
| 4             | 2          | 0.333     | `low`      |
| 5             | 2          | 0.286     | `medium`   |
| 6             | 3          | 0.333     | `low`      |

One third is a normative constant of this spec. Changing it is a minor spec bump, not a config value.

### 4.5 What changed from v1

| v1                                                                      | Now                                                                                                                                                                           |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Class-tier satisfaction did **not** degrade confidence                  | `equivalent` degrades to `medium` (per chip) and caps the system at `medium`                                                                                                  |
| `confidence` computed by the pipeline and stored in the output          | a column in a view; nothing is stored                                                                                                                                         |
| `3u ≥ n` with unknowns inside the basis                                 | `2u ≥ n` with unmapped devices outside it (§4.4) — same threshold                                                                                                             |
| `missing[].reason ∈ (no-implementation, unknown-chip, unmapped-device)` | deleted. `unknown-chip` was reserved and never emitted; `unmapped-device` is now a row in a different table; `no-implementation` is the only remaining case and needs no enum |

The one substantive semantic change is the first. v1's argument was that a class asserts full
interchangeability, so trusting it fully is what "class" means. That argument depended on classes being a
distinct mechanism with a distinct commitment. In the relational model there are no classes: an `equivalent`
row is exactly as much a curated claim as a `provides` row, stored in the same table, differing in direction
rather than in epistemic status. Ranking them 1/2/3 by route is the honest reading of what the data now is,
and it is what makes "100% covered, but two of those chips are substitutions" visible in the UI.

---

## 5. Validation

### 5.1 Free — the schema already enforces it

`chip_equivalence` is defined in data-model.md Appendix A. These need **no code**, and writing checks for them
would be duplicating the database:

| Rule                                | Enforced by                                                           | Verified error                                               |
| ----------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------ |
| Endpoints are real chips            | `FOREIGN KEY … REFERENCES chip(chip_id)` + `PRAGMA foreign_key_check` | `FOREIGN KEY constraint failed`                              |
| No self-edge                        | `CHECK (from_chip_id <> to_chip_id)`                                  | `CHECK constraint failed: from_chip_id <> to_chip_id`        |
| No duplicate directed pair          | `ux_chip_equivalence_pair` (§5.2, adopted)                            | `UNIQUE constraint failed: index 'ux_chip_equivalence_pair'` |
| Canonical order for symmetric edges | `CHECK (kind <> 'equivalent' OR from_chip_id < to_chip_id)`           | `CHECK constraint failed: kind <> 'equivalent' OR …`         |
| `kind` is one of two values         | `CHECK (kind IN ('equivalent','provides'))`                           | `CHECK constraint failed: kind IN ('equivalent','provides')` |
| A note exists                       | `note TEXT NOT NULL`                                                  | `NOT NULL constraint failed: chip_equivalence.note`          |
| Text columns hold text              | `STRICT`                                                              | `cannot store … value in TEXT column`                        |

All seven were exercised as negative tests against a live database; the error strings above are the ones
SQLite actually produced. Note the attribution on the duplicate-pair row: `PRIMARY KEY (from_chip_id,
to_chip_id)` would also reject an exact duplicate, but the shipped schema adopted the unordered-pair index of
§5.2, and that index — being the narrower constraint over the same columns — is what SQLite reports. v1's `EQUIVALENCE_CONFLICT` failure code and its rules 1, 3, 5 and 6 are deleted
along with the code that would have raised them.

**Referential integrity needs no code at all.** `PRAGMA foreign_key_check` returns every dangling reference in
the whole database in one call, which is already a build gate in data-model.md §5.4. Nothing in this document
adds a dangling-reference check, and nothing should.

### 5.2 Unordered-pair uniqueness — **adopted**

The primary key forbids `(a,b)` twice. It does **not** forbid `(a,b)` alongside `(b,a)`, and both mistakes
matter:

- `a provides b` **and** `b provides a` asserts mutual substitutability. That is `equivalent`, and MUST be
  written as one row of that kind. This is v1's 2-cycle rule.
- `a equivalent b` **and** `b provides a` is a contradiction dressed as redundancy: the pair is either
  interchangeable or it is not.

Both collapse into one rule — **a pair of chips carries at most one edge** — and SQLite enforces it for free
with an expression index on the unordered pair:

```sql
-- proposed addition to data-model.md Appendix A, immediately after CREATE TABLE chip_equivalence
CREATE UNIQUE INDEX ux_chip_equivalence_pair
  ON chip_equivalence(MIN(from_chip_id, to_chip_id), MAX(from_chip_id, to_chip_id));
```

Two-argument `min()`/`max()` are deterministic scalar functions, so SQLite accepts them in an index. Verified:
the index creates cleanly on the `STRICT, WITHOUT ROWID` table, and both mistakes above are rejected with
`UNIQUE constraint failed: index 'ux_chip_equivalence_pair'`.

**Adopted**, as delta D2 of `schemas/schema.sql`. It was a constraint tightening on a table with no published
rows, so it carried no migration, and it deleted v1's validation rules 6, 7, 8 and the 2-cycle half of rule 9
at once — plus check V4 below, which was its hand-written alternative.

### 5.3 Cycle policy

> **Decision.** The `provides` graph MUST be acyclic. A cycle is a **build failure**.

Evaluation could not loop — §2.1 traverses one hop, so a cycle is harmless at query time. The rule exists
anyway because a cycle is always a modelling error: capability supersets form a strict partial order, so
`a` cannot be a superset of `b` which is a superset of `a`. With the index of §5.2 in place, 2-cycles are
impossible and only length-≥3 cycles remain — which have never been observed and never will be, but cost one
query to rule out. The check is a reachability closure, not a path walk, so it terminates on cyclic input by
construction (`UNION` deduplicates; the working set is finite):

```sql
WITH RECURSIVE reach(a, b) AS (
  SELECT from_chip_id, to_chip_id FROM chip_equivalence WHERE kind = 'provides'
  UNION
  SELECT r.a, e.to_chip_id
  FROM reach r JOIN chip_equivalence e ON e.from_chip_id = r.b AND e.kind = 'provides'
)
SELECT a AS chip_id FROM reach WHERE a = b ORDER BY a;
```

Any row is a failure; the returned `chip_id` values name every chip on a cycle. A 2-cycle's message MUST tell
the curator to merge the pair into one `equivalent` row. Verified: injecting `m68000 provides m68030` into the
§6 fixture's ladder returns all four chips, and `v_chip_evidence` is unaffected.

### 5.4 The hand-written checks

Everything the schema does not give. Four checks; each is one query. V4, V7a and V10 are struck through
because the schema or the rebuild took them over — a deleted check is a win.

| #       | Rule                                                    | Level       | Query                                                                                               |
| ------- | ------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------- |
| ~~V4~~  | ~~At most one edge per unordered pair~~                 | **free**    | `ux_chip_equivalence_pair` (§5.2, adopted)                                                          |
| V5      | No `provides` cycle                                     | fail        | §5.3                                                                                                |
| ~~V7a~~ | ~~`note` is not blank~~                                 | **free**    | `CHECK (trim(note) <> '')`, delta D3                                                                |
| V7b     | `note` is at least 40 characters                        | **warn**    | `… WHERE LENGTH(TRIM(note)) < 40`                                                                   |
| V8      | Incomplete symmetric set: `a≈b`, `b≈c`, no `a≈c` (§2.3) | **warn**    | below                                                                                               |
| V9      | Both endpoints share a `chip_function`                  | **warn**    | `SELECT … FROM chip_equivalence e JOIN chip a … JOIN chip b … WHERE a.function_id <> b.function_id` |
| ~~V10~~ | ~~coverage-by-kind agrees with `v_system_coverage`~~    | **retired** | There is one definition of coverage, so there is nothing to reconcile (§3.6)                        |

```sql
-- V8: incomplete symmetric set. Warns and names the missing pair.
WITH eq(chip_id, other_chip_id) AS (
  SELECT from_chip_id, to_chip_id FROM chip_equivalence WHERE kind = 'equivalent'
  UNION ALL
  SELECT to_chip_id, from_chip_id FROM chip_equivalence WHERE kind = 'equivalent'
)
SELECT p.chip_id AS chip_a, q.other_chip_id AS chip_c
FROM eq p
JOIN eq q ON q.chip_id = p.other_chip_id
WHERE q.other_chip_id <> p.chip_id
  AND NOT EXISTS (SELECT 1 FROM eq r WHERE r.chip_id = p.chip_id AND r.other_chip_id = q.other_chip_id)
ORDER BY 1, 2;
```

**V9 earns its place** because it catches the one class of error foreign keys cannot: a slug typo that lands on
a _different real chip_. `FOREIGN KEY` proves an endpoint exists; only V9 notices that an edge now runs from a
CPU to a sound chip. It is a warning because a legitimate cross-function edge is conceivable (a part whose
integrated block spans two taxonomy branches), and a warning that names both `function_id` values is enough
for a reviewer to judge.

All checks report **every** violation, sorted by the involved chip ids, so a build is fixable in one pass.

### 5.5 What is deliberately not checked

- **Edges that change nothing.** A `provides` edge whose socket is already directly implemented adds no
  coverage. It is not an error — it is a true fact that may become load-bearing when data changes.
- **Whether an edge is true.** Unfalsifiable by machine. That is what the note and PR review are for.
- **Alias resolution before validation.** There is no alias indirection to resolve: `chip_equivalence`
  endpoints are `chip_id` foreign keys, and `chip_name` is a separate resolution step that never reaches this
  table. v1's `STALE_REFERENCE` warning on equivalence rows is deleted.

### 5.6 The `note` contract

`note` is `NOT NULL` on every edge. Its content contract, unchanged from v1 §9 and still normative:

1. **State the technical relationship** — die shrink, second source, register-compatible superset, ISA
   superset, integrated superset block.
2. **For `provides`, state the direction rationale** — what the provider adds and, when not obvious, why the
   reverse fails.
3. **State known caveats and why they are negligible.** A note may _excuse_ a caveat; it MUST NOT _scope_ the
   claim. If the truthful note needs an "only if…" about the consuming machine, the edge is §1.7 rung 5 and
   MUST NOT exist.
4. **Cite a source** for anything not self-evident from the two chips' own records — datasheet, programmer's
   reference, MAME source path, service manual. Recommended terminal form: `Source: <ref>[, <ref>]`.

The note must be specific enough that a reviewer could falsify it. "Compatible" alone fails review. Notes ship
to the site as the user-visible explanation of every substitution, so they are written for readers.

---

## 6. Worked examples

### 6.0 The fixture

One database, eight examples, all mutually consistent — an implementation added for one example is visible to
all the others, which is what makes the set a usable regression fixture rather than eight unrelated
assertions.

**Convention:** chips, manufacturers, functions and equivalence edges are **real** and MAY be copied into
`data/`. Systems, projects and implementations are fixtures and carry an `fx-` prefix; their BOMs and
implementation claims are shaped to exercise the views, not to describe reality. In particular the fixture
deliberately provides **no** `m68000` and **no** `m6502` FPGA implementation, so the edges are observable; in
the real dataset both exist and those sockets would read `self` / `high`.

**Edges** (all four rows of `chip_equivalence`):

| from     | to       | kind         |
| -------- | -------- | ------------ |
| `m68010` | `m68000` | `provides`   |
| `m68020` | `m68010` | `provides`   |
| `m68030` | `m68020` | `provides`   |
| `ym2612` | `ym3438` | `equivalent` |

The three `provides` rows form the ladder `m68030 → m68020 → m68010 → m68000`.

**Implementations:**

| implementation      | kind                 | claims                                                                        |
| ------------------- | -------------------- | ----------------------------------------------------------------------------- |
| `fx-z80-hdl`        | `fpga_hdl`           | `z80`                                                                         |
| `fx-psg-hdl`        | `fpga_hdl`           | `sn76489`                                                                     |
| `fx-opn2-hdl`       | `fpga_hdl`           | `ym3438`                                                                      |
| `fx-68020-hdl`      | `fpga_hdl`           | `m68020`                                                                      |
| `fx-2a03-hdl`       | `fpga_hdl`           | `rp2a03`                                                                      |
| `fx-core-symmetric` | `fpga_hdl`           | _(a system-level core for `fx-symmetric`, platform `mister`; claims no chip)_ |
| `fx-mame-z80`       | `software_emulation` | `z80`                                                                         |
| `fx-mame-ym2151`    | `software_emulation` | `ym2151`                                                                      |
| `fx-mame-315-5011`  | `software_emulation` | `sega-315-5011`                                                               |

Resulting `v_chip_evidence` at `kind_id = 'fpga_hdl'` — the shared input to E1–E7:

| chip_id   | evidence_rank | best_via     | confidence | provider_chip_id |
| --------- | ------------- | ------------ | ---------- | ---------------- |
| `m68010`  | 3             | `provides`   | `low`      | `m68020`         |
| `m68020`  | 1             | `self`       | `high`     | `m68020`         |
| `rp2a03`  | 1             | `self`       | `high`     | `rp2a03`         |
| `sn76489` | 1             | `self`       | `high`     | `sn76489`        |
| `ym2612`  | 2             | `equivalent` | `medium`   | `ym3438`         |
| `ym3438`  | 1             | `self`       | `high`     | `ym3438`         |
| `z80`     | 1             | `self`       | `high`     | `z80`            |

Every chip absent from that table — `m68000`, `m68030`, `m6502`, `ym2151`, `sega-315-5011` — is unsatisfiable
under `fpga_hdl`, each for a different and instructive reason.

Unless stated otherwise every example queries `kind_id = 'fpga_hdl'`.

---

### 6.1 E1 — a symmetric hit

`fx-symmetric`. Four chips. The YM2612 socket has no YM2612 implementation; it is covered by the YM3438 one
through the symmetric edge, in the direction **not** stored on disk.

| role       | chip            | route                                        |
| ---------- | --------------- | -------------------------------------------- |
| `audiocpu` | `z80`           | `fx-z80-hdl` → `self`                        |
| `sound`    | `sn76489`       | `fx-psg-hdl` → `self`                        |
| `sound`    | `ym2612`        | `fx-opn2-hdl` claims `ym3438` → `equivalent` |
| `video`    | `sega-315-5011` | nothing → `unsatisfied`                      |

**`v_system_chip_coverage`:**

```
chip_id       | satisfied_via | evidence_rank | provider_chip_id | chip_confidence
sega-315-5011 | unsatisfied   | 4             |                  |
sn76489       | self          | 1             | sn76489          | high
ym2612        | equivalent    | 2             | ym3438           | medium
z80           | self          | 1             | z80              | high
```

**`v_system_coverage_by_kind`:**

```
chips_total 4 | chips_direct 2 | chips_equivalent 1 | chips_provided 0 | chips_satisfied 3
satisfied_share 0.75 | pct 75.0 | unmapped_device_count 0 | confidence medium
```

Arithmetic: satisfied = 2 + 1 + 0 = **3**; 3 / 4 = **0.75** → **75.0%**. Confidence: `chips_total ≠ 0`;
`2×0 ≥ 4` false; `0 ≥ 1` false; `chips_equivalent + chips_provided = 1 ≥ 1` → **`medium`**.

Note that the stored row is `(ym2612, ym3438)` — the edge fires in the direction that exists only inside
`v_chip_satisfies`. This is the §1.4 decision doing its job.

---

### 6.2 E2 — a directional hit, in the allowed direction

`fx-68k-hit`. The MC68010 socket is covered by MC68020 HDL: the edge `m68020 provides m68010` runs
provider → socket, which is the direction that is asserted.

| role       | chip     | route                                       |
| ---------- | -------- | ------------------------------------------- |
| `maincpu`  | `m68010` | `fx-68020-hdl` claims `m68020` → `provides` |
| `audiocpu` | `z80`    | `fx-z80-hdl` → `self`                       |

**`v_system_chip_coverage`:**

```
chip_id | satisfied_via | evidence_rank | provider_chip_id | chip_confidence
m68010  | provides      | 3             | m68020           | low
z80     | self          | 1             | z80              | high
```

**`v_system_coverage_by_kind`:**

```
chips_total 2 | chips_direct 1 | chips_equivalent 0 | chips_provided 1 | chips_satisfied 2
satisfied_share 1.0 | pct 100.0 | unmapped_device_count 0 | confidence medium
```

Arithmetic: satisfied = 1 + 0 + 1 = **2**; 2 / 2 = **1.0** → **100.0%**. Confidence: rules 1–3 do not fire;
`chips_provided = 1 ≥ 1` → **`medium`**.

This is §4.1's headline case: **100% covered at `medium` confidence.** The fraction is full and the trust is
not, because half of it rests on a substitution argument. A UI that showed only the percentage would be lying
by omission.

---

### 6.3 E3 — a directional MISS, in the disallowed direction

`fx-68k-miss`. Same edge family, opposite direction. The MC68030 socket is **not** covered by the MC68020
implementation: the edge is `m68030 provides m68020`, so the 68030 is the provider. Nothing provides an
`m68030` socket.

| role       | chip      | route                                                                                     |
| ---------- | --------- | ----------------------------------------------------------------------------------------- |
| `maincpu`  | `m68030`  | the only edge touching it points _away_; `fx-68020-hdl` is the wrong side → `unsatisfied` |
| `audiocpu` | `z80`     | `fx-z80-hdl` → `self`                                                                     |
| `sound`    | `sn76489` | `fx-psg-hdl` → `self`                                                                     |

**`v_system_chip_coverage`:**

```
chip_id | satisfied_via | evidence_rank | provider_chip_id | chip_confidence
m68030  | unsatisfied   | 4             |                  |
sn76489 | self          | 1             | sn76489          | high
z80     | self          | 1             | z80              | high
```

**`v_system_coverage_by_kind`:**

```
chips_total 3 | chips_direct 2 | chips_equivalent 0 | chips_provided 0 | chips_satisfied 2
satisfied_share 0.6666666666666666 | pct 66.7 | unmapped_device_count 0 | confidence high
```

Arithmetic: satisfied = 2 + 0 + 0 = **2**; 2 / 3 = **0.6666…** → `ROUND(66.666…, 1)` = **66.7%**. Confidence:
no unmapped devices and no rank-2/3 chips → **`high`**.

E2 and E3 use the _same implementation set_ and the _same edge family_, and differ only in which end of an
edge the socket sits on. That contrast is the entire content of `provides`. Note also §4.1 in action: 66.7% at
`high` confidence — a miss lowers the fraction and leaves trust intact, because we are certain about it.

---

### 6.4 E4 — two hops is not one hop

`fx-68k-notrans`. The MC68000 socket sits two edges below the implemented chip: `m68020 provides m68010` and
`m68010 provides m68000`, with HDL for `m68020` only. `m68010` has no implementation, so the chain does not
carry.

| role       | chip     | route                                                         |
| ---------- | -------- | ------------------------------------------------------------- |
| `maincpu`  | `m68000` | `m68010` provides it, but `m68010` has no HDL → `unsatisfied` |
| `audiocpu` | `z80`    | `fx-z80-hdl` → `self`                                         |

**`v_system_chip_coverage`:**

```
chip_id | satisfied_via | evidence_rank | provider_chip_id | chip_confidence
m68000  | unsatisfied   | 4             |                  |
z80     | self          | 1             | z80              | high
```

**`v_system_coverage_by_kind`:**

```
chips_total 2 | chips_direct 1 | chips_equivalent 0 | chips_provided 0 | chips_satisfied 1
satisfied_share 0.5 | pct 50.0 | unmapped_device_count 0 | confidence high
```

Arithmetic: satisfied = 1 + 0 + 0 = **1**; 1 / 2 = **0.5** → **50.0%**. Confidence: no unmapped devices, no
rank-2/3 chips → **`high`**.

**This is the transitivity decision as a number.** Under the closure of §2.2 the `m68000` socket would report
`satisfied_via = 'provides'`, `provider_chip_id = 'm68020'`, coverage **100.0%** at `medium` — a claim no
curator made and no note explains. Under §2.1 it reports 50.0% at `high`, and the remedy is visible: if
`m68020 provides m68000` genuinely holds, a curator adds that row with its own note and the fraction moves for
a reason someone signed.

---

### 6.5 E5 — the 2A03 doctrine, converse direction

`fx-2a03`. The system holds an `rp2a03` socket and an `m6502` socket side by side, and RP2A03 HDL exists. The
6502 socket stays uncovered because §1.6 rejects `rp2a03 provides m6502`.

| role      | chip      | route                                              |
| --------- | --------- | -------------------------------------------------- |
| `maincpu` | `m6502`   | no edge from `rp2a03`, by decision → `unsatisfied` |
| `subcpu`  | `rp2a03`  | `fx-2a03-hdl` → `self`                             |
| `sound`   | `sn76489` | `fx-psg-hdl` → `self`                              |

**`v_system_chip_coverage`:**

```
chip_id | satisfied_via | evidence_rank | provider_chip_id | chip_confidence
m6502   | unsatisfied   | 4             |                  |
rp2a03  | self          | 1             | rp2a03           | high
sn76489 | self          | 1             | sn76489          | high
```

**`v_system_coverage_by_kind`:**

```
chips_total 3 | chips_direct 2 | chips_equivalent 0 | chips_provided 0 | chips_satisfied 2
satisfied_share 0.6666666666666666 | pct 66.7 | unmapped_device_count 0 | confidence high
```

Arithmetic: satisfied = 2 + 0 + 0 = **2**; 2 / 3 = **0.6666…** → **66.7%**. Confidence: **`high`** — no
unmapped devices, no substitutions.

The 2A03 is covered and the plain 6502 beside it is not, from one implementation set, in one table. That is
the doctrine made visible: the absence of an edge is a decision with a number attached. The forward direction,
`m6502 provides rp2a03`, is not exhibited because it is not close — a 6502 core supplies no APU — and the
fixture cannot show both directions of one non-edge at once.

---

### 6.6 E6 — one unmapped device degrades confidence

`fx-unmapped-med`. Five chips, all directly implemented, and the system's machine `fxmed1` still references
one MAME device that no `mame_device` row maps.

| chips (all `self`)                             | unmapped devices |
| ---------------------------------------------- | ---------------- |
| `m68020`, `rp2a03`, `sn76489`, `ym3438`, `z80` | `fx_gate_array`  |

**`v_system_coverage_by_kind`:**

```
chips_total 5 | chips_direct 5 | chips_equivalent 0 | chips_provided 0 | chips_satisfied 5
satisfied_share 1.0 | pct 100.0 | unmapped_device_count 1 | confidence medium
```

Arithmetic: satisfied = 5 + 0 + 0 = **5**; 5 / 5 = **1.0** → **100.0%**. Confidence: `chips_total ≠ 0`;
`2×1 = 2 ≥ 5` false; `1 ≥ 1` true → **`medium`**. Unidentified share `1/6 = 0.167`, under the one-third bar.

Every chip we know about has HDL — but we do not know about all of them, so the 100% is provisional. The fix
is curation: map `fx_gate_array` to a chip and the number becomes either honest or lower.

---

### 6.7 E7 — unmapped devices dominate

`fx-unmapped-low`. Four chips, all directly implemented; machine `fxlow1` references two unmapped devices.

| chips (all `self`)                   | unmapped devices              |
| ------------------------------------ | ----------------------------- |
| `m68020`, `sn76489`, `ym3438`, `z80` | `fx_gate_array`, `fx_pal16r8` |

**`v_system_coverage_by_kind`:**

```
chips_total 4 | chips_direct 4 | chips_equivalent 0 | chips_provided 0 | chips_satisfied 4
satisfied_share 1.0 | pct 100.0 | unmapped_device_count 2 | confidence low
```

Arithmetic: satisfied = 4 + 0 + 0 = **4**; 4 / 4 = **1.0** → **100.0%**. Confidence: `2×2 = 4 ≥ 4` true →
**`low`**. Unidentified share `2/6 = 0.333`, exactly at the bar, which resolves to `low` (§4.4).

**100% at `low`.** A third of the board's known parts are unidentified; the fraction is decoration. E6 and E7
differ by exactly one unmapped device and sit either side of the threshold, which makes them the boundary test
for §4.4.

---

### 6.8 E8 — the same system, sliced by implementation kind

`fx-kind`: `z80`, `ym2151`, `sega-315-5011`. The Z80 has FPGA HDL; the YM2151 and the Sega custom have only a
MAME model; nothing has an `original_silicon` row.

**Per chip, `kind_id = 'fpga_hdl'`:**

```
chip_id       | satisfied_via | evidence_rank | provider_chip_id | chip_confidence
sega-315-5011 | unsatisfied   | 4             |                  |
ym2151        | unsatisfied   | 4             |                  |
z80           | self          | 1             | z80              | high
```

**`v_system_coverage_by_kind`, all three kinds:**

```
kind_id            | chips_total | chips_direct | chips_satisfied | pct   | confidence
fpga_hdl           | 3           | 1            | 1               |  33.3 | high
original_silicon   | 3           | 0            | 0               |   0.0 | high
software_emulation | 3           | 3            | 3               | 100.0 | high
```

Arithmetic: `fpga_hdl` 1 / 3 = **0.3333…** → **33.3%**; `original_silicon` 0 / 3 = **0.0** → **0.0%**;
`software_emulation` 3 / 3 = **1.0** → **100.0%**. All three are **`high`** — no unmapped devices and no
substitutions anywhere, so all three fractions are exactly as trustworthy as each other, whatever their value.

This is §3.2's decision paying off: "MAME models all of it, FPGA has a third of it" is one query, and the
`original_silicon` row proves the view is total over kinds even when a kind has no implementations at all.

---

### 6.9 Consolidated expectations

T6.2's regression table. Every value below was produced by executing §3.4 against data-model.md's Appendix A
and B with the §6.0 fixture loaded; `foreign_key_check` and `integrity_check` are clean.

| #   | system            | kind                 | total | direct | equiv | prov | satisfied | fraction | pct   | unmapped | confidence |
| --- | ----------------- | -------------------- | ----- | ------ | ----- | ---- | --------- | -------- | ----- | -------- | ---------- |
| E1  | `fx-symmetric`    | `fpga_hdl`           | 4     | 2      | 1     | 0    | 3         | 3/4      | 75.0  | 0        | `medium`   |
| E2  | `fx-68k-hit`      | `fpga_hdl`           | 2     | 1      | 0     | 1    | 2         | 2/2      | 100.0 | 0        | `medium`   |
| E3  | `fx-68k-miss`     | `fpga_hdl`           | 3     | 2      | 0     | 0    | 2         | 2/3      | 66.7  | 0        | `high`     |
| E4  | `fx-68k-notrans`  | `fpga_hdl`           | 2     | 1      | 0     | 0    | 1         | 1/2      | 50.0  | 0        | `high`     |
| E5  | `fx-2a03`         | `fpga_hdl`           | 3     | 2      | 0     | 0    | 2         | 2/3      | 66.7  | 0        | `high`     |
| E6  | `fx-unmapped-med` | `fpga_hdl`           | 5     | 5      | 0     | 0    | 5         | 5/5      | 100.0 | 1        | `medium`   |
| E7  | `fx-unmapped-low` | `fpga_hdl`           | 4     | 4      | 0     | 0    | 4         | 4/4      | 100.0 | 2        | `low`      |
| E8  | `fx-kind`         | `fpga_hdl`           | 3     | 1      | 0     | 0    | 1         | 1/3      | 33.3  | 0        | `high`     |
| E8  | `fx-kind`         | `software_emulation` | 3     | 3      | 0     | 0    | 3         | 3/3      | 100.0 | 0        | `high`     |
| E8  | `fx-kind`         | `original_silicon`   | 3     | 0      | 0     | 0    | 0         | 0/3      | 0.0   | 0        | `high`     |

`pct` is `ROUND(100.0 * satisfied_share, 1)`. Assert on `total` / `satisfied` / `pct` / `confidence`, never on
the raw REAL (§3.5).

Additional behaviours verified against the same schema, which T6.2 SHOULD also cover:

| Case                                                                | Expected                                                                   |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| System with no BOM at all                                           | `chips_total 0`, `satisfied_share 0.0`, `confidence low`, one row per kind |
| Chip with both a direct implementation **and** an equivalence route | `evidence_rank 1`, `best_via self` — the best route wins                   |
| Two implementations of the same chip and kind                       | one row in `v_chip_satisfied`; counts unchanged                            |
| Two providers tied at the same rank                                 | `provider_chip_id = MIN(...)`, deterministic                               |
| A `provides` cycle injected into the ladder                         | V5 returns every chip on the cycle; `v_chip_evidence` unchanged            |
| `v_prospector` vs `v_system_coverage_by_kind @ fpga_hdl`            | equal by construction — the former reads the latter (§3.6)                 |

---

## 7. Coverage in the canonical queries

**Q5 — coverage for one system**, now sliceable by kind:

```sql
SELECT * FROM v_system_coverage_by_kind
WHERE system_id = :system_id AND kind_id = :kind_id;
```

and its per-socket explanation, which is v1's `missing[]` where `satisfied_via = 'unsatisfied'`:

```sql
SELECT chip_id, satisfied_via, provider_chip_id, chip_confidence
FROM v_system_chip_coverage
WHERE system_id = :system_id AND kind_id = :kind_id
ORDER BY evidence_rank, chip_id;
```

**Q4 — the chip gap.** `v_chip_gap` (Appendix B) already excludes chips reachable through an edge: a chip
whose equivalent has HDL is not a gap. It is built on `v_chip_evidence` and carries `kind_id` as a column, so
`WHERE kind_id = 'fpga_hdl'` is the FPGA gap and `WHERE kind_id = 'software_emulation'` is the MAME one.

**Q2 — the Prospector.** `v_prospector` slices by platform, which is where platform is a real fact (§3.3),
and it now reads `v_system_coverage_by_kind` directly — so confidence is a column, not a join:

```sql
SELECT p.system_id, s.name, p.chips_total, p.chips_satisfied,
       ROUND(100.0 * p.satisfied_share, 1) AS satisfied_pct,
       p.chips_equivalent, p.chips_provided,
       p.unmapped_device_count, p.confidence
FROM v_prospector p
JOIN system s ON s.system_id = p.system_id
WHERE p.platform_id = :platform_id
ORDER BY p.satisfied_share DESC, p.unmapped_device_count ASC, p.chips_total DESC, p.system_id;
```

Ordering by `satisfied_share` then `unmapped_device_count` keeps honest candidates above flattering ones — a
board at 100% with two unmapped devices sorts below a board at 100% with none. `confidence` is the badge; the
sort keys are the raw counts, because a three-value column is too coarse to rank on. Weighting by
`chip_function.prospector_band` is an extra join and an `ORDER BY` expression — T6.3's config, not a schema
concern.

---

## 8. What this supersedes

`docs/equivalences.md` (spec 1.0.0) is **deleted**. Disposition of its contents:

| v1 section                             | Disposition                                                                                                                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §1 the two relations                   | **kept**, restated over `chip_equivalence` — §1.1–§1.3                                                                                                                          |
| §2 file shape (`equivalences.json`)    | **void.** The table is the shape; the file is `data/chip_equivalence.json` per data-model.md §4.2                                                                               |
| §3 decision ladder                     | **kept**, rungs re-pointed at relational mechanisms — §1.7                                                                                                                      |
| §4.1–§4.3 `satisfied()`                | **void.** Replaced by `v_chip_satisfies` + `v_chip_evidence`                                                                                                                    |
| §4.2 class lifting                     | **void.** There are no classes, so there is nothing to lift                                                                                                                     |
| §5.1 classes transitively closed       | **void.** Replaced by §2.3 — a k-set is k(k−1)/2 rows                                                                                                                           |
| §5.2 single-hop soundness              | **kept and extended** to `equivalent` — §2.1                                                                                                                                    |
| §5.3 DAG rule                          | **kept** as §5.3; 2-cycles become a database constraint if §5.2 is adopted                                                                                                      |
| §6 conditional equivalence, 2A03       | **kept**, strengthened by the `implementation_chip` valve — §1.6, §1.7 rung 5                                                                                                   |
| §7.1 distinct-chip basis               | **kept** — §3.1                                                                                                                                                                 |
| §7.2 the numbers                       | **void as arithmetic**, replaced by §3.4. `percent`/`Math.round` become `ROUND(100.0 * share, 1)`                                                                               |
| §7.3 `missing[].reason` enum           | **void** — §4.5                                                                                                                                                                 |
| §7.4 family coverage                   | **void.** "Family" is `system`; per-system coverage is the only coverage                                                                                                        |
| §8 confidence                          | **kept in spirit**, restated as view columns; `equivalent` now degrades — §4                                                                                                    |
| §9 note contract                       | **kept verbatim in force** — §5.6                                                                                                                                               |
| §10 validation, `EQUIVALENCE_CONFLICT` | **mostly void.** Rules 1, 3, 5, 6 are schema constraints; 2, 4, 7, 8 concern classes or file order and do not exist; 9 survives as §5.3. Four hand-written checks remain — §5.4 |

Machine-level coverage is deliberately **not** specified. It is the same three views with `v_machine_bom`
substituted for `v_system_chip_effective`; no canonical query needs it (Q1–Q5 are all system-level), and an
unused view is a maintenance liability. Adding it later is additive.

---

## Change control

Spec version is semver, tracked alongside `data-model.md`. Adding a view, adding a lookup row, or adding a
validation warning is a **minor** bump. Changing the `evidence_rank` ladder, the confidence rules, the
one-third threshold, the transitivity decision, or the symmetry storage decision is a **major** bump and
requires a migration note in `docs/versioning.md` — every one of them silently changes published numbers.
