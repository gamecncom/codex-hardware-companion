import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { once } from "node:events";
import { createSmtpMailProvider, SmtpMailProvider } from "../src/smtp-mail.js";

test("SMTP mail provider sends verification code through a local SMTP fixture", async t => {
  let message = "";
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket));
    socket.write("220 smtp-fixture\r\n");
    let buffer = "", dataMode = false, authMode = false;
    socket.on("data", chunk => {
      buffer += chunk.toString();
      if (dataMode) {
        const end = buffer.indexOf("\r\n.\r\n"); if (end < 0) return;
        message = buffer.slice(0, end); buffer = buffer.slice(end + 5); dataMode = false; socket.write("250 queued\r\n");
      }
      while (!dataMode && buffer.includes("\r\n")) {
        const end = buffer.indexOf("\r\n"), line = buffer.slice(0, end); buffer = buffer.slice(end + 2); const upper = line.toUpperCase();
        if (authMode) { authMode = false; socket.write("235 authenticated\r\n"); continue; }
        if (upper.startsWith("EHLO") || upper.startsWith("HELO")) socket.write("250-smtp-fixture\r\n250 AUTH PLAIN LOGIN\r\n");
        else if (upper.startsWith("AUTH LOGIN")) { authMode = true; socket.write("334 VXNlcm5hbWU6\r\n"); }
        else if (upper.startsWith("AUTH PLAIN")) socket.write("235 authenticated\r\n");
        else if (upper.startsWith("MAIL FROM") || upper.startsWith("RCPT TO")) socket.write("250 ok\r\n");
        else if (upper === "DATA") { dataMode = true; socket.write("354 end data with <CR><LF>.<CR><LF>\r\n"); }
        else if (upper === "QUIT") socket.end("221 bye\r\n");
        else socket.write("250 ok\r\n");
      }
    });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as any).port, password = "fixture-password-never-logged";
  let provider: SmtpMailProvider | undefined;
  t.after(async () => { provider?.close(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); });
  provider = new SmtpMailProvider({ host: "127.0.0.1", port, secure: false, user: "fixture-user", password, from: "noreply@example.test" });
  await provider.send("recipient@example.test", "123456");
  assert.match(message, /recipient@example\.test/); assert.match(message, /123456/); assert.doesNotMatch(message, new RegExp(password));
  await assert.rejects(() => provider.send("not-an-email", "123456"), /INVALID_REQUEST/);
});

test("SMTP factory rejects missing or invalid configuration without exposing credentials", () => {
  assert.throws(() => createSmtpMailProvider({}), /CONFIG_MISSING/);
  assert.throws(() => createSmtpMailProvider({ HC_SMTP_HOST: "127.0.0.1", HC_SMTP_PORT: "bad", HC_SMTP_SECURE: "false", HC_SMTP_USER: "u", HC_SMTP_PASSWORD: "secret", HC_SMTP_FROM: "noreply@example.test" }), /CONFIG_INVALID/);
  assert.throws(() => new SmtpMailProvider({ host: "127.0.0.1", port: 0, secure: false, user: "u", password: "secret", from: "noreply@example.test" }, { sendMail: async () => undefined, close() {} }), /CONFIG_INVALID/);
  assert.throws(() => new SmtpMailProvider({ host: "127.0.0.1", port: 25, secure: "false" as unknown as boolean, user: "u", password: "secret", from: "noreply@example.test" }, { sendMail: async () => undefined, close() {} }), /CONFIG_INVALID/);
  const password = "smtp-password-never-exposed";
  const provider = new SmtpMailProvider({ host: "fixture", port: 25, secure: false, user: "u", password, from: "noreply@example.test" }, { sendMail: async () => { throw Error(`connection failed with password=${password}`); }, close() {} });
  return assert.rejects(() => provider.send("recipient@example.test", "123456"), error => error instanceof Error && error.message === "MAIL_SEND_FAILED" && !error.message.includes(password));
});
