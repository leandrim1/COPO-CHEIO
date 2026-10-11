// node tests/with-neon-proxy.mjs <script.mjs> [args]: sobe o proxy, aponta o driver para ele e roda o script.
import { neonConfig } from '@neondatabase/serverless';
import { startNeonProxy } from './neon-proxy.mjs';

const pgUrl = process.env.TEST_PG_URL ?? 'postgres://postgres@127.0.0.1:5433/copocheio_test';
const { server, pool, port } = await startNeonProxy({ connectionString: pgUrl, port: 0 });
const actualPort = server.address().port;
neonConfig.fetchEndpoint = () => `http://127.0.0.1:${actualPort}/sql`;
process.env.DATABASE_URL = 'postgresql://user:pass@ep-test.neon.local/neondb?sslmode=require';
const script = process.argv[2];
process.argv.splice(1, 2, script);
try {
  await import(new URL(script.startsWith('/') ? script : '../' + script, import.meta.url).href);
} finally {
  server.close();
  await pool.end();
}
