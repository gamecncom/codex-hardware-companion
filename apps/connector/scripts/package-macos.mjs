#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const connectorRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(connectorRoot, '../..');
const protocolRoot = join(repoRoot, 'packages', 'protocol');
const arch = process.arch;
if (arch !== 'arm64') throw new Error(`UNSUPPORTED_MAC_ARCH:${arch}`);
const connectorPackage = JSON.parse(await fs.readFile(join(connectorRoot, 'package.json'), 'utf8'));
const version = connectorPackage.version;
const distRoot = join(connectorRoot, 'dist');
const protocolDist = join(protocolRoot, 'dist');
const skillRoot = join(repoRoot, 'skills', 'hardware-companion');
const required = [join(distRoot, 'cli.js'), protocolDist, skillRoot];
for (const path of required) {
  try { await fs.access(path); } catch { throw new Error(`PACKAGE_INPUT_MISSING:${path}`); }
}

const outRoot = resolve(process.env.HC_PACKAGE_OUT ?? join(connectorRoot, 'artifacts'));
const packageName = `hardware-companion-macos-${arch}-v${version}`;
const staging = join(outRoot, packageName);
const tarball = join(outRoot, `${packageName}.tar.gz`);
const skillTarball = join(outRoot, `hardware-companion-skill-v${version}.tar.gz`);
await fs.rm(staging, { recursive: true, force: true });
await fs.rm(tarball, { force: true });
await fs.rm(skillTarball, { force: true });
await fs.mkdir(join(staging, 'bin'), { recursive: true });
await fs.mkdir(join(staging, 'dist'), { recursive: true });
await fs.mkdir(join(staging, 'node_modules', '@companion', 'protocol'), { recursive: true });
await fs.mkdir(join(staging, 'node_modules', 'ws'), { recursive: true });
await fs.mkdir(join(staging, 'scripts'), { recursive: true });
await fs.mkdir(join(staging, 'skills'), { recursive: true });

await fs.cp(distRoot, join(staging, 'dist'), { recursive: true });
await fs.cp(protocolDist, join(staging, 'node_modules', '@companion', 'protocol', 'dist'), { recursive: true });
await fs.cp(join(protocolRoot, 'package.json'), join(staging, 'node_modules', '@companion', 'protocol', 'package.json'));
await fs.cp(join(repoRoot, 'node_modules', 'ws'), join(staging, 'node_modules', 'ws'), { recursive: true });
await fs.cp(join(repoRoot, 'node_modules', 'ws', 'package.json'), join(staging, 'node_modules', 'ws', 'package.json'));
await fs.cp(skillRoot, join(staging, 'skills', 'hardware-companion'), { recursive: true });
await fs.cp(join(connectorRoot, 'scripts', 'install-launchagent.mjs'), join(staging, 'scripts', 'install-launchagent.mjs'));
await fs.cp(join(connectorRoot, 'scripts', 'install-package.mjs'), join(staging, 'scripts', 'install-package.mjs'));

await fs.chmod(join(staging, 'dist', 'cli.js'), 0o755);
const wrapper = '#!/bin/sh\nset -eu\nROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)\nNODE=${HC_COMPANION_NODE:-}\nif [ -z "$NODE" ] && [ -f "$ROOT/runtime-node-path" ]; then NODE=$(cat "$ROOT/runtime-node-path"); fi\nif [ -z "$NODE" ] || [ ! -x "$NODE" ]; then echo "RUNTIME_REPAIR_REQUIRED: run the hardware-companion bootstrap again" >&2; exit 78; fi\nexec "$NODE" "$ROOT/dist/cli.js" "$@"\n';
await fs.writeFile(join(staging, 'bin', 'companion'), wrapper, { mode: 0o755 });
await fs.chmod(join(staging, 'bin', 'companion'), 0o755);
await fs.writeFile(join(staging, 'package.json'), JSON.stringify({ name: 'hardware-companion-runtime', version, type: 'module', private: true, bin: { companion: 'bin/companion' } }, null, 2) + '\n');
await fs.writeFile(join(staging, 'VERSION'), `${version}\n`);
await fs.writeFile(join(staging, 'compatibility.json'), JSON.stringify({
  packageVersion: version,
  protocol: 'hc/1',
  architecture: arch,
  nodeRuntime: 'external-validated-absolute-path',
  supportedNodeMajors: [22, 24],
  codex: { testedVersion: '0.155.0-alpha.9.2', capabilities: ['initialize', 'account/read', 'thread/list', 'thread/read', 'queue'] },
  x64Built: false,
}, null, 2) + '\n');

async function filesUnder(root, prefix = '') {
  const entries = await fs.readdir(join(root, prefix), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const next = join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(root, next));
    else files.push(next);
  }
  return files;
}
const payloadFiles = (await filesUnder(staging)).filter(file => file !== 'checksums.sha256').sort();
const checksumLines = [];
for (const file of payloadFiles) checksumLines.push(`${createHash('sha256').update(await fs.readFile(join(staging, file))).digest('hex')}  ${file}`);
await fs.writeFile(join(staging, 'checksums.sha256'), checksumLines.join('\n') + '\n');

execFileSync('tar', ['-czf', tarball, '-C', outRoot, packageName]);
const hash = createHash('sha256').update(await fs.readFile(tarball)).digest('hex');
await fs.writeFile(`${tarball}.sha256`, `${hash}  ${tarball.split('/').pop()}\n`);
execFileSync('tar', ['-czf', skillTarball, '-C', join(staging, 'skills'), 'hardware-companion']);
const skillHash = createHash('sha256').update(await fs.readFile(skillTarball)).digest('hex');
await fs.writeFile(`${skillTarball}.sha256`, `${skillHash}  ${skillTarball.split('/').pop()}\n`);
console.log(JSON.stringify({ ok: true, artifact: tarball, sha256: hash, skillArtifact: skillTarball, skillSha256: skillHash, arch, includes: ['bin/companion', 'dist', 'skills/hardware-companion', 'VERSION', 'compatibility.json', 'checksums.sha256'], x64Built: false }));
