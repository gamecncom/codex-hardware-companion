import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export const SERVICE_LABEL = 'cn.hardware-companion.connector';

export type LaunchctlResult = { code: number; stdout: string; stderr: string };
export type LaunchctlRunner = (args: string[]) => Promise<LaunchctlResult>;

const execFileAsync = promisify(execFile);
const defaultRunner: LaunchctlRunner = async (args) => {
  try {
    const result = await execFileAsync('/bin/launchctl', args, { encoding: 'utf8' });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error: any) {
    return {
      code: typeof error?.code === 'number' ? error.code : 1,
      stdout: String(error?.stdout ?? ''),
      stderr: String(error?.stderr ?? error?.message ?? ''),
    };
  }
};

export type ServiceManagerOptions = {
  homeDir?: string;
  installRoot?: string;
  nodePath?: string;
  cliPath?: string;
  configPath?: string;
  logDir?: string;
  uid?: number;
  launchctl?: LaunchctlRunner;
};

export class ServiceManager {
  readonly label = SERVICE_LABEL;
  readonly homeDir: string;
  readonly installRoot?: string;
  readonly nodePath: string;
  readonly cliPath: string;
  readonly configPath: string;
  readonly logDir: string;
  readonly uid: number;
  readonly launchctl: LaunchctlRunner;

  constructor(options: ServiceManagerOptions = {}) {
    this.homeDir = options.homeDir ?? homedir();
    this.installRoot = options.installRoot;
    this.nodePath = options.nodePath ?? (this.installRoot ? join(this.installRoot, 'current', 'runtime', 'node') : process.execPath);
    this.cliPath = options.cliPath ?? (this.installRoot ? join(this.installRoot, 'current', 'dist', 'cli.js') : join(dirname(fileURLToPath(import.meta.url)), 'cli.js'));
    this.configPath = options.configPath ?? join(this.homeDir, 'Library', 'Application Support', 'HardwareCompanion', 'config.json');
    this.logDir = options.logDir ?? join(this.homeDir, 'Library', 'Logs', 'HardwareCompanion');
    this.uid = options.uid ?? (typeof process.getuid === 'function' ? process.getuid() : 0);
    this.launchctl = options.launchctl ?? defaultRunner;
  }

  get plistPath(): string {
    return join(this.homeDir, 'Library', 'LaunchAgents', `${this.label}.plist`);
  }

  get domain(): string {
    return `gui/${this.uid}`;
  }

  get target(): string {
    return `${this.domain}/${this.label}`;
  }

  plist(): string {
    const xml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${xml(this.label)}</string><key>ProgramArguments</key><array><string>${xml(this.nodePath)}</string><string>${xml(this.cliPath)}</string><string>daemon</string><string>start</string><string>--config</string><string>${xml(this.configPath)}</string></array><key>EnvironmentVariables</key><dict><key>HOME</key><string>${xml(this.homeDir)}</string></dict><key>StandardOutPath</key><string>${xml(join(this.logDir, 'connector.log'))}</string><key>StandardErrorPath</key><string>${xml(join(this.logDir, 'connector.error.log'))}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer></dict></plist>\n`;
  }

  private async assertLayout(): Promise<void> {
    if (!this.installRoot) return;
    try {
      const existing = await fs.readFile(this.plistPath, 'utf8');
      if (!existing.includes(`<string>${this.nodePath.replaceAll('&', '&amp;')}</string>`) || !existing.includes(`<string>${this.cliPath.replaceAll('&', '&amp;')}</string>`)) {
        throw new Error('SERVICE_LAYOUT_MISMATCH');
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'SERVICE_LAYOUT_MISMATCH') throw error;
      // A missing plist is handled by install/start as an uninstalled service.
    }
  }

  private async print(): Promise<{ loaded: boolean; running: boolean; detail?: string }> {
    const result = await this.launchctl(['print', this.target]);
    if (result.code === 0) return { loaded: true, running: /(?:^|\n)\s*state\s*=\s*running\b/i.test(result.stdout), detail: result.stdout.trim() || undefined };
    // launchctl uses a non-zero exit for an absent service. Other failures must remain visible.
    if (/could not find service|service not found|no such process|exit status 113/i.test(result.stderr) || result.code === 113) return { loaded: false, running: false };
    throw new Error(`LAUNCHCTL_STATUS_FAILED:${result.stderr.trim() || result.code}`);
  }

  async status(): Promise<{ loaded: boolean; running: boolean; label: string; plistPath: string; detail?: string }> {
    const current = await this.print();
    return { ...current, label: this.label, plistPath: this.plistPath };
  }

  async install(): Promise<{ installed: boolean; loaded: boolean; label: string; plistPath: string }> {
    await this.assertLayout();
    const current = await this.print();
    if (current.loaded) return { installed: false, loaded: true, label: this.label, plistPath: this.plistPath };
    await fs.mkdir(dirname(this.plistPath), { recursive: true });
    await fs.mkdir(this.logDir, { recursive: true });
    await fs.writeFile(this.plistPath, this.plist(), { mode: 0o600 });
    const result = await this.launchctl(['bootstrap', this.domain, this.plistPath]);
    if (result.code !== 0) throw new Error(`LAUNCHCTL_BOOTSTRAP_FAILED:${result.stderr.trim() || result.code}`);
    const after = await this.print();
    if (!after.loaded) throw new Error('SERVICE_NOT_LOADED_AFTER_BOOTSTRAP');
    return { installed: true, loaded: true, label: this.label, plistPath: this.plistPath };
  }

  async start(): Promise<{ started: boolean; loaded: boolean; label: string }> {
    await this.assertLayout();
    let current = await this.print();
    if (!current.loaded) {
      try { await fs.access(this.plistPath); } catch { throw new Error('SERVICE_NOT_INSTALLED'); }
      const bootstrapped = await this.launchctl(['bootstrap', this.domain, this.plistPath]);
      if (bootstrapped.code !== 0) throw new Error(`LAUNCHCTL_BOOTSTRAP_FAILED:${bootstrapped.stderr.trim() || bootstrapped.code}`);
      current = await this.print();
      if (!current.loaded) throw new Error('SERVICE_NOT_LOADED_AFTER_BOOTSTRAP');
    }
    const result = await this.launchctl(['kickstart', '-k', this.target]);
    if (result.code !== 0) throw new Error(`LAUNCHCTL_START_FAILED:${result.stderr.trim() || result.code}`);
    const after = await this.print();
    if (!after.loaded) throw new Error('SERVICE_NOT_LOADED_AFTER_START');
    return { started: true, loaded: true, label: this.label };
  }

  async stop(): Promise<{ stopped: boolean; loaded: boolean; label: string }> {
    await this.assertLayout();
    const current = await this.print();
    if (!current.loaded) return { stopped: false, loaded: false, label: this.label };
    const result = await this.launchctl(['bootout', this.target]);
    if (result.code !== 0) throw new Error(`LAUNCHCTL_STOP_FAILED:${result.stderr.trim() || result.code}`);
    for (let attempt = 0; attempt < 50; attempt++) {
      if (!(await this.print()).loaded) return { stopped: true, loaded: false, label: this.label };
      await delay(100);
    }
    if ((await this.print()).loaded) throw new Error('SERVICE_STILL_LOADED_AFTER_STOP');
    return { stopped: true, loaded: false, label: this.label };
  }

  async uninstall(): Promise<{ uninstalled: boolean; loaded: boolean; label: string; plistPath: string }> {
    await this.stop();
    await fs.rm(this.plistPath, { force: true });
    return { uninstalled: true, loaded: false, label: this.label, plistPath: this.plistPath };
  }
}
