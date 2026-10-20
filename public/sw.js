// Service worker do Copo Cheio: deixa o site instalável e guarda no aparelho SÓ arquivos públicos e estáticos (o JavaScript, o CSS e as imagens com
// nome versionado em /assets/ e as imagens do site). NUNCA guarda: páginas (HTML), respostas de /api/, acompanhamento de pedido, conta, painel,
// pagamento, nada com cookie ou dado de cliente. Tudo o que não é arquivo estático vai direto para a rede, como se este arquivo não existisse.
// Sem rede, só a navegação cai numa página simples de "sem conexão" (/offline.html); pedido e pagamento exigem conexão.
const CACHE = 'copocheio-static-v1';
const OFFLINE = '/offline.html';
const STATIC_DIRS = ['/assets/', '/img/', '/email/'];
const MAX_ENTRIES = 120; // a cada versão do site os arquivos de /assets/ mudam de nome; os antigos saem por aqui (os mais velhos primeiro)
const STATIC_FILES = ['/logo.png', '/logo-128.webp', '/logo-256.webp', '/logo-512.webp', '/gelo.webp', '/gelo-96.webp', '/gelo-192.webp', '/icon-32.png', '/icon-192.png', '/apple-touch-icon.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.add(OFFLINE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

function isStatic(url) {
  return url.origin === self.location.origin && (STATIC_FILES.includes(url.pathname) || STATIC_DIRS.some((dir) => url.pathname.startsWith(dir)));
}

function trim(cache) {
  return cache.keys().then((keys) => {
    const old = keys.filter((key) => new URL(key.url).pathname !== OFFLINE).slice(0, Math.max(0, keys.length - MAX_ENTRIES));
    return Promise.all(old.map((key) => cache.delete(key)));
  });
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match(OFFLINE).then((page) => page || Response.error())));
    return;
  }
  if (!isStatic(url)) return;
  event.respondWith(
    caches.open(CACHE).then((cache) =>
      cache.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((response) => {
            // Só respostas completas e públicas; nada com cookie.
            if (response.ok && response.status === 200 && !response.headers.has('set-cookie')) {
              cache.put(request, response.clone()).then(() => trim(cache));
            }
            return response;
          }),
      ),
    ),
  );
});
