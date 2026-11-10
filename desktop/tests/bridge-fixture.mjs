import { createServer } from 'node:http';

// Native client fixture

const port = Number(process.argv[2] || 4319);
const token = 'native-fixture-token-not-a-real-credential';

if (!Number.isInteger(port) || port < 4310 || port > 4320) throw new Error('Invalid fixture port');

const server = createServer(async (request, response) => {
  response.setHeader('Content-Type', 'application/json');
  const chunks = [];

  for await (const chunk of request) chunks.push(chunk);

  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};

  if (request.headers.origin) { response.writeHead(403); response.end('{}'); return; }

  if (request.url === '/api/companion/pair' && request.method === 'POST') {
    if (body.code !== `${port}-12345678` || body.kind !== 'desktop') { response.writeHead(400); response.end('{}'); return; }

    response.end(JSON.stringify({ token, baseUrl: `http://127.0.0.1:${port}`, kind: 'desktop' }));
    return;
  }

  if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401); response.end('{}'); return; }

  if (request.url === '/api/companion/state') response.end(JSON.stringify({ paired: true, provider: 'openai', model: 'fixture', paused: false, context: null }));
  else if (request.url === '/api/companion/context' && body.source === 'desktop' && body.text === 'Current-window fixture') response.end(JSON.stringify({ ok: true, stored: true }));
  else if (request.url === '/api/companion/message' && body.text === 'Native bridge fixture message') response.end(JSON.stringify({ ok: true, messageId: 'fixture-message' }));
  else { response.writeHead(400); response.end(JSON.stringify({ message: 'Invalid native fixture request' })); }
});

server.listen(port, '127.0.0.1', () => process.stdout.write(`Native fixture http://127.0.0.1:${port}\n`));
