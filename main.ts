// mend — the patch tool SPEC.md (version 1) specifies.
//
// It reads one patch in four formats (unified diff, SEARCH/REPLACE blocks, the V4A patch
// format, text-editor tool calls as JSON), finds the lines each edit names at the first of
// three matching tiers, and writes every change or none. Node 22, standard library alone.
// Run as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and this file
// hands over to runner.ts beside it; the hand-over at the bottom does that.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'] as const;
type FormatName = (typeof FORMATS)[number];

/** An exit-2 outcome: one line of output, nothing written. */
class ParseFault extends Error {
  readonly line: string;
  constructor(line: string) {
    super(line);
    this.line = line;
  }
}

/** One failed edit: its code and the path the failure concerns. */
class EditFault extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    super(`${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines (SPEC section 3): split at `\n`, one trailing `\r` off each, and no
 *  empty piece after a final `\n`. */
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/** Byte order of paths, as UTF-8. */
function byteOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** A file as lines: its line break, its lines, and whether it ends with a line break. */
interface Doc {
  br: '\n' | '\r\n';
  lines: string[];
  final: boolean;
}

function parseDoc(text: string): Doc {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br: '\n' | '\r\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function renderDoc(d: Doc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.final ? d.br : '');
}

/** The tree as the edits leave it. `pending` holds paths an edit touched (null: deleted);
 *  anything else is read from disk when first needed. */
class Tree {
  private disk = new Map<string, string | null>();
  readonly pending = new Map<string, string | null>();
  readonly moves: { old: string; nw: string }[] = [];

  /** A path's bytes before the patch, or null when it did not exist. */
  before(p: string): string | null {
    if (!this.disk.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.disk.set(p, v);
    }
    return this.disk.get(p)!;
  }

  /** A path's bytes as earlier edits left them, or null when it is gone. */
  current(p: string): string | null {
    return this.pending.has(p) ? this.pending.get(p)! : this.before(p);
  }
}

/** One line of an old block O or a new block N; `context` marks a line of both. */
interface PatchLine {
  text: string;
  context: boolean;
}

/** A line compared at a tier: tier 1 drops trailing spaces and tabs, tier 2 drops the
 *  leading ones too. */
function tiered(s: string, tier: number): string {
  if (tier === 0) return s;
  const tail = s.replace(/[ \t]+$/, '');
  return tier === 1 ? tail : tail.replace(/^[ \t]+/, '');
}

/** Every 0-based position where O occurs in `lines` at `tier`, at or after `from`. */
function occurrences(lines: string[], o: string[], tier: number, from = 0): number[] {
  const want = o.map((l) => tiered(l, tier));
  const found: number[] = [];
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < o.length; k++) {
      if (tiered(lines[i + k]!, tier) !== want[k]) {
        ok = false;
        break;
      }
    }
    if (ok) found.push(i);
  }
  return found;
}

/** The first tier (0, 1, 2, or -1 when there is none) at which O occurs in `lines`. */
function firstTier(lines: string[], o: string[], strict: boolean, from = 0): number {
  const top = strict ? 0 : 2;
  for (let tier = 0; tier <= top; tier++) {
    if (occurrences(lines, o, tier, from).length > 0) return tier;
  }
  return -1;
}

/** The lines that replace O's k matched lines at `at` (SPEC section 5). A context line is
 *  written as the file's own matched line; at tier 2 every other line is re-indented from
 *  O's first line's leading whitespace to the file's first matched line's. */
function replacementLines(lines: string[], o: PatchLine[], n: PatchLine[], at: number, tier: number): string[] {
  const p = o.length > 0 ? leadingWs(o[0]!.text) : '';
  const f = o.length > 0 ? leadingWs(lines[at]!) : '';
  const out: string[] = [];
  let oi = 0;
  for (const item of n) {
    if (item.context) {
      while (oi < o.length && !o[oi]!.context) oi++;
      out.push(lines[at + oi]!);
      oi++;
    } else if (tier === 2 && item.text !== '' && item.text.trim() !== '' && item.text.startsWith(p)) {
      out.push(f + item.text.slice(p.length));
    } else {
      out.push(item.text);
    }
  }
  return out;
}

/** The command line (SPEC section 1). */
interface Options {
  format: FormatName;
  check: boolean;
  strict: boolean;
  patch: string | null;
}

function parseArgs(args: string[]): Options {
  let format: FormatName | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        const v = a.slice('--format='.length);
        if (format !== null || !(FORMATS as readonly string[]).includes(v)) {
          throw new ParseFault('error: usage');
        }
        format = v as FormatName;
      } else if (a === '--check' && !check) {
        check = true;
      } else if (a === '--strict' && !strict) {
        strict = true;
      } else {
        throw new ParseFault('error: usage');
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) throw new ParseFault('error: usage');
  return {
    format: format ?? 'auto',
    check,
    strict,
    patch: pos.length === 0 || pos[0] === '-' ? null : pos[0]!,
  };
}

/** One edit of the patch: the paths it names (safety-checked first, in this order) and
 *  the work it does on the tree. A failed edit throws EditFault and changes nothing. */
interface Edit {
  paths: string[];
  run: (tree: Tree, strict: boolean) => void;
}

/** The patch's format (SPEC section 4): the first of these that holds. */
function detectFormat(lines: string[]): FormatName | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) {
    return 'unified';
  }
  if (lines.some((l) => l.trim() === '*** Begin Patch')) return 'v4a';
  return null;
}

// ---- Unified diffs (SPEC section 6) ----

interface Hunk {
  a: number;
  o: PatchLine[];
  n: PatchLine[];
  /** A `\` line immediately follows the hunk's last context or `+` line. */
  noEol: boolean;
  /** A `\` line immediately follows the hunk's last `+` line. */
  noEolPlus: boolean;
}

interface BodyCell {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
  /** True when the patch line itself was empty (a ` ` line is not empty). */
  empty: boolean;
}

/** A hunk body: the lines after the header, up to the first line that is not one. */
function parseHunkBody(lines: string[], i: number): { hunk: Hunk; next: number } {
  const body: BodyCell[] = [];
  let j = i + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      body.push({ kind: 'ctx', text: '', empty: true });
      j++;
      continue;
    }
    const c = l[0]!;
    if (c === ' ') {
      body.push({ kind: 'ctx', text: l.slice(1), empty: false });
      j++;
    } else if (c === '-') {
      body.push({ kind: 'old', text: l.slice(1), empty: false });
      j++;
    } else if (c === '+') {
      body.push({ kind: 'new', text: l.slice(1), empty: false });
      j++;
    } else if (c === '\\') {
      body.push({ kind: 'bs', text: l, empty: false });
      j++;
    } else {
      break;
    }
  }
  while (body.length > 0 && body[body.length - 1]!.empty) body.pop();
  const o: PatchLine[] = [];
  const n: PatchLine[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      o.push({ text: b.text, context: true });
      n.push({ text: b.text, context: true });
    } else if (b.kind === 'old') {
      o.push({ text: b.text, context: false });
    } else if (b.kind === 'new') {
      n.push({ text: b.text, context: false });
    }
  }
  let noEol = false;
  let noEolPlus = false;
  for (let k = body.length - 1; k >= 0; k--) {
    const kind = body[k]!.kind;
    if (kind === 'ctx' || kind === 'new') {
      noEol = k + 1 < body.length && body[k + 1]!.kind === 'bs';
      break;
    }
  }
  for (let k = body.length - 1; k >= 0; k--) {
    if (body[k]!.kind === 'new') {
      noEolPlus = k + 1 < body.length && body[k + 1]!.kind === 'bs';
      break;
    }
  }
  return { hunk: { a: 0, o, n, noEol, noEolPlus }, next: j };
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)$/;

/** A `--- `/`+++ ` path: text after the four characters, up to the first tab, surrounding
 *  spaces removed, a leading `a/` or `b/` removed. `/dev/null` means no file. */
function headerPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p.startsWith('a/')) p = p.slice(2);
  else if (p.startsWith('b/')) p = p.slice(2);
  return p === '/dev/null' ? null : p;
}

/** A `rename from`/`rename to` path: the rest of the line, up to the first tab, trimmed. */
function renamePath(line: string, prefix: string): string {
  let p = line.slice(prefix.length);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  return p.trim();
}

interface SectionHead {
  oldRaw: string | null;
  newRaw: string | null;
  kind: 'create' | 'delete' | 'move' | 'change';
  hunks: Hunk[];
}

/** One unified section, from `start` to the next section or the end of the patch.
 *  The header is read first; when it says the section is a deletion, the hunks are
 *  not read at all (SPEC section 6) — the lines up to the next section are skipped. */
function parseUnifiedSection(lines: string[], start: number, diffPaths: { old: string; nw: string } | null, pairAtStart: boolean): { section: SectionHead; next: number } {
  let oldPair: string | null | undefined;
  let newPair: string | null | undefined;
  let renameOld: string | null | undefined;
  let renameNew: string | null | undefined;
  let newFile = false;
  let delFile = false;
  let pairSeen = false;
  let i = start;
  if (pairAtStart) {
    oldPair = headerPath(lines[i]!);
    newPair = headerPath(lines[i + 1]!);
    pairSeen = true;
    i += 2;
  }
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('@@')) break;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (pairSeen) break;
      oldPair = headerPath(l);
      newPair = headerPath(lines[i + 1]!);
      pairSeen = true;
      i += 2;
      continue;
    }
    if (l.startsWith('--- ')) throw new ParseFault(`error: parse ${i + 2}`);
    if (l.startsWith('rename from ')) renameOld = renamePath(l, 'rename from ');
    else if (l.startsWith('rename to ')) renameNew = renamePath(l, 'rename to ');
    else if (l.startsWith('new file mode')) newFile = true;
    else if (l.startsWith('deleted file mode')) delFile = true;
    i++;
  }
  const pick = (a: string | null | undefined, b: string | null | undefined, c: string | undefined): string | null | undefined => {
    if (a !== undefined) return a;
    if (b !== undefined) return b;
    return c;
  };
  const oldV = pick(oldPair, renameOld, diffPaths?.old);
  const newV = pick(newPair, renameNew, diffPaths?.nw);
  let oldRaw: string | null = oldV === undefined ? (newV ?? null) : oldV;
  let newRaw: string | null = newV === undefined ? (oldV ?? null) : newV;
  const kind: SectionHead['kind'] =
    oldRaw === null || newFile ? 'create' : newRaw === null || delFile ? 'delete' : oldRaw !== newRaw ? 'move' : 'change';
  if (kind === 'delete') {
    while (i < lines.length) {
      const l = lines[i]!;
      if (l.startsWith('diff --git ')) break;
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
      i++;
    }
    return { section: { oldRaw, newRaw, kind, hunks: [] }, next: i };
  }
  const hunks: Hunk[] = [];
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('@@')) {
      const hm = HUNK_HEAD.exec(l);
      if (hm === null) throw new ParseFault(`error: parse ${i + 1}`);
      const parsed = parseHunkBody(lines, i);
      parsed.hunk.a = Number(hm[1]);
      hunks.push(parsed.hunk);
      i = parsed.next;
      continue;
    }
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    i++;
  }
  return { section: { oldRaw, newRaw, kind, hunks }, next: i };
}

/** All edits of a unified patch (SPEC section 6). */
function parseUnified(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(l);
      if (m === null) throw new ParseFault(`error: parse ${i + 1}`);
      const parsed = parseUnifiedSection(lines, i + 1, { old: m[1]!, nw: m[2]! }, false);
      edits.push(unifiedEdit(parsed.section));
      i = parsed.next;
    } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const parsed = parseUnifiedSection(lines, i, null, true);
      edits.push(unifiedEdit(parsed.section));
      i = parsed.next;
    } else if (l.startsWith('@@')) {
      throw new ParseFault(`error: parse ${i + 1}`);
    } else {
      i++;
    }
  }
  return edits;
}

/** Apply a section's hunks to a file's lines, in order, tracking the drift `d`. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const doc = parseDoc(text);
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      const pos = Math.min(h.a + d, doc.lines.length);
      const atEnd = pos === doc.lines.length;
      const ins = h.n.map((l) => l.text);
      doc.lines.splice(pos, 0, ...ins);
      if (atEnd) doc.final = !h.noEol;
      d += ins.length;
      continue;
    }
    const oText = h.o.map((l) => l.text);
    const tier = firstTier(doc.lines, oText, strict);
    if (tier < 0) throw new EditFault('no-match', path);
    const occ = occurrences(doc.lines, oText, tier);
    const target = h.a - 1 + d;
    let best = occ[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of occ) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const touchesEnd = best + h.o.length === doc.lines.length;
    const repl = replacementLines(doc.lines, h.o, h.n, best, tier);
    doc.lines.splice(best, h.o.length, ...repl);
    if (touchesEnd) doc.final = !h.noEol;
    d += h.n.length - h.o.length;
  }
  return renderDoc(doc);
}

function unifiedEdit(sec: SectionHead): Edit {
  const { oldRaw, newRaw, kind, hunks } = sec;
  if (kind === 'create') {
    if (newRaw === null) return { paths: [], run: () => {} }; // both sides /dev/null: nothing to create
    const np = newRaw;
    return {
      paths: [np],
      run(tree) {
        if (!isSafePath(np)) throw new EditFault('unsafe', np);
        if (tree.current(np) !== null) throw new EditFault('exists', np);
        const plus: string[] = [];
        let noEol = false;
        for (const h of hunks) {
          let hasPlus = false;
          for (const l of h.n) {
            if (!l.context) {
              plus.push(l.text);
              hasPlus = true;
            }
          }
          if (hasPlus) noEol = h.noEolPlus;
        }
        tree.pending.set(np, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      },
    };
  }
  if (kind === 'delete') {
    const op = oldRaw!;
    return {
      paths: [op],
      run(tree) {
        if (!isSafePath(op)) throw new EditFault('unsafe', op);
        if (tree.current(op) === null) throw new EditFault('missing', op);
        tree.pending.set(op, null);
      },
    };
  }
  if (kind === 'move') {
    const op = oldRaw!;
    const np = newRaw!;
    return {
      paths: [op, np],
      run(tree, strict) {
        if (!isSafePath(op)) throw new EditFault('unsafe', op);
        if (!isSafePath(np)) throw new EditFault('unsafe', np);
        const cur = tree.current(op);
        if (cur === null) throw new EditFault('missing', op);
        if (tree.current(np) !== null) throw new EditFault('exists', np);
        const out = applyHunks(cur, hunks, strict, op);
        tree.pending.set(np, out);
        tree.pending.set(op, null);
        tree.moves.push({ old: op, nw: np });
      },
    };
  }
  const p = oldRaw!;
  return {
    paths: [p],
    run(tree, strict) {
      if (!isSafePath(p)) throw new EditFault('unsafe', p);
      const cur = tree.current(p);
      if (cur === null) throw new EditFault('missing', p);
      tree.pending.set(p, applyHunks(cur, hunks, strict, p));
    },
  };
}

// ---- SEARCH/REPLACE blocks (SPEC section 7) ----

interface SearchBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

/** All edits of a SEARCH/REPLACE patch. */
function parseSearchReplace(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchAt = i;
    let path: string | null = null;
    for (let k = searchAt - 1; k >= prevEnd; k--) {
      const l = lines[k]!;
      if (isBlank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new ParseFault(`error: parse ${searchAt + 1}`);
    let eq = -1;
    for (let j = searchAt + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
    }
    if (eq < 0) throw new ParseFault(`error: parse ${searchAt + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
    }
    if (rep < 0) throw new ParseFault(`error: parse ${searchAt + 1}`);
    const block: SearchBlock = {
      path,
      oldLines: lines.slice(searchAt + 1, eq),
      newLines: lines.slice(eq + 1, rep),
    };
    edits.push(searchReplaceEdit(block));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

function searchReplaceEdit(block: SearchBlock): Edit {
  const { path, oldLines, newLines } = block;
  return {
    paths: [path],
    run(tree, strict) {
      if (!isSafePath(path)) throw new EditFault('unsafe', path);
      if (oldLines.length === 0) {
        if (tree.current(path) !== null) throw new EditFault('exists', path);
        tree.pending.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const cur = tree.current(path);
      if (cur === null) throw new EditFault('missing', path);
      const doc = parseDoc(cur);
      const tier = firstTier(doc.lines, oldLines, strict);
      if (tier < 0) throw new EditFault('no-match', path);
      const occ = occurrences(doc.lines, oldLines, tier);
      if (occ.length !== 1) throw new EditFault('ambiguous', path);
      const at = occ[0]!;
      const o: PatchLine[] = oldLines.map((t) => ({ text: t, context: false }));
      const n: PatchLine[] = newLines.map((t) => ({ text: t, context: false }));
      const repl = replacementLines(doc.lines, o, n, at, tier);
      doc.lines.splice(at, oldLines.length, ...repl);
      tree.pending.set(path, renderDoc(doc));
    },
  };
}

// ---- V4A patches (SPEC section 8) ----

interface V4aChunk {
  anchor: string | null;
  o: PatchLine[];
  n: PatchLine[];
  eof: boolean;
}

type V4aSection =
  | { kind: 'add'; path: string; lines: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo: string | null; chunks: V4aChunk[] };

const V4A_SECTION = /^\*\*\* (Add File|Delete File|Update File): /;

function v4aSectionStart(line: string): string | null {
  const m = V4A_SECTION.exec(line);
  return m === null ? null : m[1]!;
}

/** One V4A section's raw lines (with their 0-based indexes), up to the next section or
 *  `*** End Patch`; trailing blank lines are not part of it. */
function v4aSectionLines(lines: string[], i: number, last: number): { cells: { text: string; idx: number }[]; next: number } {
  const cells: { text: string; idx: number }[] = [];
  let j = i;
  while (j < last) {
    const l = lines[j]!;
    if (v4aSectionStart(l) !== null) break;
    if (l.trim() === '*** End Patch') break;
    cells.push({ text: l, idx: j });
    j++;
  }
  while (cells.length > 0 && isBlank(cells[cells.length - 1]!.text)) cells.pop();
  return { cells, next: j };
}

function parseV4aUpdate(lines: string[], i: number, last: number, path: string, updateLine: number): { section: V4aSection; next: number } {
  const { cells, next } = v4aSectionLines(lines, i, last);
  let moveTo: string | null = null;
  let at = 0;
  if (cells.length > 0 && cells[0]!.text.startsWith('*** Move to: ')) {
    moveTo = cells[0]!.text.slice('*** Move to: '.length).trim();
    at = 1;
  }
  const chunks: V4aChunk[] = [];
  let current: V4aChunk | null = null;
  let started = false;
  const openFirst = (): V4aChunk => {
    const c: V4aChunk = { anchor: null, o: [], n: [], eof: false };
    chunks.push(c);
    started = true;
    return c;
  };
  for (; at < cells.length; at++) {
    const { text, idx } = cells[at]!;
    if (text.startsWith('@@')) {
      const anchor = text.slice(2).trim();
      current = { anchor: anchor === '' ? null : anchor, o: [], n: [], eof: false };
      chunks.push(current);
      started = true;
      continue;
    }
    if (text.trim() === '*** End of File') {
      if (current === null) throw new ParseFault(`error: parse ${idx + 1}`);
      current.eof = true;
      current = null;
      continue;
    }
    if (text.startsWith(' ') || text === '' || text.startsWith('-') || text.startsWith('+')) {
      if (current === null) {
        if (started) throw new ParseFault(`error: parse ${idx + 1}`);
        current = openFirst();
      }
      if (text.startsWith(' ')) {
        current.o.push({ text: text.slice(1), context: true });
        current.n.push({ text: text.slice(1), context: true });
      } else if (text === '') {
        current.o.push({ text: '', context: true });
        current.n.push({ text: '', context: true });
      } else if (text.startsWith('-')) {
        current.o.push({ text: text.slice(1), context: false });
      } else {
        current.n.push({ text: text.slice(1), context: false });
      }
      continue;
    }
    throw new ParseFault(`error: parse ${idx + 1}`);
  }
  if (chunks.length === 0 && moveTo === null) throw new ParseFault(`error: parse ${updateLine + 1}`);
  return { section: { kind: 'update', path, moveTo, chunks }, next };
}

/** All edits of a V4A patch. */
function parseV4a(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new ParseFault(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!isBlank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new ParseFault(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (isBlank(lines[i]!)) {
      i++;
      continue;
    }
    const l = lines[i]!;
    const kind = v4aSectionStart(l);
    if (kind === null) throw new ParseFault(`error: parse ${i + 1}`);
    if (kind === 'Add File') {
      const path = l.slice('*** Add File: '.length).trim();
      const { cells, next } = v4aSectionLines(lines, i + 1, last);
      const fileLines: string[] = [];
      for (const { text, idx } of cells) {
        if (text === '') fileLines.push('');
        else if (text.startsWith('+')) fileLines.push(text.slice(1));
        else throw new ParseFault(`error: parse ${idx + 1}`);
      }
      edits.push(v4aEdit({ kind: 'add', path, lines: fileLines }));
      i = next;
    } else if (kind === 'Delete File') {
      const path = l.slice('*** Delete File: '.length).trim();
      const { cells, next } = v4aSectionLines(lines, i + 1, last);
      if (cells.length > 0) throw new ParseFault(`error: parse ${cells[0]!.idx + 1}`);
      edits.push(v4aEdit({ kind: 'delete', path }));
      i = next;
    } else {
      const path = l.slice('*** Update File: '.length).trim();
      const parsed = parseV4aUpdate(lines, i + 1, last, path, i);
      edits.push(v4aEdit(parsed.section));
      i = parsed.next;
    }
  }
  return edits;
}

function v4aEdit(sec: V4aSection): Edit {
  if (sec.kind === 'add') {
    const { path, lines: fileLines } = sec;
    return {
      paths: [path],
      run(tree) {
        if (!isSafePath(path)) throw new EditFault('unsafe', path);
        if (tree.current(path) !== null) throw new EditFault('exists', path);
        tree.pending.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      },
    };
  }
  if (sec.kind === 'delete') {
    const { path } = sec;
    return {
      paths: [path],
      run(tree) {
        if (!isSafePath(path)) throw new EditFault('unsafe', path);
        if (tree.current(path) === null) throw new EditFault('missing', path);
        tree.pending.set(path, null);
      },
    };
  }
  const { path, moveTo, chunks } = sec;
  return {
    paths: moveTo === null ? [path] : [path, moveTo],
    run(tree, strict) {
      if (!isSafePath(path)) throw new EditFault('unsafe', path);
      if (moveTo !== null && !isSafePath(moveTo)) throw new EditFault('unsafe', moveTo);
      const cur = tree.current(path);
      if (cur === null) throw new EditFault('missing', path);
      if (moveTo !== null && tree.current(moveTo) !== null) throw new EditFault('exists', moveTo);
      const doc = parseDoc(cur);
      let cursor = 0;
      for (const chunk of chunks) {
        if (chunk.anchor !== null) {
          const tier = firstTier(doc.lines, [chunk.anchor], strict, cursor);
          if (tier < 0) throw new EditFault('no-match', path);
          cursor = occurrences(doc.lines, [chunk.anchor], tier, cursor)[0]! + 1;
        }
        if (chunk.o.length === 0) {
          const pos = chunk.eof ? doc.lines.length : cursor;
          const ins = chunk.n.map((l) => l.text);
          doc.lines.splice(pos, 0, ...ins);
          cursor = pos + ins.length;
          continue;
        }
        const oText = chunk.o.map((l) => l.text);
        const tier = firstTier(doc.lines, oText, strict, cursor);
        if (tier < 0) throw new EditFault('no-match', path);
        let occ = occurrences(doc.lines, oText, tier, cursor);
        if (chunk.eof) occ = occ.filter((p) => p + oText.length === doc.lines.length);
        if (occ.length === 0) throw new EditFault('no-match', path);
        const at = occ[0]!;
        const repl = replacementLines(doc.lines, chunk.o, chunk.n, at, tier);
        doc.lines.splice(at, oText.length, ...repl);
        cursor = at + repl.length;
      }
      const out = renderDoc(doc);
      if (moveTo === null) {
        tree.pending.set(path, out);
      } else {
        tree.pending.set(moveTo, out);
        tree.pending.set(path, null);
        tree.moves.push({ old: path, nw: moveTo });
      }
    },
  };
}

// ---- JSON edits (SPEC section 9) ----

/** One JSON edit object, or null when the value is not one. */
function jsonEditObject(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return {
      paths: [p],
      run(tree) {
        if (!isSafePath(p)) throw new EditFault('unsafe', p);
        if (tree.current(p) !== null) throw new EditFault('exists', p);
        tree.pending.set(p, text);
      },
    };
  }
  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return {
      paths: [p],
      run(tree) {
        if (!isSafePath(p)) throw new EditFault('unsafe', p);
        const before = tree.current(p);
        if (before === null) throw new EditFault('missing', p);
        const nl = before.indexOf('\n');
        const crlf = nl > 0 && before[nl - 1] === '\r';
        const plain = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
        const text = plain(before);
        const old = plain(oldStr);
        let count = 0;
        for (let k = text.indexOf(old); k >= 0; k = text.indexOf(old, k + 1)) count++;
        if (count === 0) throw new EditFault('no-match', p);
        if (count > 1) throw new EditFault('ambiguous', p);
        const at = text.indexOf(old);
        const out = text.slice(0, at) + plain(newStr) + text.slice(at + old.length);
        tree.pending.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
      },
    };
  }
  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const lineNo = o.insert_line;
    const add = splitPatch(o.new_str);
    return {
      paths: [p],
      run(tree) {
        if (!isSafePath(p)) throw new EditFault('unsafe', p);
        const before = tree.current(p);
        if (before === null) throw new EditFault('missing', p);
        const doc = parseDoc(before);
        if (lineNo < 0 || lineNo > doc.lines.length) throw new EditFault('no-match', p);
        doc.lines.splice(lineNo, 0, ...add);
        tree.pending.set(p, renderDoc(doc));
      },
    };
  }
  return null;
}

/** All edits of a JSON patch: one array, or one edit object per line. */
function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new ParseFault(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new ParseFault(`error: parse ${first + 1}`);
    for (const item of v) {
      const e = jsonEditObject(item);
      if (e === null) throw new ParseFault(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEditObject(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new ParseFault(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- Running a patch (SPEC sections 2 and 10) ----

/** The changed paths and their rows, with moves folded into `R` lines. */
function finish(tree: Tree, check: boolean): { code: number; out: string[] } {
  const changed = new Map<string, { was: string | null; now: string | null }>();
  for (const [p, now] of tree.pending) {
    const was = tree.before(p);
    if (was !== now) changed.set(p, { was, now });
  }
  const rows: { key: string; line: string }[] = [];
  const folded = new Set<string>();
  for (const m of tree.moves) {
    const o = changed.get(m.old);
    const n = changed.get(m.nw);
    if (o !== undefined && o.now === null && n !== undefined && n.was === null) {
      rows.push({ key: m.nw, line: `R ${m.old} -> ${m.nw}` });
      folded.add(m.old);
      folded.add(m.nw);
    }
  }
  for (const [p, c] of changed) {
    if (folded.has(p)) continue;
    const line = c.was === null ? `A ${p}` : c.now === null ? `D ${p}` : `M ${p}`;
    rows.push({ key: p, line });
  }
  rows.sort((a, b) => byteOrder(a.key, b.key));
  if (!check) {
    for (const [p, c] of changed) {
      if (c.now === null) {
        rmSync(p, { force: true });
      } else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, c.now);
      }
    }
  }
  const n = rows.length;
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${n} ${n === 1 ? 'file' : 'files'}`] };
}

function run(argv: string[]): { code: number; out: string[] } {
  let opts: Options;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    if (e instanceof ParseFault) return { code: 2, out: [e.line] };
    throw e;
  }
  let text = '';
  try {
    text = readFileSync(opts.patch ?? 0, 'utf8');
  } catch {
    if (opts.patch !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatch(text);
  const kind = opts.format === 'auto' ? detectFormat(lines) : opts.format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'unified'
        ? parseUnified(lines)
        : kind === 'search-replace'
          ? parseSearchReplace(lines)
          : kind === 'v4a'
            ? parseV4a(lines)
            : parseJson(text, lines);
    if (edits.length === 0) throw new ParseFault('error: parse 1');
  } catch (e) {
    if (e instanceof ParseFault) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: EditFault[] = [];
  for (const edit of edits) {
    const snapshot = new Map(tree.pending);
    try {
      edit.run(tree, opts.strict);
    } catch (e) {
      if (!(e instanceof EditFault)) throw e;
      tree.pending.clear();
      for (const [k, v] of snapshot) tree.pending.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }
  return finish(tree, opts.check);
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each
  // one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const result = run(process.argv.slice(2));
  writeSync(1, result.out.map((l) => `${l}\n`).join(''));
  process.exitCode = result.code;
}
