import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { renderPairingPage } from '../src/pairing-page.js';

test('phone pairing page confirms before consuming email code and claims with session bearer', async () => {
  const html = renderPairingPage('dp-test', '</script><img src=x>');
  assert.doesNotMatch(html, /window\.id/);
  assert.ok(html.includes("fetch('/v1/device-pairings/'+encodeURIComponent(id)+'/claim'"));
  assert.match(html, /已提交，请回设备按键确认/);
  assert.doesNotMatch(html, /<\/script><img src=x>/);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  const elements = new Map<string, any>();
  for (const selector of ['#email', '#email-code', '#computer-code', '#confirm', '#message', '#pair-form', '#send-code', '#claim']) elements.set(selector, { value: '', checked: false, textContent: '', addEventListener(_event: string, fn: Function) { this.handler = fn; }, handler: undefined });
  const calls: any[] = [];
  const context = {
    document: { querySelector(selector: string) { return elements.get(selector); } },
    fetch: async (url: string, init: any) => { calls.push({ url, init }); const failedClaim = url.endsWith('/claim') && calls.filter((x) => x.url.endsWith('/claim')).length === 1; return { ok: !failedClaim, async json() { return { data: { sessionToken: 'session-fixture' } }; } }; },
    encodeURIComponent,
  };
  vm.runInNewContext(script!, context);
  elements.get('#email').value = 'user@example.com';
  elements.get('#email-code').value = '123456';
  elements.get('#computer-code').value = '654321';
  await elements.get('#send-code').handler();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/v1/auth/email/start');
  await elements.get('#claim').handler();
  assert.equal(calls.length, 1);
  assert.equal(elements.get('#message').textContent, '请先勾选确认');
  elements.get('#confirm').checked = true;
  await elements.get('#claim').handler();
  assert.equal(calls.length, 3);
  assert.equal(calls[1].url, '/v1/auth/email/verify');
  assert.equal(calls[2].url, '/v1/device-pairings/dp-test/claim');
  assert.equal(calls[2].init.headers.authorization, 'Bearer session-fixture');
  assert.deepEqual(JSON.parse(calls[2].init.body), { code: '654321', challenge: '</script><img src=x>' });
  await elements.get('#claim').handler();
  assert.equal(calls.length, 4);
  assert.equal(calls[3].url, '/v1/device-pairings/dp-test/claim');
  assert.match(elements.get('#message').textContent, /回设备按键确认/);
});
