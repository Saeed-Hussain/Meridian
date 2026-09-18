/**
 * Run the introduction service.
 *
 *   PORT=8080 npm start --workspace @meridian/signal
 */

import { SignalServer } from './index.js';

const server = new SignalServer({
  port: Number(process.env.PORT ?? 8080),
  log: (message) => console.log(message),
});

console.log(`signalling on ws://localhost:${server.port}`);
console.log('this process never sees document text');

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await server.close();
    process.exit(0);
  });
}
