/**
 * Run the introduction service.
 *
 *   npm run signal
 *   PORT=9000 npm run signal
 */

import { SignalServer } from './index.js';

const port = Number(process.env.PORT ?? 8080);

const server = new SignalServer({
  port,
  log: (message) => console.log(message),
});

// Wait for the socket to actually be listening before reporting the port.
// Asking earlier gets nothing -- the address is not assigned yet -- which
// printed the useless "ws://localhost:0".
server.wss.on('listening', () => {
  console.log(`signalling on ws://localhost:${server.port}`);
  console.log('this process never sees document text');
});

// A port already in use is the ordinary way this fails, usually because a
// previous run is still going. A stack trace buries that, so say it plainly
// and say what to do about it.
server.wss.on('error', (error) => {
  if (/** @type {any} */ (error).code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use.`);
    console.error('Something else is running there — most likely an earlier');
    console.error('signalling server that was never stopped.');
    console.error('');
    console.error('Find it:   npx kill-port 8080');
    console.error('Or use another port, and tell the app where it is:');
    console.error('    PORT=9000 npm run signal');
    console.error('    NEXT_PUBLIC_SIGNAL_URL=ws://localhost:9000 npm run web');
    process.exit(1);
  }
  console.error(error);
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await server.close();
    process.exit(0);
  });
}
