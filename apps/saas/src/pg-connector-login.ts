import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PostgresStore } from './pg-store.js';
import { apiOk } from '@companion/protocol';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const text = (value: unknown) => typeof value === 'string' ? value : '';
const bearer = (req: IncomingMessage) => (req.headers.authorization ?? '').replace(/^Bearer\s+/, '');

export interface ConnectorLoginOptions { publicBaseUrl: string; expiresMinutes?: number; demo?: { enabled: boolean; email: string; code: string }; }
export interface ConnectorLoginStart { loginId: string; browserUrl: string; pollSecret: string; expiresAt: string; status: 'pending'; mode?: 'demo'; demoCode?: string; }

export async function migrateConnectorLogins(db: PostgresStore) {
  await db.pool.query(`CREATE TABLE IF NOT EXISTS hc_connector_logins(
    id text PRIMARY KEY, poll_secret_hash text NOT NULL UNIQUE, email text,
    status text NOT NULL, connector_id text, connector_token text, connector_token_hash text,
    expires_at timestamptz NOT NULL, approved_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  ); ALTER TABLE hc_connector_logins ADD COLUMN IF NOT EXISTS connector_token text;
    ALTER TABLE hc_connector_logins ADD COLUMN IF NOT EXISTS demo_code_hash text;
    ALTER TABLE hc_connector_logins ADD COLUMN IF NOT EXISTS demo_code_consumed_at timestamptz;
    ALTER TABLE hc_connector_logins ADD COLUMN IF NOT EXISTS session_token text;
    CREATE TABLE IF NOT EXISTS hc_demo_login_codes(code_hash text PRIMARY KEY, consumed_at timestamptz)`);
}

async function readBody(req: IncomingMessage): Promise<any> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

/** Browser-mediated login for a Connector. It owns only the short-lived login row. */
export class PgConnectorLogin {
  constructor(private db: PostgresStore, private options: ConnectorLoginOptions) {
    const enabled = process.env.HC_DEMO_LOGIN_ENABLED === 'true' || process.env.HC_DEMO_LOGIN_ENABLED === '1';
    if (!options.demo && enabled) this.options = { ...options, demo: { enabled, email: process.env.HC_DEMO_LOGIN_EMAIL ?? '', code: process.env.HC_DEMO_LOGIN_CODE ?? '' } };
  }

  private base() {
    if (!this.options.publicBaseUrl || !/^https?:\/\//.test(this.options.publicBaseUrl)) throw Error('CONFIG_MISSING');
    return this.options.publicBaseUrl.replace(/\/$/, '');
  }

  async start(): Promise<ConnectorLoginStart> {
    const id = `login-${randomUUID()}`;
    const secret = randomUUID() + randomUUID();
    const demoCode = this.options.demo?.enabled && this.options.demo.email && this.options.demo.code ? this.options.demo.code : undefined;
    const expires = new Date(Date.now() + (this.options.expiresMinutes ?? 10) * 60_000);
    if (demoCode) await this.db.pool.query(`INSERT INTO hc_demo_login_codes(code_hash) VALUES($1) ON CONFLICT(code_hash) DO NOTHING`, [hash(demoCode)]);
    await this.db.pool.query(
      `INSERT INTO hc_connector_logins(id,poll_secret_hash,status,expires_at,email,demo_code_hash) VALUES($1,$2,'pending',$3,$4,$5)`,
      [id, hash(secret), expires, demoCode ? this.options.demo!.email : null, demoCode ? hash(demoCode) : null],
    );
    return { loginId: id, browserUrl: `${this.base()}/v1/connector-login/${encodeURIComponent(id)}/browser`, pollSecret: secret, expiresAt: expires.toISOString(), status: 'pending' };
  }

  async demoConfirm(loginId: string, code: string, name = 'Demo Connector') {
    if (!this.options.demo?.enabled || !this.options.demo.email) throw Error('DEMO_LOGIN_DISABLED');
    if (!code || code !== this.options.demo.code) throw Error('UNAUTHORIZED');
    const demoEmail = this.options.demo.email;
    return this.db.transaction(async (c) => {
      const codeRow = await c.query(`SELECT consumed_at FROM hc_demo_login_codes WHERE code_hash=$1 FOR UPDATE`, [hash(code)]);
      if (!codeRow.rowCount || codeRow.rows[0].consumed_at) throw Error('UNAUTHORIZED');
      const q = await c.query(`SELECT * FROM hc_connector_logins WHERE id=$1 AND expires_at>now() FOR UPDATE`, [loginId]);
      if (!q.rowCount || !q.rows[0].demo_code_hash || q.rows[0].demo_code_consumed_at) throw Error('UNAUTHORIZED');
      const row = q.rows[0];
      if (row.demo_code_hash !== hash(code) || row.email !== demoEmail || row.status !== 'pending') throw Error('UNAUTHORIZED');
      const sessionToken = `sess-${randomUUID()}${randomUUID()}`;
      const connectorId = `cn-${randomUUID()}`;
      const token = `cn-${randomUUID()}${randomUUID()}`;
      await c.query(`INSERT INTO hc_auth(email,session_hash,session_expires_at) VALUES($1,$2,now()+interval '30 days') ON CONFLICT(email) DO UPDATE SET session_hash=$2,session_expires_at=now()+interval '30 days',code_hash=NULL,code_expires_at=NULL,code_consumed_at=NULL`, [demoEmail, hash(sessionToken)]);
      await c.query(`INSERT INTO hc_connectors(id,email,name,token_hash) VALUES($1,$2,$3,$4)`, [connectorId, demoEmail, name, hash(token)]);
      await c.query(`UPDATE hc_demo_login_codes SET consumed_at=now() WHERE code_hash=$1`, [hash(code)]);
      await c.query(`UPDATE hc_connector_logins SET status='approved',connector_id=$2,connector_token=$3,connector_token_hash=$4,demo_code_consumed_at=now(),session_token=$5,approved_at=now() WHERE id=$1`, [loginId, connectorId, token, hash(token), sessionToken]);
      return { status: 'approved', loginId, connectorId, sessionToken };
    });
  }

  async poll(loginId: string, pollSecret: string) {
    if (!loginId || !pollSecret) throw Error('UNAUTHORIZED');
    const result = await this.db.pool.query(
      `SELECT id,status,connector_id,connector_token,expires_at FROM hc_connector_logins WHERE id=$1 AND poll_secret_hash=$2 AND expires_at>now()`,
      [loginId, hash(pollSecret)],
    );
    if (!result.rowCount) throw Error('UNAUTHORIZED');
    const row = result.rows[0];
    if (row.status !== 'approved') return { status: 'pending', loginId };
    return { status: 'approved', loginId, connectorId: row.connector_id, token: row.connector_token };
  }

  async approve(loginId: string, sessionToken: string, confirmed: boolean, name = 'Mac Connector') {
    if (!confirmed || !sessionToken) throw Error('CONFIRMATION_REQUIRED');
    const auth = await this.db.pool.query(
      `SELECT email FROM hc_auth WHERE session_hash=$1 AND session_expires_at>now()`, [hash(sessionToken)],
    );
    if (!auth.rowCount) throw Error('UNAUTHORIZED');
    return this.db.transaction(async (c) => {
      const login = await c.query(
        `SELECT * FROM hc_connector_logins WHERE id=$1 AND expires_at>now() FOR UPDATE`, [loginId],
      );
      if (!login.rowCount) throw Error('UNAUTHORIZED');
      const row = login.rows[0];
      if (row.status === 'approved') {
        if (row.email !== auth.rows[0].email) throw Error('UNAUTHORIZED');
        return { status: 'approved', loginId, connectorId: row.connector_id };
      }
      const connectorId = `cn-${randomUUID()}`;
      const token = `cn-${randomUUID()}${randomUUID()}`;
      // Authentication checks use hashes; the independent token column only makes
      // the one-time connector credential recoverable for an idempotent poll.
      await c.query(`INSERT INTO hc_connectors(id,email,name,token_hash) VALUES($1,$2,$3,$4)`, [connectorId, auth.rows[0].email, name, hash(token)]);
      await c.query(`UPDATE hc_connector_logins SET status='approved',email=$2,connector_id=$3,connector_token=$4,connector_token_hash=$5,approved_at=now() WHERE id=$1`, [loginId, auth.rows[0].email, connectorId, token, hash(token)]);
      return { status: 'approved', loginId, connectorId };
    });
  }

  browser(loginId: string) {
    const safe = loginId.replace(/[^a-zA-Z0-9_-]/g, '');
    return `<!doctype html><meta charset="utf-8"><title>Hardware Companion approval</title>
<h1>连接电脑端 Hardware Companion</h1><p>输入邮箱验证码并确认将此电脑连接到该账号。</p><section><h2>演示码登录</h2><p>如果服务端开启演示登录，请输入一次性演示码。</p><input id="demo" autocomplete="one-time-code" placeholder="演示码"><button id="demoApprove" type="button">确认演示连接</button></section>
<form id="f"><input id="email" type="email" required placeholder="邮箱"><button>发送验证码</button>
<input id="code" inputmode="numeric" placeholder="验证码"><label><input id="ok" type="checkbox"> 我确认连接这台电脑</label><button id="approve" type="button">批准连接</button></form><pre id="out"></pre>
<script>const id=${JSON.stringify(safe)},o=document.querySelector('#out');let session;
f.onsubmit=async e=>{e.preventDefault();let r=await fetch('/v1/auth/email/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:email.value})});o.textContent=r.ok?'验证码已发送':'发送失败'};
approve.onclick=async()=>{if(!ok.checked){o.textContent='请先勾选确认';return}let v=await fetch('/v1/auth/email/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:email.value,code:code.value})});let j=await v.json();session=j.data&&j.data.sessionToken;if(!session){o.textContent='验证码无效';return}let r=await fetch('/v1/connector-login/'+encodeURIComponent(id)+'/approve',{method:'POST',headers:{authorization:'Bearer '+session,'content-type':'application/json'},body:JSON.stringify({confirm:true})});o.textContent=r.ok?'已批准，可关闭此页面':'批准失败，请重试'};
demoApprove.onclick=async()=>{let r=await fetch('/v1/connector-login/'+encodeURIComponent(id)+'/demo-approve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:demo.value,confirm:true})});let j=await r.json();o.textContent=r.ok?'演示连接已批准，可关闭此页面':(j.error&&j.error.code)||'演示码无效'};</script>`;
  }

  async handle(req: IncomingMessage, res: ServerResponse, path: string) {
    const start = path === '/v1/connector-login/start';
    if (req.method === 'POST' && start) return this.respond(res, 200, await this.start());
    const browser = /^\/v1\/connector-login\/([^/]+)\/browser$/.exec(path);
    if (req.method === 'GET' && browser) { res.statusCode = 200; res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(this.browser(decodeURIComponent(browser[1]))); return true; }
    const approve = /^\/v1\/connector-login\/([^/]+)\/approve$/.exec(path);
    if (req.method === 'POST' && approve) { const x = await readBody(req); return this.respond(res, 200, await this.approve(decodeURIComponent(approve[1]), bearer(req), x.confirm === true, x.name)); }
    const demo = /^\/v1\/connector-login\/([^/]+)\/demo-approve$/.exec(path);
    if (req.method === 'POST' && demo) { const x = await readBody(req); if (x.confirm !== true) throw Error('CONFIRMATION_REQUIRED'); return this.respond(res, 200, await this.demoConfirm(decodeURIComponent(demo[1]), text(x.code), x.name)); }
    const poll = /^\/v1\/connector-login\/([^/]+)\/poll$/.exec(path);
    if (req.method === 'POST' && poll) { const x = await readBody(req); return this.respond(res, 200, await this.poll(decodeURIComponent(poll[1]), text(x.pollSecret))); }
    return false;
  }

  private respond(res: ServerResponse, status: number, data: unknown) { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(apiOk(randomUUID().replaceAll('-', '').slice(0, 32), data))); return true; }
}
