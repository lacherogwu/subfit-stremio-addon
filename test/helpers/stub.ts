import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Stub {
  url: string;
  requests: string[];
  close: () => Promise<void>;
}

/**
 * A tiny HTTP stub, so the unit tests never touch the network. A route value that is a
 * number is served as that status code, which is how the failure paths are exercised.
 */
export async function startStub(routes: Record<string, unknown>): Promise<Stub> {
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    const path = req.url ?? '';
    requests.push(path);
    const key = Object.keys(routes).find((k) => path.startsWith(k));
    const value = key === undefined ? undefined : routes[key];
    if (value === undefined) {
      res.writeHead(404).end('not found');
      return;
    }
    if (typeof value === 'number') {
      res.writeHead(value).end('upstream said no');
      return;
    }
    if (Buffer.isBuffer(value)) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(value);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
