// Imita o endpoint HTTP /sql do Neon em cima de um Postgres local (só para testes aqui).
import http from 'node:http';
import pg from 'pg';

export function startNeonProxy({ connectionString, port = 5444 }) {
  const pool = new pg.Pool({ connectionString, max: 20 });
  const textTypes = { getTypeParser: () => (v) => v };
  const run = async (client, q) => {
    const r = await client.query({ text: q.query, values: q.params ?? [], rowMode: 'array', types: textTypes });
    return {
      command: r.command,
      rowCount: r.rowCount,
      rows: r.rows,
      fields: r.fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID, tableID: f.tableID, columnID: f.columnID, dataTypeSize: f.dataTypeSize, dataTypeModifier: f.dataTypeModifier, format: 'text' })),
      rowAsArray: true,
    };
  };
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/sql') {
      res.writeHead(404).end();
      return;
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const client = await pool.connect();
    try {
      let out;
      if (body.queries) {
        await client.query('begin');
        try {
          const results = [];
          for (const q of body.queries) results.push(await run(client, q));
          await client.query('commit');
          out = { results };
        } catch (e) {
          await client.query('rollback');
          throw e;
        }
      } else out = await run(client, body);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
    } catch (e) {
      const keys = ['severity', 'code', 'detail', 'hint', 'position', 'internalPosition', 'internalQuery', 'where', 'schema', 'table', 'column', 'dataType', 'constraint', 'file', 'line', 'routine'];
      const err = { message: e.message };
      for (const k of keys) err[k] = e[k];
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify(err));
    } finally {
      client.release();
    }
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, pool, port })));
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const connectionString = process.env.TEST_PG_URL ?? 'postgres://postgres@127.0.0.1:5433/copocheio_test';
  const { port } = await startNeonProxy({ connectionString });
  console.log('neon proxy on', port);
}
