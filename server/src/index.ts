import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startGameServer } from './GameServer';

const here = dirname(fileURLToPath(import.meta.url));
const clientDist = resolve(here, '../../client/dist');
const port = Number(process.env.PORT) || 3001;

const server = await startGameServer({
  port,
  // In production the server also serves the built game, so one URL does everything.
  // In dev (--dev), Vite serves the client instead.
  staticDir: !process.argv.includes('--dev') && existsSync(clientDist) ? clientDist : undefined,
});

const shutdown = async () => {
  console.log('Shutting down…');
  await server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
