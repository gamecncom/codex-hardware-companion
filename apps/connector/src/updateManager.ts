import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export type UpdateService = { stop(): Promise<unknown>; start(): Promise<unknown> };
export type UpdateResult = {
  updated: boolean;
  rolledBack: boolean;
  version: string;
  previousVersion?: string;
  installRoot: string;
};

type UpdateManagerOptions = {
  installRoot: string;
  service: UpdateService;
  healthCheck: (expectedVersion?: string) => Promise<boolean>;
  healthWaitMs?: number;
};

export class UpdateManager {
  readonly installRoot: string;
  readonly service: UpdateService;
  readonly healthCheck: (expectedVersion?: string) => Promise<boolean>;
  readonly healthWaitMs: number;

  constructor(options: UpdateManagerOptions) {
    if (!isAbsolute(options.installRoot)) throw new Error('INSTALL_ROOT_MUST_BE_ABSOLUTE');
    this.installRoot = resolve(options.installRoot);
    this.service = options.service;
    this.healthCheck = options.healthCheck;
    this.healthWaitMs = options.healthWaitMs ?? 20_000;
  }

  private async waitHealthy(version?: string): Promise<boolean> {
    const deadline = Date.now() + this.healthWaitMs;
    do {
      if (await this.healthCheck(version).catch(() => false)) return true;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await delay(Math.min(250, remaining));
    } while (true);
  }

  private get currentPath() { return join(this.installRoot, 'current'); }
  private get previousPath() { return join(this.installRoot, 'previous'); }

  private async version(root: string): Promise<string | undefined> {
    try { return (await fs.readFile(join(root, 'VERSION'), 'utf8')).trim() || undefined; } catch { return undefined; }
  }

  private async verifyRelease(candidate: string): Promise<string> {
    const version = await this.version(candidate);
    if (!version) throw new Error('RELEASE_VERSION_MISSING');
    const checksumPath = join(candidate, 'checksums.sha256');
    let checksums: string;
    try { checksums = await fs.readFile(checksumPath, 'utf8'); } catch { throw new Error('RELEASE_CHECKSUMS_MISSING'); }
    const entries = checksums.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).filter((line) => !line.startsWith('#'));
    if (entries.length === 0) throw new Error('RELEASE_CHECKSUMS_EMPTY');
    const candidateRoot = resolve(candidate);
    for (const entry of entries) {
      const match = /^(?<hash>[a-fA-F0-9]{64})\s+\*?(?<file>.+)$/.exec(entry);
      if (!match?.groups) throw new Error('RELEASE_CHECKSUM_INVALID');
      const file = match.groups.file.trim();
      const target = resolve(candidateRoot, file);
      if (relative(candidateRoot, target).startsWith('..') || isAbsolute(relative(candidateRoot, target))) throw new Error('RELEASE_CHECKSUM_PATH_INVALID');
      let data: Buffer;
      try { data = await fs.readFile(target); } catch { throw new Error(`RELEASE_FILE_MISSING:${file}`); }
      const actual = createHash('sha256').update(data).digest('hex');
      if (actual.toLowerCase() !== match.groups.hash.toLowerCase()) throw new Error(`RELEASE_CHECKSUM_MISMATCH:${file}`);
    }
    return version;
  }

  async update(from: string): Promise<UpdateResult> {
    if (!from || !isAbsolute(from)) throw new Error('RELEASE_PATH_MUST_BE_ABSOLUTE');
    const candidate = resolve(from);
    const inside = (child: string, parent: string) => {
      const rel = relative(resolve(parent), resolve(child));
      return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
    };
    if (inside(candidate, this.installRoot) || inside(this.installRoot, candidate)) throw new Error('RELEASE_INSTALL_ROOT_OVERLAP');
    const candidateVersion = await this.verifyRelease(candidate);
    if (await this.version(this.currentPath) === candidateVersion) {
      const currentValid = await this.verifyRelease(this.currentPath).then(() => true, () => false);
      if (currentValid) {
        const [currentChecksums, candidateChecksums] = await Promise.all([
          fs.readFile(join(this.currentPath, 'checksums.sha256'), 'utf8'),
          fs.readFile(join(candidate, 'checksums.sha256'), 'utf8'),
        ]);
        if (currentChecksums === candidateChecksums && await this.healthCheck(candidateVersion).catch(() => false)) {
          return { updated: false, rolledBack: false, version: candidateVersion, previousVersion: candidateVersion, installRoot: this.installRoot };
        }
      }
    }
    await fs.mkdir(this.installRoot, { recursive: true });
    const staging = join(this.installRoot, `.staging-${process.pid}-${Date.now()}`);
    await fs.rm(staging, { recursive: true, force: true });
    await fs.cp(candidate, staging, { recursive: true, errorOnExist: true });
    const previousVersion = await this.version(this.currentPath);
    let movedCurrent = false;
    let candidateInstalled = false;
    let previousBackedUp = false;
    const previousBackup = join(this.installRoot, `.previous-backup-${process.pid}-${Date.now()}`);
    try {
      await this.service.stop();
      try {
        await fs.rename(this.previousPath, previousBackup);
        previousBackedUp = true;
      } catch (error: any) {
        if (error?.code !== 'ENOENT') throw error;
      }
      try {
        await fs.rename(this.currentPath, this.previousPath);
        movedCurrent = true;
      } catch (error: any) {
        if (error?.code !== 'ENOENT') throw error;
      }
      await fs.rename(staging, this.currentPath);
      candidateInstalled = true;
      await this.service.start();
      if (!(await this.waitHealthy(candidateVersion))) throw new Error('UPDATE_HEALTH_FAILED');
      await fs.rm(previousBackup, { recursive: true, force: true });
      return { updated: true, rolledBack: false, version: candidateVersion, previousVersion, installRoot: this.installRoot };
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true });
      let rollbackError: unknown;
      if (candidateInstalled) {
        try { await this.service.stop(); } catch (stopError) { rollbackError = stopError; }
        if (!rollbackError) {
          try {
            await fs.rm(this.currentPath, { recursive: true, force: true });
            if (movedCurrent) await fs.rename(this.previousPath, this.currentPath);
            if (previousBackedUp) await fs.rename(previousBackup, this.previousPath);
          } catch (restoreError) { rollbackError = restoreError; }
        }
      } else if (movedCurrent) {
        try {
          await fs.rename(this.previousPath, this.currentPath);
          if (previousBackedUp) await fs.rename(previousBackup, this.previousPath);
        } catch (restoreError) { rollbackError = restoreError; }
      } else if (previousBackedUp) {
        try { await fs.rename(previousBackup, this.previousPath); } catch (restoreError) { rollbackError = restoreError; }
      }
      if (!rollbackError && (candidateInstalled || movedCurrent)) {
        try {
          await this.service.start();
          if (!(await this.waitHealthy(previousVersion))) rollbackError = new Error('UPDATE_ROLLBACK_HEALTH_FAILED');
        } catch (startError) { rollbackError = startError; }
      }
      if (rollbackError) throw new Error(`UPDATE_ROLLBACK_FAILED:${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      if (!movedCurrent) throw error;
      return { updated: false, rolledBack: true, version: previousVersion ?? 'unknown', previousVersion: candidateVersion, installRoot: this.installRoot };
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
  }
}
