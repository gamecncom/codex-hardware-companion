import { createRequire } from "node:module";
import type { MailProvider } from "./mail-provider.js";

type Transport = { sendMail(message: Record<string, unknown>): Promise<unknown>; close(): void };
type Nodemailer = { createTransport(options: Record<string, unknown>): Transport };
const require = createRequire(import.meta.url);

export type SmtpMailOptions = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  from: string;
};

function required(name: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw Error("CONFIG_MISSING");
  return value;
}

function optionsFromEnv(env: NodeJS.ProcessEnv): SmtpMailOptions {
  const host = required("HC_SMTP_HOST", env.HC_SMTP_HOST);
  const port = Number(required("HC_SMTP_PORT", env.HC_SMTP_PORT));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error("CONFIG_INVALID");
  const secureValue = required("HC_SMTP_SECURE", env.HC_SMTP_SECURE).toLowerCase();
  if (secureValue !== "true" && secureValue !== "false") throw Error("CONFIG_INVALID");
  return { host, port, secure: secureValue === "true", user: required("HC_SMTP_USER", env.HC_SMTP_USER), password: required("HC_SMTP_PASSWORD", env.HC_SMTP_PASSWORD), from: required("HC_SMTP_FROM", env.HC_SMTP_FROM) };
}

export function createSmtpMailProvider(env: NodeJS.ProcessEnv = process.env) {
  return new SmtpMailProvider(optionsFromEnv(env));
}

export class SmtpMailProvider implements MailProvider {
  private readonly transport: Transport;
  constructor(readonly options: SmtpMailOptions, transport?: Transport) {
    if (!options.host || !options.user || !options.password || !options.from) throw Error("CONFIG_MISSING");
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535 || typeof options.secure !== "boolean") throw Error("CONFIG_INVALID");
    const nodemailer = transport ? undefined : require("nodemailer") as Nodemailer;
    this.transport = transport ?? nodemailer!.createTransport({ host: options.host, port: options.port, secure: options.secure, auth: { user: options.user, pass: options.password } });
  }
  async send(email: string, code: string): Promise<void> {
    if (typeof email !== "string" || !email.includes("@") || typeof code !== "string" || !/^\d{6}$/.test(code)) throw Error("INVALID_REQUEST");
    try {
      await this.transport.sendMail({ from: this.options.from, to: email, subject: "Hardware Companion verification code", text: `Your Hardware Companion verification code is ${code}. It expires soon.` });
    } catch {
      throw Error("MAIL_SEND_FAILED");
    }
  }
  close() { this.transport.close(); }
}
