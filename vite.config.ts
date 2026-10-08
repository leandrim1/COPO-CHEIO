import { defineConfig, loadEnv } from 'vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Em desenvolvimento, atende /api/* com a mesma função que a Vercel executa (api/index.ts).
// As variáveis do servidor (DATABASE_URL, BLOB_READ_WRITE_TOKEN) vêm do .env.local — `vercel env pull .env.local`.
// Elas não têm o prefixo VITE_, então nunca chegam ao código do navegador.
function devApi(): Plugin {
  return {
    name: 'copocheio-dev-api',
    apply: 'serve',
    configureServer(server) {
      process.env = { ...loadEnv(server.config.mode, server.config.root, ''), ...process.env };
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/')) return next();
        try {
          const { default: handler } = await server.ssrLoadModule('/api/index.ts');
          await handler(req, res);
        } catch (error) {
          server.ssrFixStacktrace(error as Error);
          console.error(error);
          res.statusCode = 500;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: 'Erro interno.' }));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), devApi()],
});
