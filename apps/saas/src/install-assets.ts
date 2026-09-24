import { createReadStream, promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

// Dedicated, immutable public release files. No directory listing or user-controlled paths.
export async function serveInstallAsset(req: IncomingMessage, res: ServerResponse, pathname: string, root?: string): Promise<boolean> {
  if (!pathname.startsWith('/v1/install/')) return false;
  const match = /^\/v1\/install\/(v\d+\.\d+\.\d+|runtime)\/([a-zA-Z0-9][a-zA-Z0-9._-]*\.(?:tar\.gz|tar\.xz|sha256))$/.exec(pathname);
  if (!root || !match || (req.method !== 'GET' && req.method !== 'HEAD')) {
    res.writeHead(404); res.end(); return true;
  }
  const file = join(root, match[1], match[2]);
  let size: number;
  try {
    const info = await fs.stat(file);
    if (!info.isFile()) throw new Error('not a file');
    size = info.size;
  } catch {
    res.writeHead(404); res.end(); return true;
  }
  res.writeHead(200, {
    'content-type': file.endsWith('.sha256') ? 'text/plain; charset=utf-8' : 'application/octet-stream',
    'content-length': size,
    'cache-control': 'public, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
  });
  if (req.method === 'HEAD') res.end();
  else createReadStream(file).pipe(res);
  return true;
}
