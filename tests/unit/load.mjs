// Carrega um módulo TypeScript do projeto para os testes unitários: o esbuild empacota o arquivo (sem tocar em nada do projeto) e o
// teste importa o resultado. As bibliotecas de node_modules ficam de fora do pacote (são resolvidas normalmente).
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const outDir = join(here, '.build');
mkdirSync(outDir, { recursive: true });

let counter = 0;
export async function load(relativePath) {
  const outfile = join(outDir, `${basename(relativePath).replace(/\W/g, '_')}-${process.pid}-${counter++}.mjs`);
  await build({
    entryPoints: [join(root, relativePath)],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    jsx: 'automatic',
    logLevel: 'silent',
  });
  return import(pathToFileURL(outfile).href);
}

export const ROOT = root;
