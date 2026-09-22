import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { SMTPServer } from 'smtp-server';
import { PostgresStore } from '../apps/saas/src/pg-store.js';
import { PgBusinessRepository } from '../apps/saas/src/pg-repository.js';
import { createPgApp } from '../apps/saas/src/pg-app.js';
import { createSmtpMailProvider } from '../apps/saas/src/smtp-mail.js';

test('PG email login sends a code over SMTP and verifies it once via HTTP', async t => {
  const url = process.env.COMPANION_PG_TEST_URL;
  assert.ok(url && ['127.0.0.1', 'localhost'].includes(new URL(url).hostname));
  let delivered = '';
  const smtp = new SMTPServer({ disabledCommands: ['STARTTLS'], allowInsecureAuth: true,
    onAuth(_auth, _session, callback) { callback(null, { user: 'fixture' }); },
    onData(stream, _session, callback) {
      stream.on('data', chunk => { delivered += chunk.toString(); });
      stream.on('end', () => callback());
    },
  });
  await new Promise<void>(resolve => smtp.listen(0, '127.0.0.1', resolve));
  const smtpPort = (smtp.server.address() as any).port;
  const mail = createSmtpMailProvider({ HC_SMTP_HOST: '127.0.0.1', HC_SMTP_PORT: String(smtpPort),
    HC_SMTP_SECURE: 'false', HC_SMTP_USER: 'fixture', HC_SMTP_PASSWORD: 'synthetic-secret', HC_SMTP_FROM: 'test@example.test' });
  const db = new PostgresStore(url);
  const app = createPgApp(db, { mailProvider: mail });
  t.after(async () => {
    mail.close(); app.closeAllConnections();
    await new Promise<void>(resolve => app.close(() => resolve()));
    await new Promise<void>(resolve => smtp.close(() => resolve()));
    await db.close();
  });
  await new PgBusinessRepository(db).migrate();
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  const address = app.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const email = `${randomUUID()}@example.test`;
  const post = (route: string, body: unknown) => fetch(base + route, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const start = await post('/v1/auth/email/start', { email });
  assert.equal(start.status, 200, await start.clone().text());
  assert.ok(delivered.includes(email));
  const code = /verification code is (\d{6})/.exec(delivered)?.[1];
  assert.ok(code, 'the actual SMTP message must contain the generated code');
  const verified = await post('/v1/auth/email/verify', { email, code });
  assert.equal(verified.status, 200, await verified.clone().text());
  const session = (await verified.json()).data;
  assert.ok(session.sessionToken || session.token);
  assert.equal((await post('/v1/auth/email/verify', { email, code })).status, 401);
});
