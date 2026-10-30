import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.glb': 'model/gltf-binary',
  '.ktx2': 'image/ktx2',
  '.wasm': 'application/wasm',
};

/**
 * Serve the built client. Returns false if the request isn't for a file here.
 * Hashed assets (Vite's /assets/*) are cached forever; index.html never is,
 * so players always get the latest build.
 */
export function serveStatic(req: IncomingMessage, res: ServerResponse, dir: string): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const root = resolve(dir);
  let path: string;
  try {
    path = decodeURIComponent((req.url ?? '/').split('?')[0]);
  } catch {
    return false;
  }
  if (path.endsWith('/')) path += 'index.html';
  const file = resolve(join(root, normalize(path)));
  // Never serve anything outside the client folder.
  if (file !== root && !file.startsWith(root + sep)) return false;

  let size: number;
  try {
    const st = statSync(file);
    if (!st.isFile()) return false;
    size = st.size;
  } catch {
    return false;
  }
  const hashed = path.startsWith('/assets/');
  res.writeHead(200, {
    'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': size,
    'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  if (req.method === 'HEAD') res.end();
  else createReadStream(file).pipe(res);
  return true;
}
