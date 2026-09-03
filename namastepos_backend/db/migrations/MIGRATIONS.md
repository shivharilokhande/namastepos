# Migrations — conventions & deliberate gaps

## How migrations run

`npm run migrate` (`scripts/migrate.js`) reads every `*.sql` file in this
directory, sorts them **lexically by filename**, and applies each unapplied
file inside one transaction, recording it in the `_migrations` table (keyed by
filename). Tests (`tests/setup.js#resetDb`) apply the same files the same way
onto a fresh schema.

## Numbering convention

- Filenames are `NNN_short_description.sql` — a zero-padded 3-digit sequence
  number plus a snake_case summary. The zero-padding is what makes lexical
  sort equal numeric sort, so **always keep three digits**.
- Take the next unused number when adding a migration. Never renumber or
  rename a file that may have been applied anywhere (the `_migrations` key is
  the filename — renaming re-applies it).
- Migrations are **forward-only and additive**: no rollback scripts (see
  `migrate:rollback` stub), no `DROP TABLE`/`DROP COLUMN` of data-bearing
  columns, no destructive rewrites. Deprecated columns are kept and stop being
  written instead (see `docs/adr/ADR-001-money-paise-unification.md`).

## Deliberate gaps in the sequence

The runner keys on filenames, not numbers, so gaps are harmless — but they are
confusing without a record. These numbers are **intentionally unused; do not
backfill them** (an environment could theoretically still carry a `_migrations`
row for one of these names):

| Number | What happened |
|--------|---------------|
| 063, 064 | Held pricing / plan-ladder migrations (2026-08-26/27 NOW-block). Never deployed to production — the founder decided on 2026-08-28 to keep the existing live pricing, and the held files were deleted rather than shipped. |
| 067    | Held migration from the NEXT/LATER-block work (2026-08-28); dropped before deploy. Its neighbours 066 (support tickets) and 068 (add-on revenue share) shipped. |

These numbers are retired: even though the files never reached production, a
stray dev database could carry `_migrations` rows for them, so reusing the
numbers risks a silent skip. Take a fresh number.

Also note: `059`–`062` were created slightly out of chronological order
(`061_google_reviews.sql` predates `059`/`060` in commit history) — harmless,
since apply order is lexical.

## Future work (deferred on purpose)

- **orderService.js split** — deliberately NOT split during the NP-145
  route-file cleanup (2026-09-03): it is the hottest file in the codebase
  (billing math, offline sync, races already tuned); splitting it is deferred
  until it has dedicated test coverage for the seams.
- **Money unification to integer paise** — staged plan lives in
  `docs/adr/ADR-001-money-paise-unification.md`. All new money columns must be
  `BIGINT` paise (`*_paise` suffix), never `NUMERIC` rupees.
