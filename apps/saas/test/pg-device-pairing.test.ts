import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from 'node:crypto';
import { PostgresStore } from "../src/pg-store.js";
import { PgBusinessRepository } from "../src/pg-repository.js";
import { createPgApp } from "../src/pg-app.js";
test("PG device pairing start/poll is persistent and bootstrap-bound", async (t) => {
  const url = process.env.COMPANION_PG_TEST_URL;
  if (!url) return t.skip("COMPANION_PG_TEST_URL not set");
  const db = new PostgresStore(url),
    repo = new PgBusinessRepository(db);
  await repo.migrate();
  const app = createPgApp(db, {
    publicBaseUrl: "https://companion.example.test",
    deviceBootstraps: { [randomUUID()]: "bootstrap-fixture" },
  } as any);
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", () => r()));
  t.after(async () => {
    await new Promise<void>((r) => app.close(() => r()));
    await db.close();
  });
  const port = (app.address() as any).port;
  const call = async (path: string, body: any, token: string) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  const body = { clientRequestId: randomUUID().replaceAll('-', '') };
  const first = await call("/v1/device-pairings", body, "bootstrap-fixture");
  assert.equal(first.status, 200);
  const data = ((await first.json()) as any).data;
  assert.ok(data.devicePairingId);
  assert.ok(data.pollSecret);
  assert.match(data.qrUrl, /^https:\/\/companion\.example\.test\//);
  const retry = await call("/v1/device-pairings", body, "bootstrap-fixture");
  assert.deepEqual(((await retry.json()) as any).data, data);
  const poll = await call(
    `/v1/device-pairings/${data.devicePairingId}/poll`,
    { pollSecret: data.pollSecret },
    "bootstrap-fixture",
  );
  assert.equal(poll.status, 200);
  assert.equal(((await poll.json()) as any).data.status, "pending");
  assert.equal((await call("/v1/device-pairings", body, "wrong")).status, 401);
});
test("PG pairing full claim and confirm workflow", async (t) => {
  const url = process.env.COMPANION_PG_TEST_URL;
  if (!url) return t.skip("COMPANION_PG_TEST_URL not set");
  const db = new PostgresStore(url);
  await new PgBusinessRepository(db).migrate();
  const mail = {
    code: "",
    async send(_e: string, c: string) {
      this.code = c;
    },
  };
  const app = createPgApp(db, {
    publicBaseUrl: "https://companion.example.test",
    deviceBootstraps: { [randomUUID()]: "bootstrap-fixture" },
    mailProvider: mail,
  } as any);
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", () => r()));
  t.after(async () => {
    await new Promise<void>((r) => app.close(() => r()));
    await db.close();
  });
  const port = (app.address() as any).port;
  const call = async (path: string, body: any, token = "") =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  const email=`pair-full-${Date.now()}@test.invalid`;let r=await call('/v1/auth/email/start',{email});assert.equal(r.status,200);r=await call('/v1/auth/email/verify',{email,code:mail.code});assert.equal(r.status,200);const session=(await r.json() as any).data.sessionToken;r=await call('/v1/connectors/register',{name:'full'},session);assert.equal(r.status,200);const connector=(await r.json() as any).data;r=await call('/v1/pairings',{clientRequestId:'abcdefabcdefabcdefabcdefabcdefab'},connector.token);assert.equal(r.status,200);const pair=(await r.json() as any).data;assert.match(pair.code,/^\d{8}$/);r=await call('/v1/device-pairings',{clientRequestId:'fedcbafedcbafedcbafedcbafedcbafe'},'bootstrap-fixture');assert.equal(r.status,200);const device=(await r.json() as any).data;r=await call(`/v1/device-pairings/${device.devicePairingId}/claim`,{code:pair.code,challenge:new URL(device.qrUrl).searchParams.get('challenge')},session);assert.equal(r.status,200);r=await call(`/v1/device-pairings/${device.devicePairingId}/poll`,{pollSecret:device.pollSecret},'bootstrap-fixture');assert.equal(r.status,200);assert.equal((await r.json() as any).data.status,'approved');
  const confirmBody = { pollSecret: device.pollSecret, clientRequestId: '00112233445566778899aabbccddeeff' };
  const confirmed = await call(`/v1/device-pairings/${device.devicePairingId}/confirm`, confirmBody, 'bootstrap-fixture');
  assert.equal(confirmed.status, 200, await confirmed.clone().text());
  const binding = (await confirmed.json()).data;
  assert.ok(binding.bindingId && binding.bindingToken);
  assert.equal(binding.epoch, 1);
  const retry = await call(`/v1/device-pairings/${device.devicePairingId}/confirm`, confirmBody, 'bootstrap-fixture');
  assert.equal(retry.status, 200);
  assert.deepEqual((await retry.json()).data, binding);
  const stored = await db.pool.query('SELECT b.* FROM hc_bindings b JOIN hc_device_pairings p ON p.device_id=b.device_id WHERE p.id=$1', [device.devicePairingId]);
  assert.equal(stored.rowCount, 1);
  assert.equal(stored.rows[0].connector_id, connector.connectorId);
  const consumed = await db.pool.query('SELECT consumed_at FROM hc_pairings WHERE id=$1', [pair.pairingId]);
  assert.ok(consumed.rows[0].consumed_at);
  const recoverBody={clientRequestId:'ffeeddccbbaa99887766554433221100'};
  const recovered=await call('/v1/device/binding/recover',recoverBody,'bootstrap-fixture');
  assert.equal(recovered.status,200);const recovery=(await recovered.json() as any).data;assert.notEqual(recovery.bindingToken,binding.bindingToken);
  const oldAccess=await fetch(`http://127.0.0.1:${port}/v1/device/projects`,{headers:{authorization:`Bearer ${binding.bindingToken}`}});assert.equal(oldAccess.status,401);
  const newAccess=await fetch(`http://127.0.0.1:${port}/v1/device/projects`,{headers:{authorization:`Bearer ${recovery.bindingToken}`}});assert.equal(newAccess.status,200);
  const recoveryRetry=await call('/v1/device/binding/recover',recoverBody,'bootstrap-fixture');assert.deepEqual((await recoveryRetry.json() as any).data,recovery);
  await db.pool.query("UPDATE hc_bindings SET state='revoked' WHERE id=$1",[binding.bindingId]);const revoked=await call('/v1/device/binding/recover',{clientRequestId:'11223344556677889900aabbccddeeff'},'bootstrap-fixture');assert.equal((await revoked.json() as any).data.status,'unbound');
  const oldRecoveryAfterRevoke = await call('/v1/device/binding/recover', recoverBody, 'bootstrap-fixture');
  assert.equal((await oldRecoveryAfterRevoke.json()).data.status, 'unbound', 'old idempotency result must not restore revoked binding');
});
