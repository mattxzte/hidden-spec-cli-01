// mend — one patch tool for every AI edit format.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A, JSON edits), applies its edits to the tree rooted at the working
// directory, and writes every change or none at all.
//
//   node main.ts [--format=NAME] [--check] [--strict] [PATCH]
//
// PATCH names the patch file; when it is absent or "-", the patch comes from
// standard input. --check reports what would change without writing anything.
// --strict matches lines exactly (tier 0 only).
//
// When MAKEFUN_ENV_URL is set, this program instead acts as the trial
// runner: it fetches the trial's checks from the environment, runs this same
// file on each one in a fresh directory, and posts the outcomes back.
//
// Only the Node standard library is used. The tool is deterministic: it
// never reads the clock and never draws unseeded randomness.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Small text model
// ---------------------------------------------------------------------------

interface TextFile {
  lines: string[];
  br: string;
  eol: boolean;
}

// Split a file's text into lines under its own line break. The break is
// CRLF when the first line feed follows a carriage return, otherwise LF.
// A trailing break does not create an extra line; an empty file has none.
function parseText(text: string): TextFile {
  if (text === "") return { lines: [], br: "\n", eol: false };
  let br = "\n";
  const firstLf = text.indexOf("\n");
  if (firstLf > 0 && text[firstLf - 1] === "\r") br = "\r\n";
  const parts = text.split(br);
  const eol = text.endsWith(br);
  if (eol) parts.pop();
  return { lines: parts, br, eol };
}

// Join a file's lines back with its own break. A file with no lines is
// written empty, whatever its break flag says.
function renderText(file: TextFile): string {
  if (file.lines.length === 0) return "";
  let out = file.lines.join(file.br);
  if (file.eol) out += file.br;
  return out;
}

// Split a patch's text into numbered lines: split at \n, strip one trailing
// \r from each, and drop the empty piece after a final \n.
function patchLines(text: string): string[] {
  if (text === "") return [];
  const parts = text.split("\n");
  if (text.endsWith("\n")) parts.pop();
  return parts.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

// A path is safe when it is not empty, does not start with /, holds no \,
// and none of its segments is empty, . or ..
function isSafePath(p: string): boolean {
  if (p === "") return false;
  if (p.startsWith("/")) return false;
  if (p.includes("\\")) return false;
  for (const seg of p.split("/")) {
    if (seg === "" || seg === "." || seg === "..") return false;
  }
  return true;
}

function leadingWs(line: string): string {
  const m = /^[ \t]*/.exec(line);
  return m ? m[0] : "";
}

function stripTrailing(line: string): string {
  return line.replace(/[ \t]+$/, "");
}

function stripBoth(line: string): string {
  return line.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
}

// The key a line is compared by at a matching tier.
function lineKey(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return stripTrailing(line);
  return stripBoth(line);
}

// ---------------------------------------------------------------------------
// The working tree (in-memory; written to disk only on success)
// ---------------------------------------------------------------------------

class Tree {
  private beforeMap = new Map<string, string | null>();
  private currentMap = new Map<string, string | null>();

  // Current text of a path, or null when it does not exist. The first read
  // also records the before-state, which never changes afterwards.
  get(p: string): string | null {
    if (this.currentMap.has(p)) return this.currentMap.get(p) as string | null;
    let text: string | null = null;
    try {
      text = fs.readFileSync(p, "utf8");
    } catch {
      text = null;
    }
    this.beforeMap.set(p, text);
    this.currentMap.set(p, text);
    return text;
  }

  has(p: string): boolean {
    return this.get(p) !== null;
  }

  set(p: string, text: string | null): void {
    if (!this.beforeMap.has(p)) this.get(p);
    this.currentMap.set(p, text);
  }

  touched(): string[] {
    return [...this.currentMap.keys()];
  }

  beforeOf(p: string): string | null {
    return this.beforeMap.has(p) ? (this.beforeMap.get(p) as string | null) : null;
  }

  afterOf(p: string): string | null {
    return this.currentMap.has(p) ? (this.currentMap.get(p) as string | null) : null;
  }
}

// ---------------------------------------------------------------------------
// Matching lines at tiers
// ---------------------------------------------------------------------------

// Every position where oldLines occur in lines at one tier, searching from
// `from` onwards. Occurrences may overlap.
function occurrencesAt(lines: string[], oldLines: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  const k = oldLines.length;
  if (k === 0) return out;
  const keys = oldLines.map((l) => lineKey(l, tier));
  for (let i = from; i + k <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < k; j++) {
      if (lineKey(lines[i + j], tier) !== keys[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

// The first tier (0, then 1, then 2; 0 only when strict) at which oldLines
// occur at least once, with every such position.
function firstTierWith(
  lines: string[],
  oldLines: string[],
  strict: boolean,
  from: number,
): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrencesAt(lines, oldLines, t, from);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Body operations (unified hunks and V4A chunks share this shape)
// ---------------------------------------------------------------------------

interface BodyOp {
  kind: "ctx" | "del" | "add";
  text: string;
  bang: boolean;
}

// Turn hunk/chunk body lines into operations. A \ line marks the operation
// before it; an empty line is a context line with empty text.
function parseBodyOps(body: string[]): BodyOp[] {
  const ops: BodyOp[] = [];
  for (const line of body) {
    if (line.startsWith("\\")) {
      if (ops.length > 0) ops[ops.length - 1].bang = true;
      continue;
    }
    if (line === "") {
      ops.push({ kind: "ctx", text: "", bang: false });
    } else if (line[0] === " ") {
      ops.push({ kind: "ctx", text: line.slice(1), bang: false });
    } else if (line[0] === "-") {
      ops.push({ kind: "del", text: line.slice(1), bang: false });
    } else if (line[0] === "+") {
      ops.push({ kind: "add", text: line.slice(1), bang: false });
    }
  }
  return ops;
}

// Build the replacement lines for a matched block. Context lines are written
// as the file's own matched lines; other lines are re-indented at tier 2.
function buildNewLines(
  ops: BodyOp[],
  fileLines: string[],
  matchPos: number,
  oldLines: string[],
  tier: number,
): string[] {
  const out: string[] = [];
  const f = matchPos < fileLines.length ? leadingWs(fileLines[matchPos]) : "";
  const p = oldLines.length > 0 ? leadingWs(oldLines[0]) : "";
  let oIdx = 0;
  for (const op of ops) {
    if (op.kind === "del") {
      oIdx++;
      continue;
    }
    if (op.kind === "ctx") {
      out.push(fileLines[matchPos + oIdx]);
      oIdx++;
      continue;
    }
    let text = op.text;
    if (tier === 2 && text !== "" && text.trim() !== "" && text.startsWith(p)) {
      text = f + text.slice(p.length);
    }
    out.push(text);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

interface EditFailure {
  code: string;
  path: string;
}

interface Edit {
  // Every path the edit names, in order; each is checked for safety first.
  paths: string[];
  // Set for a successful move edit, so its listing can use R.
  move?: { oldPath: string; newPath: string };
  apply: (tree: Tree, strict: boolean) => EditFailure | null;
}

class ParseError extends Error {
  line: number;
  constructor(line: number) {
    super("parse " + line);
    this.line = line;
  }
}

// ---------------------------------------------------------------------------
// Unified diffs
// ---------------------------------------------------------------------------

interface UnifiedHunk {
  oldStart: number;
  body: string[];
}

interface UnifiedSection {
  oldPath: string | null; // null means /dev/null, no file
  newPath: string | null;
  newFileMode: boolean;
  deletedFileMode: boolean;
  hunks: UnifiedHunk[];
}

// The path after the four characters of a --- or +++ line, up to the first
// tab, trimmed; /dev/null means no file; a leading a/ or b/ is removed.
function headerPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf("\t");
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === "/dev/null") return null;
  if (p.startsWith("a/")) p = p.slice(2);
  else if (p.startsWith("b/")) p = p.slice(2);
  return p;
}

function parseUnified(lines: string[]): Edit[] {
  const sections: UnifiedSection[] = [];
  let current: UnifiedSection | null = null;
  let pairNamed = false;
  const diffGitRe = /^diff --git a\/(\S+) b\/(\S+)$/;
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (line.startsWith("diff --git ")) {
      const m = diffGitRe.exec(line);
      if (!m) throw new ParseError(i + 1);
      current = { oldPath: m[1], newPath: m[2], newFileMode: false, deletedFileMode: false, hunks: [] };
      sections.push(current);
      pairNamed = false;
      i++;
      continue;
    }
    if (line.startsWith("--- ")) {
      if (i + 1 < n && lines[i + 1].startsWith("+++ ")) {
        if (current !== null && !pairNamed && current.hunks.length === 0) {
          current.oldPath = headerPath(line);
          current.newPath = headerPath(lines[i + 1]);
          pairNamed = true;
        } else {
          const sec: UnifiedSection = {
            oldPath: headerPath(line),
            newPath: headerPath(lines[i + 1]),
            newFileMode: false,
            deletedFileMode: false,
            hunks: [],
          };
          sections.push(sec);
          current = sec;
          pairNamed = true;
        }
        i += 2;
        continue;
      }
      // A --- line not followed by +++ inside a section's header.
      if (current !== null && current.hunks.length === 0) {
        throw new ParseError(i + 2 <= n ? i + 2 : n + 1);
      }
      i++;
      continue;
    }
    if (line.startsWith("@@")) {
      const m = hunkRe.exec(line);
      if (!m) throw new ParseError(i + 1);
      if (current === null) throw new ParseError(i + 1);
      const oldStart = parseInt(m[1], 10);
      const body: string[] = [];
      let j = i + 1;
      while (j < n) {
        const bl = lines[j];
        if (bl.startsWith("diff --git ")) break;
        if (bl.startsWith("--- ") && j + 1 < n && lines[j + 1].startsWith("+++ ")) break;
        if (bl === "" || bl.startsWith(" ") || bl.startsWith("-") || bl.startsWith("+") || bl.startsWith("\\")) {
          body.push(bl);
          j++;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1] === "") body.pop();
      current.hunks.push({ oldStart, body });
      i = j;
      continue;
    }
    if (current !== null && current.hunks.length === 0) {
      if (line.startsWith("rename from ")) {
        if (!pairNamed) current.oldPath = line.slice("rename from ".length).trim();
      } else if (line.startsWith("rename to ")) {
        if (!pairNamed) current.newPath = line.slice("rename to ".length).trim();
      } else if (line.startsWith("new file mode")) {
        current.newFileMode = true;
      } else if (line.startsWith("deleted file mode")) {
        current.deletedFileMode = true;
      }
      i++;
      continue;
    }
    // Prose outside bodies and headers is ignored.
    i++;
  }
  if (sections.length === 0) throw new ParseError(1);
  return sections.map((s) => unifiedSectionEdit(s));
}

// The last operation of a body that writes a line (a context line or an
// addition), or undefined when the body writes no line at all.
function lastWrittenOp(ops: BodyOp[]): BodyOp | undefined {
  let found: BodyOp | undefined;
  for (const op of ops) {
    if (op.kind === "ctx" || op.kind === "add") found = op;
  }
  return found;
}

// Apply one section's hunks in order to a file's lines. Returns the new
// file, or the failure code of the first hunk that does not apply.
function applyHunks(
  file: TextFile,
  hunks: UnifiedHunk[],
  strict: boolean,
): { file: TextFile } | { fail: string } {
  let lines = file.lines.slice();
  let eol = file.eol;
  let d = 0;
  for (const hunk of hunks) {
    const ops = parseBodyOps(hunk.body);
    const oLines: string[] = [];
    for (const op of ops) {
      if (op.kind === "ctx" || op.kind === "del") oLines.push(op.text);
    }
    if (oLines.length > 0) {
      const found = firstTierWith(lines, oLines, strict, 0);
      if (!found) return { fail: "no-match" };
      const target = hunk.oldStart - 1 + d;
      let best = found.positions[0];
      let bestDist = Math.abs(best - target);
      for (const pos of found.positions) {
        const dist = Math.abs(pos - target);
        if (dist < bestDist) {
          best = pos;
          bestDist = dist;
        }
      }
      const pos = best;
      const nLines = buildNewLines(ops, lines, pos, oLines, found.tier);
      if (pos + oLines.length === lines.length) {
        const lastCtxAdd = lastWrittenOp(ops);
        eol = lastCtxAdd ? !lastCtxAdd.bang : true;
      }
      lines.splice(pos, oLines.length, ...nLines);
      d += nLines.length - oLines.length;
    } else {
      const nLines = ops.filter((o) => o.kind === "add").map((o) => o.text);
      let insertAt = hunk.oldStart + d;
      if (insertAt < 0) insertAt = 0;
      if (insertAt > lines.length) insertAt = lines.length;
      if (insertAt === lines.length && nLines.length > 0) {
        const lastAdd = lastWrittenOp(ops);
        eol = lastAdd ? !lastAdd.bang : true;
      }
      lines.splice(insertAt, 0, ...nLines);
      d += nLines.length;
    }
  }
  return { file: { lines, br: file.br, eol } };
}

function unifiedSectionEdit(s: UnifiedSection): Edit {
  const named: string[] = [];
  if (s.oldPath !== null) named.push(s.oldPath);
  if (s.newPath !== null && s.newPath !== s.oldPath) named.push(s.newPath);
  const isCreation = s.oldPath === null || s.newFileMode;
  const isDeletion = s.newPath === null || s.deletedFileMode;
  if (isCreation) {
    const newPath = s.newPath;
    return {
      // `named` always holds the new path when it is non-null: it is built
      // from this section's old and new paths just above.
      paths: newPath === null ? [""] : named,
      apply: (tree) => {
        if (newPath === null) return { code: "unsafe", path: "" };
        if (tree.has(newPath)) return { code: "exists", path: newPath };
        const plus: string[] = [];
        let lastPlusBang = false;
        let sawPlus = false;
        for (const hunk of s.hunks) {
          for (const op of parseBodyOps(hunk.body)) {
            if (op.kind === "add") {
              plus.push(op.text);
              lastPlusBang = op.bang;
              sawPlus = true;
            }
          }
        }
        tree.set(newPath, renderText({ lines: plus, br: "\n", eol: sawPlus ? !lastPlusBang : false }));
        return null;
      },
    };
  }
  if (isDeletion) {
    const oldPath = s.oldPath;
    return {
      paths: oldPath === null ? [""] : named,
      apply: (tree) => {
        if (oldPath === null) return { code: "unsafe", path: "" };
        if (!tree.has(oldPath)) return { code: "missing", path: oldPath };
        tree.set(oldPath, null);
        return null;
      },
    };
  }
  const oldPath = s.oldPath as string;
  const newPath = s.newPath as string;
  const isMove = oldPath !== newPath;
  return {
    paths: named,
    move: isMove ? { oldPath, newPath } : undefined,
    apply: (tree, strict) => {
      if (!tree.has(oldPath)) return { code: "missing", path: oldPath };
      if (isMove && tree.has(newPath)) return { code: "exists", path: newPath };
      const file = parseText(tree.get(oldPath) as string);
      const res = applyHunks(file, s.hunks, strict);
      if ("fail" in res) return { code: res.fail, path: oldPath };
      const text = renderText(res.file);
      if (isMove) {
        tree.set(newPath, text);
        tree.set(oldPath, null);
      } else {
        tree.set(oldPath, text);
      }
      return null;
    },
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks
// ---------------------------------------------------------------------------

function trimEndWs(line: string): string {
  return line.replace(/\s+$/, "");
}

function parseSearchReplace(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < n) {
    if (trimEndWs(lines[i]) !== "<<<<<<< SEARCH") {
      i++;
      continue;
    }
    const searchIdx = i;
    let foundPath: string | null = null;
    for (let j = searchIdx - 1; j >= prevEnd; j--) {
      const t = lines[j].trim();
      if (t === "") continue;
      if (t.startsWith("```")) continue;
      foundPath = t;
      break;
    }
    if (foundPath === null) {
      if (prevPath !== null) foundPath = prevPath;
      else throw new ParseError(searchIdx + 1);
    }
    let eqIdx = -1;
    let k = searchIdx + 1;
    while (k < n) {
      const m = trimEndWs(lines[k]);
      if (m === "=======") {
        eqIdx = k;
        break;
      }
      if (m === ">>>>>>> REPLACE" || m === "<<<<<<< SEARCH") break;
      k++;
    }
    if (eqIdx < 0) throw new ParseError(searchIdx + 1);
    let endIdx = -1;
    k = eqIdx + 1;
    while (k < n) {
      const m = trimEndWs(lines[k]);
      if (m === ">>>>>>> REPLACE") {
        endIdx = k;
        break;
      }
      if (m === "<<<<<<< SEARCH") break;
      k++;
    }
    if (endIdx < 0) throw new ParseError(searchIdx + 1);
    const oldLines = lines.slice(searchIdx + 1, eqIdx);
    const newLines = lines.slice(eqIdx + 1, endIdx);
    edits.push(searchReplaceEdit(foundPath, oldLines, newLines));
    prevPath = foundPath;
    prevEnd = endIdx + 1;
    i = endIdx + 1;
  }
  if (edits.length === 0) throw new ParseError(1);
  return edits;
}

function searchReplaceEdit(p: string, oldLines: string[], newLines: string[]): Edit {
  return {
    paths: [p],
    apply: (tree, strict) => {
      if (oldLines.length === 0) {
        if (tree.has(p)) return { code: "exists", path: p };
        tree.set(p, renderText({ lines: newLines, br: "\n", eol: newLines.length > 0 }));
        return null;
      }
      if (!tree.has(p)) return { code: "missing", path: p };
      const file = parseText(tree.get(p) as string);
      const found = firstTierWith(file.lines, oldLines, strict, 0);
      if (!found) return { code: "no-match", path: p };
      if (found.positions.length > 1) return { code: "ambiguous", path: p };
      const pos = found.positions[0];
      const f = leadingWs(file.lines[pos]);
      const pp = leadingWs(oldLines[0]);
      const out = newLines.map((text) => {
        if (found.tier === 2 && text !== "" && text.trim() !== "" && text.startsWith(pp)) {
          return f + text.slice(pp.length);
        }
        return text;
      });
      const lines = file.lines.slice();
      lines.splice(pos, oldLines.length, ...out);
      tree.set(p, renderText({ lines, br: file.br, eol: file.eol }));
      return null;
    },
  };
}

// ---------------------------------------------------------------------------
// V4A patches
// ---------------------------------------------------------------------------

interface V4aChunk {
  anchor: string | null; // null means no anchor
  eof: boolean;
  ops: BodyOp[];
}

// Collect one section's lines (with their numbers) until the next section
// header or the end of the patch body, dropping trailing blank lines.
function collectV4aSection(
  lines: string[],
  start: number,
  endExclusive: number,
): { items: { text: string; no: number }[]; next: number } {
  const items: { text: string; no: number }[] = [];
  let j = start;
  while (j < endExclusive) {
    const line = lines[j];
    if (
      line.startsWith("*** Add File: ") ||
      line.startsWith("*** Delete File: ") ||
      line.startsWith("*** Update File: ")
    ) {
      break;
    }
    items.push({ text: line, no: j + 1 });
    j++;
  }
  while (items.length > 0 && items[items.length - 1].text.trim() === "") items.pop();
  return { items, next: j };
}

function v4aAddEdit(p: string, fileLines: string[]): Edit {
  return {
    paths: [p],
    apply: (tree) => {
      if (tree.has(p)) return { code: "exists", path: p };
      tree.set(p, renderText({ lines: fileLines, br: "\n", eol: fileLines.length > 0 }));
      return null;
    },
  };
}

function v4aDeleteEdit(p: string): Edit {
  return {
    paths: [p],
    apply: (tree) => {
      if (!tree.has(p)) return { code: "missing", path: p };
      tree.set(p, null);
      return null;
    },
  };
}

function applyV4aChunks(
  file: TextFile,
  chunks: V4aChunk[],
  strict: boolean,
): { file: TextFile } | { fail: string } {
  let lines = file.lines.slice();
  let cursor = 0;
  for (const chunk of chunks) {
    if (chunk.anchor !== null && chunk.anchor !== "") {
      let foundIdx = -1;
      const tiers = strict ? [0] : [0, 1, 2];
      for (const t of tiers) {
        const key = lineKey(chunk.anchor, t);
        for (let idx = cursor; idx < lines.length; idx++) {
          if (lineKey(lines[idx], t) === key) {
            foundIdx = idx;
            break;
          }
        }
        if (foundIdx >= 0) break;
      }
      if (foundIdx < 0) return { fail: "no-match" };
      cursor = foundIdx + 1;
    }
    const oLines: string[] = [];
    for (const op of chunk.ops) {
      if (op.kind === "ctx" || op.kind === "del") oLines.push(op.text);
    }
    if (oLines.length > 0) {
      const found = firstTierWith(lines, oLines, strict, cursor);
      let pos = -1;
      if (found) {
        if (chunk.eof) {
          for (const cand of found.positions) {
            if (cand + oLines.length === lines.length) {
              pos = cand;
              break;
            }
          }
        } else {
          pos = found.positions[0];
        }
      }
      if (pos < 0) return { fail: "no-match" };
      const nLines = buildNewLines(chunk.ops, lines, pos, oLines, found.tier);
      lines.splice(pos, oLines.length, ...nLines);
      cursor = pos + nLines.length;
    } else {
      const nLines = chunk.ops.filter((o) => o.kind === "add").map((o) => o.text);
      const insertAt = chunk.eof ? lines.length : cursor;
      lines.splice(insertAt, 0, ...nLines);
      cursor = insertAt + nLines.length;
    }
  }
  return { file: { lines, br: file.br, eol: file.eol } };
}

function v4aUpdateEdit(
  p: string,
  items: { text: string; no: number }[],
  headerNo: number,
): Edit {
  let idx = 0;
  let moveTo: string | null = null;
  if (idx < items.length && items[idx].text.startsWith("*** Move to: ")) {
    moveTo = items[idx].text.slice("*** Move to: ".length).trim();
    idx++;
  }
  const chunks: V4aChunk[] = [];
  let cur: V4aChunk | null = null;
  const startChunk = (anchor: string | null) => {
    cur = { anchor, eof: false, ops: [] };
    chunks.push(cur);
  };
  for (; idx < items.length; idx++) {
    const it = items[idx];
    const line = it.text;
    if (line.startsWith("@@")) {
      startChunk(line.slice(2).trim());
      continue;
    }
    if (line === "*** End of File") {
      if (cur === null) throw new ParseError(it.no);
      cur.eof = true;
      cur = null;
      continue;
    }
    if (line === "" || line.startsWith(" ") || line.startsWith("-") || line.startsWith("+")) {
      if (cur === null) {
        if (chunks.length > 0) throw new ParseError(it.no);
        startChunk(null);
      }
      if (line === "") (cur as V4aChunk).ops.push({ kind: "ctx", text: "", bang: false });
      else if (line.startsWith(" ")) (cur as V4aChunk).ops.push({ kind: "ctx", text: line.slice(1), bang: false });
      else if (line.startsWith("-")) (cur as V4aChunk).ops.push({ kind: "del", text: line.slice(1), bang: false });
      else (cur as V4aChunk).ops.push({ kind: "add", text: line.slice(1), bang: false });
      continue;
    }
    throw new ParseError(it.no);
  }
  if (chunks.length === 0 && moveTo === null) throw new ParseError(headerNo);
  return {
    paths: moveTo !== null ? [p, moveTo] : [p],
    move: moveTo !== null ? { oldPath: p, newPath: moveTo } : undefined,
    apply: (tree, strict) => {
      if (!tree.has(p)) return { code: "missing", path: p };
      if (moveTo !== null && tree.has(moveTo)) return { code: "exists", path: moveTo };
      const file = parseText(tree.get(p) as string);
      const res = applyV4aChunks(file, chunks, strict);
      if ("fail" in res) return { code: res.fail, path: p };
      const text = renderText(res.file);
      if (moveTo !== null) {
        tree.set(moveTo, text);
        tree.set(p, null);
      } else {
        tree.set(p, text);
      }
      return null;
    },
  };
}

function parseV4a(lines: string[]): Edit[] {
  const n = lines.length;
  let first = -1;
  let last = -1;
  for (let i = 0; i < n; i++) {
    if (lines[i].trim() !== "") {
      first = i;
      break;
    }
  }
  if (first < 0) throw new ParseError(1);
  for (let i = n - 1; i >= 0; i--) {
    if (lines[i].trim() !== "") {
      last = i;
      break;
    }
  }
  if (lines[first].trim() !== "*** Begin Patch") throw new ParseError(first + 1);
  if (lines[last].trim() !== "*** End Patch") throw new ParseError(n + 1);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }
    if (line.startsWith("*** Add File: ")) {
      const p = line.slice("*** Add File: ".length).trim();
      const { items, next } = collectV4aSection(lines, i + 1, last);
      const fileLines: string[] = [];
      for (const it of items) {
        if (it.text === "") fileLines.push("");
        else if (it.text.startsWith("+")) fileLines.push(it.text.slice(1));
        else throw new ParseError(it.no);
      }
      edits.push(v4aAddEdit(p, fileLines));
      i = next;
      continue;
    }
    if (line.startsWith("*** Delete File: ")) {
      const p = line.slice("*** Delete File: ".length).trim();
      const { items, next } = collectV4aSection(lines, i + 1, last);
      if (items.length > 0) throw new ParseError(items[0].no);
      edits.push(v4aDeleteEdit(p));
      i = next;
      continue;
    }
    if (line.startsWith("*** Update File: ")) {
      const p = line.slice("*** Update File: ".length).trim();
      const { items, next } = collectV4aSection(lines, i + 1, last);
      edits.push(v4aUpdateEdit(p, items, i + 1));
      i = next;
      continue;
    }
    throw new ParseError(i + 1);
  }
  if (edits.length === 0) throw new ParseError(1);
  return edits;
}

// ---------------------------------------------------------------------------
// JSON edits
// ---------------------------------------------------------------------------

function jsonEdit(obj: unknown, errLine: number): Edit {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) throw new ParseError(errLine);
  const o = obj as Record<string, unknown>;
  if (typeof o.path !== "string" || typeof o.command !== "string") throw new ParseError(errLine);
  const p = o.path as string;
  const cmd = o.command as string;
  if (cmd === "create") {
    if (typeof o.file_text !== "string") throw new ParseError(errLine);
    const text = o.file_text as string;
    return {
      paths: [p],
      apply: (tree) => {
        if (tree.has(p)) return { code: "exists", path: p };
        tree.set(p, text);
        return null;
      },
    };
  }
  if (cmd === "str_replace") {
    if (typeof o.old_str !== "string" || (o.old_str as string) === "") throw new ParseError(errLine);
    if (o.new_str !== undefined && typeof o.new_str !== "string") throw new ParseError(errLine);
    const oldStr = o.old_str as string;
    const newStr = (o.new_str as string | undefined) ?? "";
    return {
      paths: [p],
      apply: (tree) => {
        if (!tree.has(p)) return { code: "missing", path: p };
        const raw = tree.get(p) as string;
        const file = parseText(raw);
        let hay = raw;
        let needle = oldStr;
        let replacement = newStr;
        if (file.br === "\r\n") {
          hay = raw.split("\r\n").join("\n");
          needle = oldStr.split("\r\n").join("\n");
          replacement = newStr.split("\r\n").join("\n");
        }
        let count = 0;
        let firstAt = -1;
        let idx = 0;
        while (true) {
          const at = hay.indexOf(needle, idx);
          if (at < 0) break;
          if (count === 0) firstAt = at;
          count++;
          if (count > 1) break;
          idx = at + 1;
        }
        if (count === 0) return { code: "no-match", path: p };
        if (count > 1) return { code: "ambiguous", path: p };
        let result = hay.slice(0, firstAt) + replacement + hay.slice(firstAt + needle.length);
        if (file.br === "\r\n") result = result.split("\n").join("\r\n");
        tree.set(p, result);
        return null;
      },
    };
  }
  if (cmd === "insert") {
    if (typeof o.insert_line !== "number" || !Number.isInteger(o.insert_line)) throw new ParseError(errLine);
    if (typeof o.new_str !== "string") throw new ParseError(errLine);
    const at = o.insert_line as number;
    const newStr = o.new_str as string;
    return {
      paths: [p],
      apply: (tree) => {
        if (!tree.has(p)) return { code: "missing", path: p };
        const file = parseText(tree.get(p) as string);
        if (at < 0 || at > file.lines.length) return { code: "no-match", path: p };
        const ins = patchLines(newStr);
        const lines = file.lines.slice();
        lines.splice(at, 0, ...ins);
        tree.set(p, renderText({ lines, br: file.br, eol: file.eol }));
        return null;
      },
    };
  }
  throw new ParseError(errLine);
}

function parseJson(lines: string[], text: string): Edit[] {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== "") {
      first = i;
      break;
    }
  }
  if (first < 0) throw new ParseError(1);
  const firstNonWs = lines[first][lines[first].search(/\S/)];
  if (firstNonWs === "[") {
    let arr: unknown;
    try {
      arr = JSON.parse(text);
    } catch {
      throw new ParseError(first + 1);
    }
    if (!Array.isArray(arr)) throw new ParseError(first + 1);
    if (arr.length === 0) throw new ParseError(1);
    return arr.map((item) => jsonEdit(item, first + 1));
  }
  if (firstNonWs === "{") {
    const edits: Edit[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === "") continue;
      let obj: unknown;
      try {
        obj = JSON.parse(lines[i]);
      } catch {
        throw new ParseError(i + 1);
      }
      edits.push(jsonEdit(obj, i + 1));
    }
    if (edits.length === 0) throw new ParseError(1);
    return edits;
  }
  throw new ParseError(first + 1);
}

// ---------------------------------------------------------------------------
// Format detection and patch parsing
// ---------------------------------------------------------------------------

function detectFormat(lines: string[]): string | null {
  let firstNonBlank = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== "") {
      firstNonBlank = i;
      break;
    }
  }
  if (firstNonBlank < 0) return null;
  const first = lines[firstNonBlank];
  if (first.trim() === "*** Begin Patch") return "v4a";
  const firstChar = first[first.search(/\S/)];
  if (firstChar === "[" || firstChar === "{") return "json";
  for (const line of lines) {
    if (trimEndWs(line) === "<<<<<<< SEARCH") return "search-replace";
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("diff --git ")) return "unified";
    if (lines[i].startsWith("--- ") && i + 1 < lines.length && lines[i + 1].startsWith("+++ ")) {
      return "unified";
    }
  }
  return null;
}

function parsePatch(format: string, text: string): Edit[] {
  const lines = patchLines(text);
  if (format === "unified") return parseUnified(lines);
  if (format === "search-replace") return parseSearchReplace(lines);
  if (format === "v4a") return parseV4a(lines);
  return parseJson(lines, text);
}

// ---------------------------------------------------------------------------
// The mend command line
// ---------------------------------------------------------------------------

interface CliArgs {
  format: string;
  check: boolean;
  strict: boolean;
  positional: string[];
}

function parseArgs(argv: string[]): CliArgs | null {
  let format = "auto";
  let check = false;
  let strict = false;
  let formatSeen = false;
  let checkSeen = false;
  let strictSeen = false;
  const positional: string[] = [];
  let endOpts = false;
  for (const arg of argv) {
    if (!endOpts && arg === "--") {
      endOpts = true;
      continue;
    }
    if (!endOpts && arg.startsWith("-") && arg !== "-") {
      if (arg === "--check") {
        if (checkSeen) return null;
        checkSeen = true;
        check = true;
      } else if (arg === "--strict") {
        if (strictSeen) return null;
        strictSeen = true;
        strict = true;
      } else if (arg.startsWith("--format=")) {
        if (formatSeen) return null;
        formatSeen = true;
        format = arg.slice("--format=".length);
      } else {
        return null;
      }
    } else {
      positional.push(arg);
    }
  }
  if (!["auto", "unified", "search-replace", "v4a", "json"].includes(format)) return null;
  if (positional.length > 1) return null;
  return { format, check, strict, positional };
}

// Compare UTF-8 byte order.
function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

// Build the exit-0 listing from before/after states. A successful move
// whose old path is gone and whose new path appeared is one R line, sorted
// by the new path; everything else is A, D or M by path.
function buildListing(tree: Tree, moves: { oldPath: string; newPath: string }[]): string[] {
  const changed = new Map<string, { before: string | null; after: string | null }>();
  for (const p of tree.touched()) {
    const b = tree.beforeOf(p);
    const a = tree.afterOf(p);
    if (b !== a) changed.set(p, { before: b, after: a });
  }
  const lines: { key: string; text: string }[] = [];
  const paired = new Set<string>();
  for (const m of moves) {
    const oldState = changed.get(m.oldPath);
    const newState = changed.get(m.newPath);
    if (
      oldState &&
      oldState.before !== null &&
      oldState.after === null &&
      newState &&
      newState.before === null &&
      newState.after !== null
    ) {
      lines.push({ key: m.newPath, text: "R " + m.oldPath + " -> " + m.newPath });
      paired.add(m.oldPath);
      paired.add(m.newPath);
    }
  }
  for (const [p, st] of changed) {
    if (paired.has(p)) continue;
    if (st.before === null) lines.push({ key: p, text: "A " + p });
    else if (st.after === null) lines.push({ key: p, text: "D " + p });
    else lines.push({ key: p, text: "M " + p });
  }
  lines.sort((a, b) => byteCompare(a.key, b.key));
  return lines.map((l) => l.text);
}

function writeChanges(tree: Tree): void {
  for (const p of tree.touched()) {
    const b = tree.beforeOf(p);
    const a = tree.afterOf(p);
    if (b === a) continue;
    try {
      if (a === null) {
        fs.unlinkSync(p);
      } else {
        const dir = path.dirname(p);
        if (dir !== "." && dir !== "") fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(p, a, "utf8");
      }
    } catch {
      // A write that cannot happen leaves the file as it was; the exit
      // code and stdout still follow the patch's verdict.
    }
  }
}

function runCli(argv: string[]): number {
  const parsed = parseArgs(argv);
  if (!parsed) {
    process.stdout.write("error: usage\n");
    return 2;
  }
  let patchText: string;
  if (parsed.positional.length === 0 || parsed.positional[0] === "-") {
    try {
      patchText = fs.readFileSync(0, "utf8");
    } catch {
      process.stdout.write("error: no-patch\n");
      return 2;
    }
  } else {
    try {
      patchText = fs.readFileSync(parsed.positional[0], "utf8");
    } catch {
      process.stdout.write("error: no-patch\n");
      return 2;
    }
  }
  let format = parsed.format;
  if (format === "auto") {
    const detected = detectFormat(patchLines(patchText));
    if (!detected) {
      process.stdout.write("error: format\n");
      return 2;
    }
    format = detected;
  }
  let edits: Edit[];
  try {
    edits = parsePatch(format, patchText);
  } catch (e) {
    if (e instanceof ParseError) {
      process.stdout.write("error: parse " + e.line + "\n");
      return 2;
    }
    throw e;
  }
  if (edits.length === 0) {
    process.stdout.write("error: parse 1\n");
    return 2;
  }
  const tree = new Tree();
  const failures: EditFailure[] = [];
  const moves: { oldPath: string; newPath: string }[] = [];
  for (const edit of edits) {
    let fail: EditFailure | null = null;
    for (const p of edit.paths) {
      if (!isSafePath(p)) {
        fail = { code: "unsafe", path: p };
        break;
      }
    }
    if (!fail) fail = edit.apply(tree, parsed.strict);
    if (fail) {
      failures.push(fail);
    } else if (edit.move) {
      moves.push(edit.move);
    }
  }
  if (failures.length > 0) {
    const out: string[] = failures.map((f) => "error: " + f.code + " " + f.path);
    out.push("failed: " + failures.length + " of " + edits.length + " edits");
    process.stdout.write(out.join("\n") + "\n");
    return 1;
  }
  const listing = buildListing(tree, moves);
  if (!parsed.check) writeChanges(tree);
  const out = listing.slice();
  out.push(listing.length === 1 ? "ok: 1 file" : "ok: " + listing.length + " files");
  process.stdout.write(out.join("\n") + "\n");
  return 0;
}

// ---------------------------------------------------------------------------
// The trial runner (MAKEFUN_ENV_URL mode)
// ---------------------------------------------------------------------------

interface TrialCheck {
  id: string;
  argv: string[];
  stdin: string | null;
  files: Record<string, string>;
}

interface TrialResult {
  id: string;
  exit: number;
  stdout: string;
  files: Record<string, string>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getChecks(base: string): Promise<{ checks: TrialCheck[]; answered: number; total: number }> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(base + "/checks", { signal: AbortSignal.timeout(10000) });
      if (res.ok) return (await res.json()) as { checks: TrialCheck[]; answered: number; total: number };
      lastErr = new Error("GET /checks returned " + res.status);
    } catch (e) {
      lastErr = e;
    }
    await sleep(500);
  }
  throw lastErr;
}

function collectFiles(dir: string, rel: string, out: Record<string, string>): void {
  const entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
  for (const e of entries) {
    const r = rel === "" ? e.name : rel + "/" + e.name;
    if (e.isDirectory()) {
      collectFiles(dir, r, out);
    } else if (e.isFile()) {
      out[r] = fs.readFileSync(path.join(dir, r), "utf8");
    }
  }
}

function runOneCheck(check: TrialCheck): TrialResult {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mend-check-"));
  try {
    for (const [rel, text] of Object.entries(check.files || {})) {
      const target = path.join(dir, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text, "utf8");
    }
    const script = path.resolve(process.argv[1]);
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    delete env.MAKEFUN_ENV_URL;
    const child = spawnSync(process.execPath, [script, ...(check.argv || [])], {
      cwd: dir,
      input: check.stdin === null || check.stdin === undefined ? "" : check.stdin,
      encoding: "utf8",
      timeout: 10000,
      killSignal: "SIGKILL",
      maxBuffer: 16 * 1024 * 1024,
      env,
    });
    const exit = child.status === null ? 124 : child.status;
    const stdout = typeof child.stdout === "string" ? child.stdout : "";
    const files: Record<string, string> = {};
    collectFiles(dir, "", files);
    return { id: check.id, exit, stdout, files };
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // A temp dir that cannot be removed is harmless.
    }
  }
}

async function postResults(base: string, results: TrialResult[], accepted: Set<string>): Promise<void> {
  try {
    const res = await fetch(base + "/results", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ results }),
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      const body = (await res.json().catch(() => ({}))) as { accepted?: string[] };
      const acc = body.accepted || results.map((r) => r.id);
      for (const id of acc) accepted.add(id);
      return;
    }
  } catch {
    // Fall through to posting one by one.
  }
  for (const r of results) {
    if (accepted.has(r.id)) continue;
    try {
      const res = await fetch(base + "/results", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ results: [r] }),
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) {
        const body = (await res.json().catch(() => ({}))) as { accepted?: string[] };
        const acc = body.accepted || [r.id];
        for (const id of acc) accepted.add(id);
      } else if (res.status === 409) {
        accepted.add(r.id);
      }
    } catch {
      // Left unaccepted; the next round retries it.
    }
  }
}

async function runTrial(envUrl: string): Promise<number> {
  const base = envUrl.replace(/\/$/, "");
  const accepted = new Set<string>();
  for (let round = 0; round < 3; round++) {
    let listing: { checks: TrialCheck[]; answered: number; total: number };
    try {
      listing = await getChecks(base);
    } catch (e) {
      console.error("mend: could not reach the trial env: " + String(e));
      return 1;
    }
    const todo = (listing.checks || []).filter((c) => !accepted.has(c.id));
    if (todo.length === 0) break;
    const results: TrialResult[] = [];
    for (const check of todo) {
      results.push(runOneCheck(check));
    }
    await postResults(base, results, accepted);
    if (listing.total && accepted.size >= listing.total) break;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv) {
  runTrial(trialEnv)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e) => {
      console.error(String(e && (e as Error).stack ? (e as Error).stack : e));
      process.exitCode = 1;
    });
} else {
  try {
    process.exitCode = runCli(process.argv.slice(2));
  } catch (e) {
    console.error(String(e && (e as Error).stack ? (e as Error).stack : e));
    process.exitCode = 1;
  }
}
