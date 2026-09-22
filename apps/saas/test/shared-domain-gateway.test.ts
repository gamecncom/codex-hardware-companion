import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { createGateway } from '../deploy/shared-domain-gateway.mjs';

const listen = async (server: any) => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port as number; };
const close = async (server: any) => { if (server.listening) { server.close(); await once(server, 'close'); } };

test('shared gateway routes HTTP and websocket traffic to the correct backend', async (t) => {
  const seen: { hc?: string; book?: string } = {};
  const hc = createServer((req, res) => { let body = ''; req.on('data', c => body += c); req.on('end', () => { seen.hc = `${req.url}:${body}`; res.writeHead(207, { 'content-type': 'application/x-hc' }); res.end('hc-response'); }); });
  const book = createServer((req, res) => { let body = ''; req.on('data', c => body += c); req.on('end', () => { seen.book = `${req.url}:${body}`; res.writeHead(208, { 'content-type': 'application/x-book' }); res.end('book-response'); }); });
  const wss = new WebSocketServer({ noServer: true });
  hc.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws)));
  wss.on('connection', ws => ws.on('message', data => ws.send(data)));
  const hp = await listen(hc), bp = await listen(book);
  const gateway = createGateway({ listenPort: false, hcPort: hp, bookPort: bp });
  const gp = await listen(gateway);
  t.after(async () => { wss.close(); await close(gateway); await close(hc); await close(book); });

  const hcResponse = await fetch(`http://127.0.0.1:${gp}/v1/device/state?x=1`, { method: 'POST', body: 'hc-body' });
  assert.equal(hcResponse.status, 207); assert.equal(hcResponse.headers.get('content-type'), 'application/x-hc'); assert.equal(await hcResponse.text(), 'hc-response');
  const bookResponse = await fetch(`http://127.0.0.1:${gp}/api/asset?id=2`, { method: 'POST', body: 'book-body' });
  assert.equal(bookResponse.status, 208); assert.equal(bookResponse.headers.get('content-type'), 'application/x-book'); assert.equal(await bookResponse.text(), 'book-response');
  assert.equal(seen.hc, '/v1/device/state?x=1:hc-body'); assert.equal(seen.book, '/api/asset?id=2:book-body');

  const ws = new WebSocket(`ws://127.0.0.1:${gp}/v1/connectors/channel`);
  await once(ws, 'open'); ws.send('echo-through-gateway');
  const [message] = await once(ws, 'message');
  assert.equal(message.toString(), 'echo-through-gateway'); ws.close(); await once(ws, 'close');
});
