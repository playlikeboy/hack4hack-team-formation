// Serves the built client from server/public/ (production: one container,
// one process, one port). Hand-rolled on purpose: the file set is tiny
// (Vite output), the rules are two (serve the file if it exists, else the
// SPA fallback), and there is nothing here that needs a dependency.
//
// Paths are resolved against public/ and rejected if they escape it —
// a request for /../server/src/index.ts must never reach the filesystem.

import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import type { Context } from 'hono'
import type { AppEnv } from './env'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

export function publicDir(): string {
  // src/lib/ in dev, dist/lib/ in production — public/ is the sibling
  // of both (server/public/).
  return path.join(__dirname, '..', '..', 'public')
}

/**
 * Serve a client file for this request, or null when there is nothing to
 * serve (API paths, or a missing file with no index.html fallback).
 * The caller turns null into a 404.
 */
export function serveClient(c: Context<AppEnv>): Response | null {
  const url = new URL(c.req.url)
  if (url.pathname.startsWith('/api')) return null

  const root = publicDir()
  const requested = path.normalize(path.join(root, decodeURIComponent(url.pathname)))
  if (!requested.startsWith(root)) return null

  let file = requested
  if (existsSync(file) && statSync(file).isDirectory()) {
    // A directory request (e.g. "/") serves that directory's index.html —
    // without this, readFileSync on a directory throws EISDIR.
    file = path.join(file, 'index.html')
  }
  if (!existsSync(file)) {
    // SPA fallback: /teams/abc has no file, but the React router does.
    file = path.join(root, 'index.html')
    if (!existsSync(file)) return null
  }

  const ext = path.extname(file).toLowerCase()
  return new Response(readFileSync(file), {
    headers: {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      // Vite hashes asset filenames, so hashed files are immutable;
      // index.html itself must always be revalidated.
      'Cache-Control': file.endsWith('index.html')
        ? 'no-cache'
        : 'public, max-age=31536000, immutable',
    },
  })
}
