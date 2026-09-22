import { createServer, request } from 'node:http';
import { connect } from 'node:net';

const hcPath = (path) => path === '/v1' || path.startsWith('/v1/') || path === '/pair' || path === '/healthz';

export function createGateway({ listenHost = '127.0.0.1', listenPort = 3002, hcHost = '127.0.0.1', hcPort = 3020, bookHost = '127.0.0.1', bookPort = 3004 } = {}) {
  const target = (req) => hcPath(new URL(req.url ?? '/', 'http://gateway').pathname)
    ? { host: hcHost, port: hcPort } : { host: bookHost, port: bookPort };
  const server = createServer((req, res) => {
    const upstream = target(req);
    const upstreamRequest = request({ hostname: upstream.host, port: upstream.port, path: req.url ?? '/', method: req.method, headers: { ...req.headers, host: `${upstream.host}:${upstream.port}` } });
    upstreamRequest.on('response', (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    });
    upstreamRequest.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }); res.end('upstream unavailable'); });
    req.pipe(upstreamRequest);
  });
  server.on('upgrade', (req, socket, head) => {
    const upstream = target(req);
    const peer = connect(upstream.port, upstream.host);
    const fail = () => { socket.destroy(); peer.destroy(); };
    peer.once('error', fail);
    peer.once('connect', () => {
      const headers = [];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i];
        if (name.toLowerCase() !== 'host') headers.push(`${name}: ${req.rawHeaders[i + 1]}`);
      }
      headers.push(`Host: ${upstream.host}:${upstream.port}`);
      peer.write(`GET ${req.url ?? '/'} HTTP/${req.httpVersion}\r\n${headers.join('\r\n')}\r\n\r\n`);
      if (head.length) peer.write(head);
      peer.pipe(socket); socket.pipe(peer);
    });
  });
  if (listenPort !== false) server.listen(listenPort, listenHost);
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 3002);
  createGateway({ listenPort: port });
  console.log(`shared-domain-gateway listening on 127.0.0.1:${port}`);
}
