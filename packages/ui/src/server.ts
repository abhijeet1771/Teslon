import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve as resolvePath } from 'node:path';
import {
  analyze,
  gitIn,
  isGitRepository,
  listFiles,
  resolveChange,
  resolveMerged,
  readAstSource,
  bareImports,
  coChangeEdges,
  lockfileEdges,
  NoMergeBaseError,
  defaultBase,
  prepareTree,
  type AstReading,
  type Commit,
} from '@teslon/core';

/**
 * The local app.
 *
 * Teslon's whole posture is that your code does not leave your machine, and a
 * web UI is the easiest place to break that by accident. So this server binds
 * to the loopback interface only, serves exactly three static files by name,
 * sends no CORS header, and treats every ref that arrives over HTTP as hostile
 * until it has been checked.
 *
 * It is deliberately dependency-free — no framework, no bundler, no client
 * library. A tool whose selling point is that it cannot phone home should not
 * ship a supply chain to render a list.
 */

export interface ServerOptions {
  readonly root: string;
  readonly port?: number;
  /** Loopback only. There is no option to widen this, on purpose. */
  readonly host?: '127.0.0.1' | 'localhost';
}

/**
 * A git ref that arrived over HTTP.
 *
 * `gitIn` uses `execFileSync` with an argument array, so there is no shell and
 * nothing to quote-escape. Option injection is the live risk instead: a "ref"
 * of `--upload-pack=...` is not a ref, it is an argument to git, and git will
 * honour it. Anything beginning with a dash is rejected before it reaches the
 * argument list, along with the characters a refname may not contain anyway.
 */
const REF_RE = /^[A-Za-z0-9_][A-Za-z0-9._/@^~-]{0,200}$/;

export function isSafeRef(ref: string): boolean {
  if (!REF_RE.test(ref)) return false;
  if (ref.startsWith('-')) return false;
  if (ref.includes('..') && !ref.includes('...')) {
    // `a..b` is a range, not a ref. Ranges are accepted only where a range is
    // what the endpoint asks for, so they are rejected here.
    return false;
  }
  return !/[\s~^:?*[\\]/.test(ref.replace(/[\^~]\d*$/, ''));
}

const STATIC: Record<string, string> = {
  '/': 'app.html',
  '/app.html': 'app.html',
  '/app.css': 'app.css',
  '/app.js': 'app.js',
  // The display face is bundled and served from here rather than fetched from
  // a font CDN: a local tool that promises your code never leaves the machine
  // should not make a network request to draw its own headings. Barlow
  // Condensed is SIL Open Font License; the licence ships beside it.
  '/fonts/BarlowCondensed-Black.ttf': 'fonts/BarlowCondensed-Black.ttf',
  '/fonts/BarlowCondensed-ExtraBold.ttf': 'fonts/BarlowCondensed-ExtraBold.ttf',
  '/fonts/BarlowCondensed-SemiBold.ttf': 'fonts/BarlowCondensed-SemiBold.ttf',
  '/fonts/OFL.txt': 'fonts/OFL.txt',
};

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

function readAsset(name: string): Buffer {
  return readFileSync(new URL(`../public/${name}`, import.meta.url));
}

/** Commits as sets of touched files, for the co-change signal. */
function commitsFrom(root: string, limit = 400): readonly Commit[] {
  try {
    return gitIn(root)(['log', '-n', String(limit), '--name-only', '--no-merges', '--format=%x00', '--diff-filter=d'])
      .split('\u0000')
      .map((block) => block.split('\n').map((l) => l.trim()).filter(Boolean))
      .filter((files) => files.length > 0);
  } catch {
    return [];
  }
}

function authorsFor(root: string, files: readonly string[]): Map<string, readonly string[]> {
  const git = gitIn(root);
  const out = new Map<string, readonly string[]>();
  for (const file of files.slice(0, 200)) {
    try {
      const counts = new Map<string, number>();
      for (const name of git(['log', '-n', '20', '--format=%an', '--', file]).split('\n')) {
        const n = name.trim();
        if (n) counts.set(n, (counts.get(n) ?? 0) + 1);
      }
      if (counts.size === 0) continue;
      out.set(
        file,
        [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 2).map(([n]) => n),
      );
    } catch {
      // A file with no history is a new file. Nothing to infer.
    }
  }
  return out;
}

function baseReadingsAt(root: string, sha: string, files: readonly string[]): Map<string, AstReading | null> {
  const git = gitIn(root);
  const out = new Map<string, AstReading | null>();
  for (const file of files) {
    if (!/\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(file)) continue;
    try {
      out.set(file, readAstSource(file, git(['show', `${sha}:${file}`])));
    } catch {
      out.set(file, null);
    }
  }
  return out;
}

const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'npm-shrinkwrap.json'];

function lockfileDiff(
  root: string,
  baseSha: string,
  files: readonly string[],
): { file: string; before: string; after: string } | undefined {
  const touched = files.find((f) => LOCKFILES.some((l) => f === l || f.endsWith(`/${l}`)));
  if (!touched) return undefined;
  const git = gitIn(root);
  const at = (ref: string): string => {
    try {
      return git(['show', `${ref}:${touched}`]);
    } catch {
      return '';
    }
  };
  let after = '';
  try {
    after = readFileSync(join(root, touched), 'utf8');
  } catch {
    after = '';
  }
  return { file: touched, before: at(baseSha), after };
}

/** One analysis, assembled the same way the CLI assembles it. */
export function runAnalysis(
  root: string,
  request: { readonly base?: string; readonly head?: string; readonly sha?: string; readonly range?: string },
): unknown {
  const git = gitIn(root);
  const resolved = request.sha
    ? resolveMerged(
        git,
        request.sha,
        request.range?.includes('..')
          ? { from: request.range.split('..')[0]!, to: request.range.split('..')[1]! }
          : undefined,
      )
    : resolveChange(git, {
        base: request.base ?? defaultBase(git)?.ref ?? 'main',
        head: request.head ?? 'HEAD',
      });

  const { change, limitations } = resolved;
  if (change.files.length === 0) {
    return { empty: true, change, limitations };
  }

  // The local app's whole promise is "keep one clone, point at any PR", so the
  // head is almost never what is checked out. Read it from its own tree.
  const head = request.sha ?? request.head ?? 'HEAD';
  const tree = prepareTree(git, root, head, () => mkdtempSync(join(tmpdir(), 'teslon-ui-')));
  try {
    const at = tree.root;
    const lock = lockfileDiff(at, change.mergeBase, change.files);
    const out = analyze({
      root: at,
      allFiles: listFiles(at),
      repo: root,
      change: tree.note ? { ...change, readFrom: tree.note } : change,
      limitations: [...limitations, ...tree.limitations],
      baseReadings: baseReadingsAt(at, change.mergeBase, change.files),
      authors: authorsFor(at, change.files),
      commits: commitsFrom(at),
      ...(lock ? { lockfile: lock } : {}),
    });
    // The UI renders proofs and semantic diffs too, so all three travel together.
    return { result: out.result, diffs: out.diffs, proofs: out.proofs };
  } finally {
    tree.release();
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    // Nothing here is for another origin, and saying so is cheaper than
    // discovering later that something read it.
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(text);
}

async function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createUiServer(options: ServerOptions) {
  const root = resolvePath(options.root);

  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;

      // ---- static: a fixed table, so there is no path to traverse ------
      const asset = STATIC[path];
      if (asset && req.method === 'GET') {
        try {
          const body = readAsset(asset);
          res.writeHead(200, {
            'content-type': MIME[extname(asset)] ?? 'text/plain; charset=utf-8',
            // Fonts never change between runs; everything else might.
            'cache-control': asset.startsWith('fonts/') ? 'max-age=86400' : 'no-store',
            'x-content-type-options': 'nosniff',
            // The page loads nothing from anywhere but this server, and says so
            // to the browser, so an injected tag in a file path could not
            // reach the network even if escaping ever failed.
            'content-security-policy':
              "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
            'referrer-policy': 'no-referrer',
          });
          res.end(body);
        } catch {
          json(res, 500, { error: `the interface file ${asset} is missing from this install` });
        }
        return;
      }

      if (path === '/api/context' && req.method === 'GET') {
        if (!isGitRepository(gitIn(root))) {
          json(res, 200, { root, git: false, branches: [], head: null });
          return;
        }
        const git = gitIn(root);
        const safe = (args: string[]): string => {
          try {
            return git(args);
          } catch {
            return '';
          }
        };
        const branches = safe(['branch', '-a', '--format=%(refname:short)'])
          .split('\n')
          .map((b) => b.trim())
          .filter((b) => b.length > 0 && !b.includes('->'))
          .slice(0, 200);
        json(res, 200, {
          root,
          git: true,
          branches,
          head: safe(['rev-parse', '--abbrev-ref', 'HEAD']) || null,
          recent: safe(['log', '-n', '15', '--format=%h\u0001%s\u0001%an'])
            .split('\n')
            .filter(Boolean)
            .map((line) => {
              const [sha, subject, author] = line.split('\u0001');
              return { sha, subject, author };
            }),
        });
        return;
      }

      if (path === '/api/analyze' && req.method === 'POST') {
        let body: Record<string, unknown>;
        try {
          body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;
        } catch {
          json(res, 400, { error: 'that request was not valid JSON' });
          return;
        }

        const refs = ['base', 'head', 'sha'] as const;
        for (const key of refs) {
          const value = body[key];
          if (value === undefined || value === null || value === '') continue;
          if (typeof value !== 'string' || !isSafeRef(value)) {
            json(res, 400, {
              error: `"${String(value)}" is not a usable git ref. Anything beginning with a dash would be read by git as an option rather than a ref, so it is refused.`,
            });
            return;
          }
        }
        const range = typeof body['range'] === 'string' ? body['range'] : undefined;
        if (range !== undefined && range !== '') {
          const [from, to] = range.split('..');
          if (!from || !to || !isSafeRef(from) || !isSafeRef(to)) {
            json(res, 400, { error: `"${range}" is not a usable commit range. Expected <from>..<to>.` });
            return;
          }
        }

        try {
          json(res, 200, runAnalysis(root, {
            ...(typeof body['base'] === 'string' && body['base'] ? { base: body['base'] } : {}),
            ...(typeof body['head'] === 'string' && body['head'] ? { head: body['head'] } : {}),
            ...(typeof body['sha'] === 'string' && body['sha'] ? { sha: body['sha'] } : {}),
            ...(range ? { range } : {}),
          }));
        } catch (err) {
          const e = err as Error;
          json(res, e instanceof NoMergeBaseError ? 409 : 500, {
            error: e.message,
            // Teslon never guesses a change set, and the UI has to say so
            // rather than showing an empty result that reads as "all clear".
            ...(e instanceof NoMergeBaseError
              ? { advice: 'Teslon will not guess a change set. Fetch more history and try again.' }
              : {}),
          });
        }
        return;
      }

      json(res, 404, { error: `no route for ${req.method} ${path}` });
    })();
  });
}

export function startUi(options: ServerOptions): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createUiServer(options);
  const host = options.host ?? '127.0.0.1';
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : options.port;
      resolve({
        url: `http://${host}:${port}/`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
