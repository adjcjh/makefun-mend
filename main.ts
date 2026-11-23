// mend: apply an AI-written edit to a tree of text files.
//
// Reads one patch in one of four formats (unified diff, SEARCH/REPLACE
// blocks, V4A, JSON tool-call edits), finds each edit's old lines at the
// first of three fuzzy-matching tiers, and writes every change or none.
// Run as: node main.ts [--format=NAME] [--check] [--strict] [PATCH]
// See SPEC.md for the full contract. Node 22+, standard library only.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and this file hands over to runner.ts (the last lines below): keep them.

import { mkdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** Thrown to report an exit-2 outcome; carries the exact stdout line. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** Thrown by an edit that fails; carries the SPEC.md failure code and path. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** Split patch text into lines: split at \n, one trailing \r removed, and no
 *  empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safePath(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

const byteCmp = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

/* ------------------------------------------------------------------ */
/* Files as line documents                                             */
/* ------------------------------------------------------------------ */

interface Doc {
  br: string;
  lines: string[];
  ends: boolean;
}

/** Parse file text into its line break, its lines, and whether it ends
 *  with a line break. An empty file has no lines. */
function parseDoc(text: string): Doc {
  if (text === '') return { br: '\n', lines: [], ends: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const ends = text.endsWith(br);
  if (ends) parts.pop();
  return { br, lines: parts, ends };
}

function writeDoc(doc: Doc): string {
  if (doc.lines.length === 0) return '';
  return doc.lines.join(doc.br) + (doc.ends ? doc.br : '');
}

/** A fresh file's document: LF breaks, ends with a break when non-empty. */
function freshDoc(lines: string[], ends: boolean): string {
  return writeDoc({ br: '\n', lines, ends });
}

/* ------------------------------------------------------------------ */
/* The tree edits work on                                              */
/* ------------------------------------------------------------------ */

class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, in patch order, for the R output lines. */
  readonly moves: [string, string][] = [];

  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/* ------------------------------------------------------------------ */
/* Line matching (SPEC.md section 5)                                   */
/* ------------------------------------------------------------------ */

const rstrip = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWs = (s: string): string => /^[ \t]*/.exec(s)?.[0] ?? '';

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rstrip(a) === rstrip(b);
  return trimWs(a) === trimWs(b);
}

/** All 0-based positions at or after `from` where `pat` matches `lines`. */
function occurrences(lines: string[], pat: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (pat.length === 0) return out;
  for (let i = from; i + pat.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < pat.length; j += 1) {
      if (!lineEq(lines[i + j]!, pat[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface Found {
  tier: number;
  occ: number[];
}

/** First tier (0, then 1, then 2; only 0 when strict) with an occurrence. */
function findTier(lines: string[], pat: string[], from: number, strict: boolean): Found | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, pat, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of a replacement: a context line (written as the file's own
 *  matched line, `ctx` is its index inside the old lines) or a fresh line. */
interface NewLine {
  text: string;
  ctx: number | null;
}

/** Render replacement lines. At tier 2 every non-context, non-blank line
 *  starting with the old lines' first leading whitespace has that prefix
 *  replaced by the file's first matched line's leading whitespace. */
function renderNew(n: NewLine[], fileLines: string[], pos: number, tier: number, old: string[]): string[] {
  const p = old.length > 0 ? leadingWs(old[0]!) : '';
  const f = old.length > 0 ? leadingWs(fileLines[pos]!) : '';
  return n.map((e) => {
    if (e.ctx !== null) return fileLines[pos + e.ctx]!;
    if (tier !== 2) return e.text;
    if (e.text === '' || trimWs(e.text) === '') return e.text;
    if (e.text.startsWith(p)) return f + e.text.slice(p.length);
    return e.text;
  });
}

/* ------------------------------------------------------------------ */
/* Format detection (section 4)                                        */
/* ------------------------------------------------------------------ */

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ------------------------------------------------------------------ */
/* JSON edits (section 9)                                              */
/* ------------------------------------------------------------------ */

function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const needFile = (tree: Tree): string => {
    if (!safePath(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safePath(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = needFile(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + toLf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const lineNo = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = needFile(tree);
      const doc = parseDoc(before);
      if (lineNo < 0 || lineNo > doc.lines.length) throw new Fail('no-match', p);
      const lines = [...doc.lines];
      lines.splice(lineNo, 0, ...add);
      tree.now.set(p, writeDoc({ br: doc.br, lines, ends: doc.ends }));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Shared hunk/chunk old-and-new extraction                            */
/* ------------------------------------------------------------------ */

interface BodyLine {
  kind: 'ctx' | 'old' | 'add' | 'mark';
  text: string;
  /** True when this line was a bare empty patch line (not a ' ' line). */
  bare: boolean;
}

/** Old lines, new lines and the no-newline flag of a hunk body. The flag is
 *  set when a `\` line follows the body's last context or `+` line. */
function bodyOldNew(body: BodyLine[]): { old: string[]; n: NewLine[]; noNL: boolean } {
  const old: string[] = [];
  const n: NewLine[] = [];
  let lastCtxAdd = -1;
  body.forEach((el, idx) => {
    if (el.kind === 'ctx' || el.kind === 'add') lastCtxAdd = idx;
  });
  const noNL = lastCtxAdd >= 0 && body[lastCtxAdd + 1]?.kind === 'mark';
  for (const el of body) {
    if (el.kind === 'ctx') {
      const k = old.length;
      old.push(el.text);
      n.push({ text: el.text, ctx: k });
    } else if (el.kind === 'old') {
      old.push(el.text);
    } else if (el.kind === 'add') {
      n.push({ text: el.text, ctx: null });
    }
  }
  return { old, n, noNL };
}

/** Whether the body's last `+` line (if any) is followed by a `\` line. */
function lastAddNoNL(body: BodyLine[]): boolean {
  let lastAdd = -1;
  body.forEach((el, idx) => {
    if (el.kind === 'add') lastAdd = idx;
  });
  return lastAdd >= 0 && body[lastAdd + 1]?.kind === 'mark';
}

/* ------------------------------------------------------------------ */
/* Unified diffs (section 6)                                           */
/* ------------------------------------------------------------------ */

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface UniSection {
  diffOld: string | null;
  diffNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  pairSet: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

/** The path after `--- ` / `+++ `: up to the first tab, spaces trimmed,
 *  a leading a/ or b/ removed; /dev/null means no file. */
function uniPath(line: string): string | null {
  let p = line.slice(4).split('\t')[0]!.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  if (p === '/dev/null') return null;
  return p;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const diffRe = /^diff --git a\/(\S+) b\/(\S+)\s*$/;
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = diffRe.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = { diffOld: m[1]!, diffNew: m[2]!, pairOld: null, pairNew: null, pairSet: false, renameFrom: null, renameTo: null, isCreate: false, isDelete: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ')) {
      const nextIsPlus = (lines[i + 1] ?? '').startsWith('+++ ');
      if (nextIsPlus) {
        if (cur !== null && inHeader && !cur.pairSet) {
          cur.pairOld = uniPath(line);
          cur.pairNew = uniPath(lines[i + 1]!);
          cur.pairSet = true;
          i += 2;
          continue;
        }
        cur = { diffOld: null, diffNew: null, pairOld: uniPath(line), pairNew: uniPath(lines[i + 1]!), pairSet: true, renameFrom: null, renameTo: null, isCreate: false, isDelete: false, hunks: [] };
        sections.push(cur);
        inHeader = true;
        i += 2;
        continue;
      }
      if (cur !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = hunkRe.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const body: BodyLine[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j]!;
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (l.startsWith('@@')) break;
        if (l === '') {
          body.push({ kind: 'ctx', text: '', bare: true });
          j += 1;
          continue;
        }
        if (l[0] === ' ') {
          body.push({ kind: 'ctx', text: l.slice(1), bare: false });
          j += 1;
          continue;
        }
        if (l[0] === '-') {
          body.push({ kind: 'old', text: l.slice(1), bare: false });
          j += 1;
          continue;
        }
        if (l[0] === '+') {
          body.push({ kind: 'add', text: l.slice(1), bare: false });
          j += 1;
          continue;
        }
        if (l[0] === '\\') {
          body.push({ kind: 'mark', text: l, bare: false });
          j += 1;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1]!.bare) body.pop();
      cur.hunks.push({ a: Number(m[1]), body });
      inHeader = false;
      i = j;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.isCreate = true;
      else if (line.startsWith('deleted file mode')) cur.isDelete = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections.map((s) => uniEdit(s, strict));
}

function uniEdit(s: UniSection, strict: boolean): Edit {
  return (tree) => {
    const oldP = s.pairSet ? s.pairOld : (s.renameFrom ?? s.diffOld);
    const newP = s.pairSet ? s.pairNew : (s.renameTo ?? s.diffNew);
    const isCreate = oldP === null || s.isCreate;
    const isDelete = !isCreate && (newP === null || s.isDelete);
    if (isCreate) {
      const path = newP ?? '';
      if (!safePath(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      const made: string[] = [];
      let ends = true;
      let seenAdd = false;
      for (const h of s.hunks) {
        for (const el of h.body) if (el.kind === 'add') made.push(el.text);
        if (h.body.some((el) => el.kind === 'add')) {
          seenAdd = true;
          ends = !lastAddNoNL(h.body);
        }
      }
      if (!seenAdd) ends = true;
      tree.now.set(path, freshDoc(made, made.length > 0 && ends));
      return;
    }
    if (isDelete) {
      const path = oldP ?? '';
      if (!safePath(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
      return;
    }
    const path = oldP ?? '';
    if (!safePath(path)) throw new Fail('unsafe', path);
    const isMove = newP !== null && newP !== path;
    if (isMove && !safePath(newP!)) throw new Fail('unsafe', newP!);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (isMove && tree.get(newP!) !== null) throw new Fail('exists', newP!);
    const doc = parseDoc(before);
    let lines = [...doc.lines];
    let ends = doc.ends;
    let d = 0;
    for (const h of s.hunks) {
      const { old, n, noNL } = bodyOldNew(h.body);
      if (old.length === 0) {
        const pos = Math.min(Math.max(h.a + d, 0), lines.length);
        const atEnd = pos === lines.length;
        lines.splice(pos, 0, ...n.map((e) => e.text));
        if (atEnd) ends = !noNL;
        d += n.length;
      } else {
        const found = findTier(lines, old, 0, strict);
        if (found === null) throw new Fail('no-match', path);
        const target = h.a - 1 + d;
        let best = found.occ[0]!;
        let bestDist = Math.abs(best - target);
        for (const p of found.occ) {
          const dist = Math.abs(p - target);
          if (dist < bestDist) {
            best = p;
            bestDist = dist;
          }
        }
        const rendered = renderNew(n, lines, best, found.tier, old);
        const atEnd = best + old.length === lines.length;
        lines.splice(best, old.length, ...rendered);
        if (atEnd) ends = !noNL;
        d += n.length - old.length;
      }
    }
    const out = writeDoc({ br: doc.br, lines, ends });
    if (isMove) {
      tree.now.set(path, null);
      tree.now.set(newP!, out);
      tree.moves.push([path, newP!]);
    } else {
      tree.now.set(path, out);
    }
  };
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (section 7)                                   */
/* ------------------------------------------------------------------ */

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safePath(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, freshDoc(newLines, newLines.length > 0));
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const doc = parseDoc(before);
    const found = findTier(doc.lines, oldLines, 0, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const rendered = renderNew(newLines.map((t) => ({ text: t, ctx: null })), doc.lines, pos, found.tier, oldLines);
    const lines = [...doc.lines];
    lines.splice(pos, oldLines.length, ...rendered);
    tree.now.set(path, writeDoc({ br: doc.br, lines, ends: doc.ends }));
  };
}

function parseSR(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevReplace; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    prevPath = path;
    prevReplace = rep;
    edits.push(srEdit(path, lines.slice(searchIdx + 1, eq), lines.slice(eq + 1, rep), strict));
    i = rep + 1;
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* V4A patches (section 8)                                             */
/* ------------------------------------------------------------------ */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

function v4aEdit(kind: 'add' | 'delete' | 'update', path: string, moveTo: string | null, fileLines: string[], chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safePath(path)) throw new Fail('unsafe', path);
    if (kind === 'add') {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, freshDoc(fileLines, fileLines.length > 0));
      return;
    }
    if (kind === 'delete') {
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
      return;
    }
    if (moveTo !== null && !safePath(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const doc = parseDoc(before);
    const lines = [...doc.lines];
    const tiers = strict ? [0] : [0, 1, 2];
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let foundIdx = -1;
        for (const t of tiers) {
          for (let k = cursor; k < lines.length; k += 1) {
            if (lineEq(lines[k]!, ch.anchor, t)) {
              foundIdx = k;
              break;
            }
          }
          if (foundIdx >= 0) break;
        }
        if (foundIdx < 0) throw new Fail('no-match', path);
        cursor = foundIdx + 1;
      }
      const { old, n } = bodyOldNew(ch.body);
      if (old.length === 0) {
        const pos = ch.eof ? lines.length : cursor;
        const ins = n.map((e) => e.text);
        lines.splice(pos, 0, ...ins);
        cursor = pos + ins.length;
      } else {
        const found = findTier(lines, old, cursor, strict);
        if (found === null) throw new Fail('no-match', path);
        let occ = found.occ;
        if (ch.eof) occ = occ.filter((p) => p + old.length === lines.length);
        if (occ.length === 0) throw new Fail('no-match', path);
        const pos = occ[0]!;
        const rendered = renderNew(n, lines, pos, found.tier, old);
        lines.splice(pos, old.length, ...rendered);
        cursor = pos + rendered.length;
      }
    }
    const out = writeDoc({ br: doc.br, lines, ends: doc.ends });
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function parseV4A(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  interface Raw {
    text: string;
    num: number;
  }
  interface Section {
    kind: 'add' | 'delete' | 'update';
    path: string;
    line: number;
    raw: Raw[];
  }
  const sections: Section[] = [];
  let cur: Section | null = null;
  const startSection = (idx: number): void => {
    const line = lines[idx]!;
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice(14).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice(17).trim();
    } else {
      kind = 'update';
      path = line.slice(17).trim();
    }
    cur = { kind, path, line: idx + 1, raw: [] };
    sections.push(cur);
  };
  for (let idx = first + 1; idx < last; idx += 1) {
    const line = lines[idx]!;
    if (line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ')) {
      startSection(idx);
      continue;
    }
    if (cur === null) {
      if (blank(line)) continue;
      throw new Exit2(`error: parse ${idx + 1}`);
    }
    cur.raw.push({ text: line, num: idx + 1 });
  }
  const edits: Edit[] = [];
  for (const s of sections) {
    while (s.raw.length > 0 && blank(s.raw[s.raw.length - 1]!.text)) s.raw.pop();
    if (s.kind === 'add') {
      const made: string[] = [];
      for (const r of s.raw) {
        if (r.text.startsWith('+')) made.push(r.text.slice(1));
        else if (r.text === '') made.push('');
        else throw new Exit2(`error: parse ${r.num}`);
      }
      edits.push(v4aEdit('add', s.path, null, made, [], strict));
    } else if (s.kind === 'delete') {
      for (const r of s.raw) {
        if (!blank(r.text)) throw new Exit2(`error: parse ${r.num}`);
      }
      edits.push(v4aEdit('delete', s.path, null, [], [], strict));
    } else {
      let moveTo: string | null = null;
      const chunks: VChunk[] = [];
      let chunk: VChunk | null = null;
      for (const r of s.raw) {
        const t = r.text;
        if (t.startsWith('*** Move to: ')) {
          if (moveTo !== null || chunks.length > 0) throw new Exit2(`error: parse ${r.num}`);
          moveTo = t.slice(13).trim();
          continue;
        }
        if (t.startsWith('@@')) {
          const anchor = t.slice(2).trim();
          chunk = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
          chunks.push(chunk);
          continue;
        }
        if (t === '*** End of File') {
          if (chunk === null) throw new Exit2(`error: parse ${r.num}`);
          chunk.eof = true;
          chunk = null;
          continue;
        }
        if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
          if (chunk === null) {
            chunk = { anchor: null, eof: false, body: [] };
            chunks.push(chunk);
          }
          if (t === '') chunk.body.push({ kind: 'ctx', text: '', bare: true });
          else if (t[0] === ' ') chunk.body.push({ kind: 'ctx', text: t.slice(1), bare: false });
          else if (t[0] === '-') chunk.body.push({ kind: 'old', text: t.slice(1), bare: false });
          else chunk.body.push({ kind: 'add', text: t.slice(1), bare: false });
          continue;
        }
        throw new Exit2(`error: parse ${r.num}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${s.line}`);
      edits.push(v4aEdit('update', s.path, moveTo, [], chunks, strict));
    }
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* Driver (sections 1, 2, 10)                                          */
/* ------------------------------------------------------------------ */

function run(args: string[]): { code: number; out: string[] } {
  const usage = (): { code: number; out: string[] } => ({ code: 2, out: ['error: usage'] });
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        const v = a.slice(9);
        if (format !== null || !FORMATS.includes(v)) return usage();
        format = v;
      } else if (a === '--check') {
        if (check) return usage();
        check = true;
      } else if (a === '--strict') {
        if (strict) return usage();
        strict = true;
      } else {
        return usage();
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return usage();
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSR(lines, strict);
    else edits = parseV4A(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const snapNow = new Map(tree.now);
    const snapMoves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of snapNow) tree.now.set(k, v);
      tree.moves.length = 0;
      tree.moves.push(...snapMoves);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  interface Row {
    key: string;
    text: string;
  }
  const rows: Row[] = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: was === null ? `A ${p}` : now === null ? `D ${p}` : `M ${p}` });
  }
  for (const [o, n] of tree.moves) {
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(n) === null && tree.get(n) !== null) {
      const di = rows.findIndex((r) => r.text === `D ${o}`);
      if (di >= 0) rows.splice(di, 1);
      const ai = rows.findIndex((r) => r.text === `A ${n}`);
      if (ai >= 0) rows.splice(ai, 1);
      rows.push({ key: n, text: `R ${o} -> ${n}` });
    }
  }
  rows.sort((a, b) => byteCmp(a.key, b.key));
  if (!check) {
    const changed = [...tree.now.keys()].filter((p) => tree.original(p) !== tree.now.get(p)).sort(byteCmp);
    for (const p of changed) {
      if (tree.now.get(p) === null) rmSync(p, { force: true });
    }
    for (const p of [...changed].reverse()) {
      let d = dirname(p);
      while (d !== '.' && d !== '') {
        try {
          rmdirSync(d);
        } catch {
          break;
        }
        d = dirname(d);
      }
    }
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now !== null) {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
