#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const source = resolve(flag('--from') ?? resolve(fileURLToPath(import.meta.url), '..', '..'));
const installRootArg = flag('--install-root');
if (!installRootArg || !isAbsolute(installRootArg)) throw new Error('INSTALL_ROOT_MUST_BE_ABSOLUTE');
const installRoot = resolve(installRootArg);
const inside = (child, parent) => { const rel = relative(resolve(parent), resolve(child)); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };
if (inside(source, installRoot) || inside(installRoot, source)) throw new Error('RELEASE_INSTALL_ROOT_OVERLAP');
const version = (await fs.readFile(join(source, 'VERSION'), 'utf8')).trim();
if (!version) throw new Error('RELEASE_VERSION_MISSING');
const checksumText = await fs.readFile(join(source, 'checksums.sha256'), 'utf8');
const lines = checksumText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).filter((line) => !line.startsWith('#'));
if (!lines.length) throw new Error('RELEASE_CHECKSUMS_EMPTY');
const required = new Set(['VERSION', 'bin/companion', 'runtime/node', 'dist/cli.js', 'skills/hardware-companion/SKILL.md']);
for (const line of lines) {
  const match = /^(?<hash>[a-fA-F0-9]{64})\s+\*?(?<file>.+)$/.exec(line);
  if (!match?.groups) throw new Error('RELEASE_CHECKSUM_INVALID');
  const file = match.groups.file.trim(); const target = resolve(source, file);
  if (!inside(target, source) || target === source) throw new Error('RELEASE_CHECKSUM_PATH_INVALID');
  const actual = createHash('sha256').update(await fs.readFile(target)).digest('hex');
  if (actual.toLowerCase() !== match.groups.hash.toLowerCase()) throw new Error(`RELEASE_CHECKSUM_MISMATCH:${file}`);
  required.delete(file);
}
if (required.size) throw new Error(`RELEASE_REQUIRED_FILE_MISSING:${[...required].join(',')}`);
const current = join(installRoot, 'current'); const previous = join(installRoot, 'previous');
try { await fs.access(current); throw new Error('INSTALL_ROOT_OCCUPIED'); } catch (error) { if (error?.message === 'INSTALL_ROOT_OCCUPIED') throw error; }
try { await fs.access(previous); throw new Error('INSTALL_ROOT_OCCUPIED'); } catch (error) { if (error?.message === 'INSTALL_ROOT_OCCUPIED') throw error; }
await fs.mkdir(installRoot, { recursive: true });
const staging = join(installRoot, `.staging-install-${process.pid}-${Date.now()}`);
try { await fs.cp(source, staging, { recursive: true, errorOnExist: true }); await fs.rename(staging, current); console.log(JSON.stringify({ ok: true, operation: 'install', installRoot, current, version, launchctl: 'not-called', configPreserved: true })); }
finally { await fs.rm(staging, { recursive: true, force: true }); }
