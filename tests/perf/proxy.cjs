// Proxy de medição: repassa para o servidor de teste e COMPRIME o texto (brotli, como a Vercel faz com JS, CSS, HTML e JSON), para o tempo de rede
// simulado refletir os bytes que de fato trafegam em produção. Imagens e vídeo passam como estão.
// usage: node tests/perf/proxy.cjs <porta-de-escuta> <porta-do-servidor>
const http = require('http');
const zlib = require('zlib');

const [listen, target] = process.argv.slice(2).map(Number);
if (!listen || !target) {
  console.error('uso: node tests/perf/proxy.cjs <porta-de-escuta> <porta-do-servidor>');
  process.exit(1);
}
const COMPRESSIBLE = /^(text\/|application\/(javascript|json|xml)|image\/svg)/i;

http
  .createServer((req, res) => {
    const up = http.request({ host: '127.0.0.1', port: target, method: req.method, path: req.url, headers: { ...req.headers, host: `127.0.0.1:${target}`, 'accept-encoding': 'identity' } }, (r) => {
      const type = String(r.headers['content-type'] ?? '');
      const wantsBr = /\bbr\b/.test(String(req.headers['accept-encoding'] ?? ''));
      if (!(wantsBr && COMPRESSIBLE.test(type))) {
        res.writeHead(r.statusCode, r.headers);
        return r.pipe(res);
      }
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => {
        const body = Buffer.concat(chunks);
        const headers = { ...r.headers, 'content-encoding': 'br', vary: 'Accept-Encoding' };
        delete headers['content-length'];
        if (body.length < 512) {
          delete headers['content-encoding'];
          res.writeHead(r.statusCode, { ...headers, 'content-length': body.length });
          return res.end(body);
        }
        const out = zlib.brotliCompressSync(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 6 } });
        res.writeHead(r.statusCode, { ...headers, 'content-length': out.length });
        res.end(out);
      });
    });
    up.on('error', () => res.writeHead(502).end());
    req.pipe(up);
  })
  .listen(listen, '127.0.0.1', () => console.log(`proxy ${listen} -> ${target}`));
