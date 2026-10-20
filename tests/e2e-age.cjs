// Pergunta de maioridade (18+) nos testes de navegador. O site pergunta "Tenho 18 anos ou mais" na entrada de /, /bebidas e /checkout e, no checkout, pede a
// declaração quando há bebida alcoólica no pedido. As suítes que não tratam disso respondem como uma pessoa responderia (o mesmo que o clique em "Tenho 18
// anos ou mais" grava no aparelho e a caixa marcada no checkout), para seguirem o fluxo de compra de sempre. Só e2e-agegate.cjs testa a pergunta em si.
//   require('./e2e-age.cjs').patchBrowser(browser)   logo depois de `chromium.launch()`
const KEY = 'copocheio:age-v1'; // a mesma chave e versão de AGE_TEXT_VERSION em src/site/AgeGate.tsx

function onEveryPage({ key, declare }) {
  try {
    localStorage.setItem(key, '1');
  } catch {
    /* sem armazenamento */
  }
  if (!declare) return;
  // A caixa "Declaro que tenho 18 anos ou mais" do checkout: marcada assim que aparece (um toque de verdade, que aciona o React).
  const mark = () => {
    const box = document.querySelector('[data-age-confirm]');
    if (box && !box.checked) box.click();
  };
  new MutationObserver(mark).observe(document, { childList: true, subtree: true });
}

function patchBrowser(browser, { declare = true } = {}) {
  const args = { key: KEY, declare };
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...rest) => {
    const context = await newContext(...rest);
    await context.addInitScript(onEveryPage, args);
    return context;
  };
  const newPage = browser.newPage.bind(browser);
  browser.newPage = async (...rest) => {
    const page = await newPage(...rest);
    await page.context().addInitScript(onEveryPage, args);
    return page;
  };
  return browser;
}

module.exports = { patchBrowser, AGE_KEY: KEY };
