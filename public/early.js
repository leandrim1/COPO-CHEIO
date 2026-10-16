// Pedido adiantado do cardápio e dos textos do site (ver index.html e `fetchShop` em src/site/data.tsx). Fica com este nome e este formato
// (window.__copoEarly = { products, site }, duas promessas de Response) porque o navegador pode guardá-lo por até um dia: o site tem de
// continuar entendendo esta versão.
//
// Também abre, antes de qualquer foto ser pedida, a conexão com o armazenamento das imagens (Vercel Blob, outro endereço que o do site):
// DNS + conexão + TLS levam de 2 a 3 idas e voltas (uns 300 a 450 ms numa rede 4G) e, sem isto, só começavam quando o site já tinha
// aparecido e pedia a primeira foto. O endereço vem do que a pessoa viu na última visita (cópia guardada no navegador) ou, na primeira
// visita, da própria resposta do cardápio.
try {
  if (!/^\/admin(\/|$)/.test(location.pathname)) {
    var get = function (path) {
      return fetch(path, { credentials: 'same-origin' });
    };
    var early = (window.__copoEarly = { products: get('/api/products'), site: get('/api/site') });
    // Falha de rede não vira "erro sem tratamento": quem usa a resposta trata a falha e pede de novo.
    early.products.catch(function () {});
    early.site.catch(function () {});

    var BLOB = /https:\/\/[a-z0-9.-]+\.blob\.vercel-storage\.com/i;
    var opened = false;
    var preconnect = function (text) {
      var found = BLOB.exec(text || '');
      if (opened || !found) return;
      opened = true;
      var link = document.createElement('link');
      link.rel = 'preconnect';
      link.href = found[0];
      document.head.appendChild(link);
    };
    try {
      preconnect(localStorage.getItem('copocheio:site-v4'));
    } catch (error) {
      /* navegador sem armazenamento local (modo privado): segue pela resposta do cardápio */
    }
    // `clone()`: o site continua lendo a resposta original, que não é tocada.
    [early.products, early.site].forEach(function (promise) {
      promise
        .then(function (response) {
          return response.ok && !opened ? response.clone().text() : '';
        })
        .then(preconnect)
        .catch(function () {});
    });

    // Foto principal da página (a que costuma definir o LCP): sem isto o navegador só a descobre depois que o JavaScript rodou e o React desenhou a tela,
    // bem depois de a resposta dos textos já estar aqui. Aqui ela é pedida já, com prioridade alta, pelo MESMO endereço que o site vai usar (mesma regra do
    // <picture> da capa e do carrossel do cardápio e da 1ª bebida da página inicial); se o site acabar usando outra, o pedido é só uma foto a mais. Só na
    // página inicial e em /bebidas; nas outras páginas não há foto principal para adiantar.
    var path = location.pathname.replace(/\/+$/, '') || '/';
    if (path === '/' || path === '/bebidas') {
      var SAFE = /^(?:https:\/\/|\/(?!\/))[^\s"'<>]+$/; // https ou um caminho do próprio site; nada além disso vira endereço de pedido
      var preloadImage = function (href, media) {
        if (typeof href !== 'string' || !SAFE.test(href)) return;
        var link = document.createElement('link');
        link.rel = 'preload';
        link.as = 'image';
        link.href = href;
        if (media) link.media = media;
        link.fetchPriority = 'high';
        document.head.appendChild(link);
      };
      // Foto de celular só abaixo de 640 px e a outra de 640 px para cima, como no <picture> do site (sem foto de celular, a mesma para todos).
      var preloadBanner = function (banner) {
        var mobile = banner.image_mobile_url;
        var main = banner.image_desktop_url || mobile;
        if (mobile && main !== mobile) {
          preloadImage(mobile, '(max-width: 639px)');
          preloadImage(main, '(min-width: 640px)');
        } else {
          preloadImage(main);
        }
      };
      var hasImage = function (banner) {
        return banner && (banner.image_desktop_url || banner.image_mobile_url);
      };
      // A foto só começa a baixar quando o pacote principal do site terminou de baixar: enquanto ele baixa, a foto (alta prioridade, centenas de KB) dividiria a
      // rede com ele e atrasaria o primeiro desenho da página (medido: +0,4 s no 4G lento). Depois, o navegador só faz contas (rodar o JavaScript, que leva uns
      // 0,4 s num celular de entrada), a rede fica livre e a foto baixa nesse tempo. Sem como saber (navegador sem esse recurso), pede na hora; e há um prazo de 2,5 s.
      var afterBundle = function (callback) {
        var called = false;
        var go = function () {
          if (!called) {
            called = true;
            callback();
          }
        };
        try {
          new PerformanceObserver(function (list) {
            list.getEntries().forEach(function (entry) {
              if (/\/assets\/[^?#]*\.js(?:[?#]|$)/.test(entry.name)) go();
            });
          }).observe({ type: 'resource', buffered: true });
          setTimeout(go, 2500);
        } catch (error) {
          go();
        }
      };
      early.site
        .then(function (response) {
          return response.ok ? response.clone().json() : null;
        })
        .then(function (site) {
          if (!site) return;
          afterBundle(function () {
            if (path === '/bebidas') {
              var cover = (site.cover_banners || []).filter(hasImage)[0]; // 1º slide da capa
              if (cover) preloadBanner(cover);
              var menu = (site.banners || [])[0]; // 1º slide do carrossel do cardápio
              if (hasImage(menu)) preloadBanner(menu);
            } else {
              var images = site.hero && site.hero.images;
              preloadImage(images && images.length ? images[0] : '/img/frozen-rosa.webp'); // sem fotos no painel, as bebidas de sempre (DRINKS, em App.tsx)
            }
          });
        })
        .catch(function () {});
    }
  }
} catch (error) {
  /* sem isto o site só pede os dados depois, como sempre */
}
