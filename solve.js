// A fast drop-in for makefun-diff 1.0.0: run(input) returns exactly what
// makefun-diff returns for { old, new }, two texts, as one JSON string (the
// patch is returned as the string itself, like the reference: the harness
// wraps it in answers.json), but without the reference's per-diagonal
// object allocations and string comparisons.
//
// How it stays identical: it follows the reference's rule line for line.
// A text is cut after every "\n" (a "\r" is part of its line), a last line
// with no "\n" is a line too, and two lines are equal only when they are the
// same code units. The common prefix of lines is kept, then the common
// suffix of the lines left. Between them Myers's greedy search runs from
// the first lines: for d = 0, 1, 2, ... and each diagonal k = x - y from -d
// to d in steps of 2, the furthest point a path of d edits reaches on k is
// one old line past the furthest (d-1)-point on k - 1 (a deletion) or one
// new line past the furthest (d-1)-point on k + 1 (an insertion), whichever
// lies further into the old text, and the deletion when both reach the same
// point; a move past the end of either text is no candidate, no edge
// diagonal is pruned, and from that point the path follows every run of
// lines equal in both as far as it goes; the first path to reach both ends
// is the script. The patch is then built exactly as the reference builds
// it: header line, hunks with 3 kept lines of context, runs at most 6 kept
// lines apart sharing a hunk, deletions before insertions in each run, and
// a line with no trailing newline written with one and followed by "%".
//
// How it is fast:
// - Every distinct line is interned once to a small integer id (one Map
//   lookup per line), so the whole search compares integers, never strings,
//   and the snake never re-hashes or re-compares line text.
// - The search keeps the furthest x per diagonal in flat Int32Arrays, one
//   snapshot per d, instead of a linked list of path objects per diagonal:
//   no per-step allocation, and the backtrack reads the snapshots straight
//   off instead of walking histories. The backtrack needs no line
//   comparisons at all: the point an edit starts at is read from the
//   previous snapshot, and the kept run between two edits is the difference
//   of the two x values.
// - Tokenizing is one indexOf scan per text; the old and new line arrays
//   are never copied (the middle is a subarray view).

const KEEP = 0;
const DELETE = 1;
const INSERT = 2;

/** A text's lines, each with its "\n" (the last one without, when the text does not end in one). */
function linesOf(text) {
  const lines = [];
  let start = 0;
  for (;;) {
    const idx = text.indexOf('\n', start);
    if (idx === -1) {
      if (start < text.length) lines.push(text.slice(start));
      return lines;
    }
    lines.push(text.slice(start, idx + 1));
    start = idx + 1;
  }
}

/** Both texts' lines as integer ids from one shared interning map. */
function toIds(oldLines, newLines) {
  const map = new Map();
  let next = 0;
  const a = new Int32Array(oldLines.length);
  for (let i = 0; i < oldLines.length; i++) {
    const s = oldLines[i];
    let id = map.get(s);
    if (id === undefined) {
      id = next++;
      map.set(s, id);
    }
    a[i] = id;
  }
  const b = new Int32Array(newLines.length);
  for (let i = 0; i < newLines.length; i++) {
    const s = newLines[i];
    let id = map.get(s);
    if (id === undefined) {
      id = next++;
      map.set(s, id);
    }
    b[i] = id;
  }
  return [a, b];
}

/**
 * The edit runs of the middle slices a into b: [{ kind, count }], in order.
 * a and b are Int32Array views; the common prefix and suffix are already off.
 */
function myers(a, b) {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  // Vs[d] is the furthest x reached on each diagonal k in [-d, d] after d
  // edits and the snake, at index k + d; -1 means the diagonal is unreached.
  const Vs = [];
  let x = 0;
  let y = 0;
  while (x < n && y < m && a[x] === b[y]) {
    x++;
    y++;
  }
  const v0 = new Int32Array(1);
  v0[0] = x;
  Vs.push(v0);
  if (x >= n && y >= m) return x > 0 ? [{ kind: KEEP, count: x }] : [];
  const maxD = n + m;
  let D = -1;
  let kF = 0;
  outer: for (let d = 1; d <= maxD; d++) {
    const vd = new Int32Array(2 * d + 1);
    Vs.push(vd);
    const prev = Vs[d - 1];
    // Diagonal k reads its deletion candidate from prev[k - 1] and its
    // insertion candidate from prev[k + 1]; as k steps by 2, the insertion
    // candidate just read is the next k's deletion candidate, so it is
    // carried over instead of read again. The two edge diagonals have only
    // one candidate each (the other is out of range), so they are handled
    // on their own and the inner loop needs no bounds checks. vi and pi are
    // the running indexes into vd and prev, stepped by 2 with k.
    let ad = prev[0]; // prev[k + 1] for k = -d: diagonal -(d - 1)
    // k = -d: deletion impossible, insertion from ad.
    {
      const k = -d;
      if (ad !== -1 && ad - (k + 1) < m) {
        let nx = ad;
        let ny = nx - k;
        if (nx < n && ny < m && a[nx] === b[ny]) {
          let s = 1;
          const lim = n - nx < m - ny ? n - nx : m - ny;
          while (s < lim && a[nx + s] === b[ny + s]) s++;
          nx += s;
          ny += s;
        }
        vd[0] = nx;
        if (nx >= n && ny >= m) {
          D = d;
          kF = k;
          break outer;
        }
      } else {
        vd[0] = -1;
      }
    }
    let vi = 2;
    let pi = 2;
    for (let k = -d + 2; k <= d - 2; k += 2) {
      const rm = ad;
      ad = prev[pi];
      pi += 2;
      const canRemove = rm !== -1 && rm < n;
      const canAdd = ad !== -1 && ad - (k + 1) < m;
      let nx;
      if (canRemove && canAdd) nx = rm >= ad - 1 ? rm + 1 : ad;
      else if (canRemove) nx = rm + 1;
      else if (canAdd) nx = ad;
      else {
        vd[vi] = -1;
        vi += 2;
        continue;
      }
      let ny = nx - k;
      if (nx < n && ny < m && a[nx] === b[ny]) {
        let s = 1;
        const lim = n - nx < m - ny ? n - nx : m - ny;
        while (s < lim && a[nx + s] === b[ny + s]) s++;
        nx += s;
        ny += s;
      }
      vd[vi] = nx;
      vi += 2;
      if (nx >= n && ny >= m) {
        D = d;
        kF = k;
        break outer;
      }
    }
    // k = d: insertion impossible, deletion from ad (prev's diagonal d - 1).
    {
      const k = d;
      if (ad !== -1 && ad < n) {
        let nx = ad + 1;
        let ny = nx - k;
        if (nx < n && ny < m && a[nx] === b[ny]) {
          let s = 1;
          const lim = n - nx < m - ny ? n - nx : m - ny;
          while (s < lim && a[nx + s] === b[ny + s]) s++;
          nx += s;
          ny += s;
        }
        vd[2 * d] = nx;
        if (nx >= n && ny >= m) {
          D = d;
          kF = k;
          break outer;
        }
      } else {
        vd[2 * d] = -1;
      }
    }
  }
  if (D === -1) throw new Error('makefun-diff: the search ended without reaching both ends');
  // Backtrack from (D, kF): the edit at step d starts at the point the
  // previous snapshot names, and the kept run before it is the x gap.
  const rev = [];
  let cx = Vs[D][kF + D];
  let ck = kF;
  for (let d = D; d >= 1; d--) {
    const prev = Vs[d - 1];
    const pm = d - 1;
    const plen = prev.length;
    const rmIdx = ck - 1 + pm;
    const adIdx = ck + 1 + pm;
    const rm = rmIdx >= 0 && rmIdx < plen ? prev[rmIdx] : -1;
    const ad = adIdx >= 0 && adIdx < plen ? prev[adIdx] : -1;
    const canRemove = rm !== -1 && rm < n;
    const canAdd = ad !== -1 && ad - (ck + 1) < m;
    let xStep;
    let isDel;
    if (canRemove && (!canAdd || rm >= ad - 1)) {
      xStep = rm + 1;
      isDel = true;
    } else if (canAdd) {
      xStep = ad;
      isDel = false;
    } else {
      throw new Error('makefun-diff: the backtrack lost its path');
    }
    const keep = cx - xStep;
    if (keep > 0) rev.push({ kind: KEEP, count: keep });
    rev.push({ kind: isDel ? DELETE : INSERT, count: 1 });
    cx = isDel ? rm : ad;
    ck = isDel ? ck - 1 : ck + 1;
  }
  if (cx > 0) rev.push({ kind: KEEP, count: cx });
  const runs = [];
  for (let i = rev.length - 1; i >= 0; i--) {
    const r = rev[i];
    const last = runs[runs.length - 1];
    if (last !== undefined && last.kind === r.kind) last.count += r.count;
    else runs.push({ kind: r.kind, count: r.count });
  }
  return runs;
}

/** A line as the patch writes it: its op, the line, a newline, and "%" on a line of its own when it had none. */
function written(op, line) {
  return line.endsWith('\n') ? op + line : op + line + '\n%\n';
}

/** makefun-diff 1.0.0's answer for one case's input. */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('makefun-diff: the input is { old, new }, two strings');
  }
  const oldLines = linesOf(input.old);
  const newLines = linesOf(input.new);
  const n = oldLines.length;
  const m = newLines.length;
  const [a, b] = toIds(oldLines, newLines);
  // The common prefix, then the common suffix of what is left.
  let prefix = 0;
  while (prefix < n && prefix < m && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && a[n - 1 - suffix] === b[m - 1 - suffix]) suffix++;
  const runs = [];
  if (prefix > 0) runs.push({ kind: KEEP, count: prefix });
  for (const r of myers(a.subarray(prefix, n - suffix), b.subarray(prefix, m - suffix))) {
    const last = runs[runs.length - 1];
    if (last !== undefined && last.kind === r.kind) last.count += r.count;
    else runs.push({ kind: r.kind, count: r.count });
  }
  if (suffix > 0) {
    const last = runs[runs.length - 1];
    if (last !== undefined && last.kind === KEEP) last.count += suffix;
    else runs.push({ kind: KEEP, count: suffix });
  }

  // The change runs: each a stretch of deletions and insertions between two kept lines, at old line o and new line p.
  const changes = [];
  let o = 0;
  let p = 0;
  let deleted = 0;
  let inserted = 0;
  for (const r of runs) {
    if (r.kind === KEEP) {
      o += r.count;
      p += r.count;
      continue;
    }
    let c = changes[changes.length - 1];
    if (c === undefined || c.o + c.dels !== o || c.p + c.ins !== p) {
      c = { o, p, dels: 0, ins: 0 };
      changes.push(c);
    }
    if (r.kind === DELETE) {
      c.dels += r.count;
      o += r.count;
      deleted += r.count;
    } else {
      c.ins += r.count;
      p += r.count;
      inserted += r.count;
    }
  }

  // The hunks: change runs at most 6 kept lines apart share one.
  const hunks = [];
  for (const c of changes) {
    const h = hunks[hunks.length - 1];
    const prev = h !== undefined ? h[h.length - 1] : undefined;
    if (prev !== undefined && c.o - (prev.o + prev.dels) <= 6) h.push(c);
    else hunks.push([c]);
  }
  const out = [`makefun-diff/1 old=${n} new=${m} hunks=${hunks.length} deleted=${deleted} inserted=${inserted}\n`];
  for (const h of hunks) {
    const first = h[0];
    const last = h[h.length - 1];
    const oldStart = Math.max(0, first.o - 3);
    const newStart = first.p - (first.o - oldStart);
    const after = Math.min(3, n - (last.o + last.dels));
    const oldEnd = last.o + last.dels + after;
    const newEnd = last.p + last.ins + after;
    out.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (const c of h) {
      for (; at < c.o; at++) out.push(written('=', oldLines[at]));
      for (let i = 0; i < c.dels; i++) out.push(written('-', oldLines[c.o + i]));
      for (let i = 0; i < c.ins; i++) out.push(written('+', newLines[c.p + i]));
      at = c.o + c.dels;
    }
    for (; at < oldEnd; at++) out.push(written('=', oldLines[at]));
  }
  return out.join('');
}
