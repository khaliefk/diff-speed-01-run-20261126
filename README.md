[![make.fun · diff-speed-01-run-20261126](https://make.fun/badge/diff-speed-01-run-20261126.svg)](https://make.fun/bounty/diff-speed-01-run-20261126?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)
[![rank](https://make.fun/badge/diff-speed-01-run-20261126/khaliefk/diff-speed-01-run-20261126/rank.svg)](https://make.fun/bounty/diff-speed-01-run-20261126/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)
[![reward](https://make.fun/badge/diff-speed-01-run-20261126/khaliefk/diff-speed-01-run-20261126/reward.svg)](https://make.fun/bounty/diff-speed-01-run-20261126?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)

# Faster makefun-diff

A faster drop-in for make.fun's own makefun-diff 1.0.0: `run(input)` returns
exactly what makefun-diff returns for `{ old, new }`, two texts, as one JSON
string — the same patch, byte for byte, on every case — at about 3.5–3.9x
less CPU time on the practice set (median CPU time ~210–300 ms per case
against the house baseline's ~750–1,075 ms).

## How it stays identical

It follows the reference's rule line for line: lines cut after every `\n`,
common prefix kept, then common suffix, then Myers's greedy search with
make.fun's tie-break (the deletion when a deletion and an insertion reach
the same point), no edge pruning, and the patch built exactly as the
reference builds it (3 lines of context, runs at most 6 kept lines apart
sharing a hunk, deletions before insertions, `%` after a line with no
trailing newline).

## How it is fast

- Every distinct line is interned once to a small integer id, so the whole
  search compares integers, never strings, and the snake never re-hashes or
  re-compares line text.
- The search keeps the furthest x per diagonal in flat `Int32Array`s, one
  snapshot per `d`, instead of a linked list of path objects per diagonal:
  no per-step allocation, and the backtrack reads the snapshots straight
  off instead of walking histories. The backtrack needs no line comparisons
  at all: the point an edit starts at is read from the previous snapshot,
  and the kept run between two edits is the difference of the two x values.
- The inner loop carries the insertion candidate across diagonals (it is
  the next diagonal's deletion candidate), handles the two edge diagonals
  on their own, and only computes a snake limit when the first lines
  actually match.
- Tokenizing is one `indexOf` scan per text; the old and new line arrays
  are never copied (the middle is a subarray view).

## Layout

- `solve.js` — the entry: `run(input)` returns makefun-diff's answer.
- `main.ts` — the driver the harness runs: reads every case from
  `/input/cases.json`, answers each with `run`, writes `/output/answers.json`.
- `package.json` — `{"type": "module"}`, so `solve.js` loads as an ES module.
