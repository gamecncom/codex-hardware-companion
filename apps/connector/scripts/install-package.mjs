#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

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
let lightPackage = false;
try { lightPackage = JSON.parse(await fs.readFile(join(source, 'compatibility.json'), 'utf8')).nodeRuntime === 'external-validated-absolute-path'; } catch {}
const required = new Set(['VERSION', 'bin/companion', 'dist/cli.js', 'skills/hardware-companion/SKILL.md']);
if (!lightPackage) required.add('runtime/node');
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
let nodePath;
if (lightPackage) {
  const candidate = flag('--node');
  if (!candidate || !isAbsolute(candidate)) throw new Error('RUNTIME_NODE_ABSOLUTE_PATH_REQUIRED');
  nodePath = (await fs.realpath(candidate));
  const probe = `const major=Number(process.versions.node.split('.')[0]);if(process.platform!=='darwin'||process.arch!=='arm64'||![22,24].includes(major)||!process.versions.openssl)process.exit(78);Promise.all([import('node:crypto'),import('node:fs/promises'),import('node:net'),import('node:tls')]).catch(()=>process.exit(78));`;
  try { execFileSync(nodePath, ['-e', probe], { stdio: 'ignore', timeout: 5000 }); } catch { throw new Error('RUNTIME_NODE_INCOMPATIBLE'); }
}
const current = join(installRoot, 'current'); const previous = join(installRoot, 'previous');
try { await fs.access(current); throw new Error('INSTALL_ROOT_OCCUPIED'); } catch (error) { if (error?.message === 'INSTALL_ROOT_OCCUPIED') throw error; }
try { await fs.access(previous); throw new Error('INSTALL_ROOT_OCCUPIED'); } catch (error) { if (error?.message === 'INSTALL_ROOT_OCCUPIED') throw error; }
await fs.mkdir(installRoot, { recursive: true });
const staging = join(installRoot, `.staging-install-${process.pid}-${Date.now()}`);
try { await fs.cp(source, staging, { recursive: true, errorOnExist: true }); if (nodePath) await fs.writeFile(join(staging, 'runtime-node-path'), `${nodePath}\n`); await fs.rename(staging, current); console.log(JSON.stringify({ ok: true, operation: 'install', installRoot, current, version, launchctl: 'not-called', configPreserved: true })); }
finally { await fs.rm(staging, { recursive: true, force: true }); }
