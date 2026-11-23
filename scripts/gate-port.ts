import { createServer } from "node:net";

function probe(port: number) {
  return new Promise<number | undefined>((resolve, reject) => {
    const server = createServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") resolve(undefined);
      else reject(error);
    });
    server.listen(port, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

export async function freeGatePort() {
  const port = await probe(0);
  if (port !== undefined && port >= 5200 && port < 6000) return port;

  // The OS usually assigns ports above Chromium's safe 5200–5999 range.
  const start = Math.floor(Math.random() * 800);
  for (let i = 0; i < 800; i++) {
    const port = await probe(5200 + (start + i) % 800);
    if (port !== undefined) return port;
  }
  throw new Error("no free real-zeta gate port in 5200–5999");
}
