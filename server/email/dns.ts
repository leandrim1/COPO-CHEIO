// Confere no DNS se o domínio do remetente está preparado para e-mail: SPF, DKIM e DMARC (e MX). Só LÊ o DNS público do domínio; não
// altera nada. As análises (`analyzeSpf`, `analyzeDmarc`) são funções puras, testadas sem rede.
//
// Limites que o painel explica com franqueza:
//  • DKIM: o nome da chave (o "seletor") é escolhido pelo provedor de e-mail e não dá para listá-los. Tentamos os nomes mais comuns; se
//    nenhum aparecer, isso NÃO prova que não existe. O jeito certo de confirmar é o cabeçalho de um e-mail real (docs/EMAIL.md).
//  • SPF/DKIM/DMARC bons no DNS não garantem caixa de entrada: reputação e conteúdo também contam. Isto só mostra se a base está certa.
import { Resolver } from 'node:dns/promises';

export type Level = 'ok' | 'info' | 'warning' | 'error';
export type Finding = { level: Level; text: string };

export type DnsResolver = {
  resolveTxt(name: string): Promise<string[][]>;
  resolveCname(name: string): Promise<string[]>;
  resolveMx(name: string): Promise<{ exchange: string; priority: number }[]>;
};

export type DnsReport = {
  domain: string;
  checked_at: string;
  spf: { record: string | null; findings: Finding[] };
  dkim: { found: { selector: string; via: 'txt' | 'cname' }[]; tried: string[]; findings: Finding[] };
  dmarc: { record: string | null; policy: string | null; findings: Finding[] };
  mx: { hosts: string[]; findings: Finding[] };
  // Resumo: ok = base certa; attention = falta algo recomendado; problem = falta algo essencial ou há erro; unknown = o DNS não respondeu.
  status: 'ok' | 'attention' | 'problem' | 'unknown';
};

// Nomes de seletor DKIM mais comuns (Google Workspace, Microsoft 365, Mailchimp/Mandrill, SendGrid, Resend, Brevo, Zoho, genéricos).
export const COMMON_DKIM_SELECTORS = ['google', 'selector1', 'selector2', 'default', 'dkim', 'mail', 's1', 's2', 'k1', 'k2', 'k3', 'resend', 'brevo1', 'brevo2', 'zoho', 'smtp', 'mandrill', 'mxvault', 'sendgrid'];

// ---- SPF ----------------------------------------------------------------------------------------------

const LOOKUP_TERMS = /^[+\-~?]?(include:|a(:|\/|$)|mx(:|\/|$)|ptr(:|$)|exists:|redirect=)/i;

export function analyzeSpf(txtRecords: string[]): { record: string | null; findings: Finding[] } {
  const spf = txtRecords.filter((r) => /^v=spf1(\s|$)/i.test(r.trim()));
  if (spf.length === 0) {
    return { record: null, findings: [{ level: 'error', text: 'Não há registro SPF (um registro TXT que começa com "v=spf1"). Sem ele, os provedores desconfiam de e-mails enviados em nome do domínio. O valor certo é o que o seu provedor de e-mail indica: copie dele, não invente.' }] };
  }
  if (spf.length > 1) {
    return { record: spf[0], findings: [{ level: 'error', text: `Há ${spf.length} registros SPF no mesmo domínio. Só pode haver um: com mais de um, os provedores ignoram o SPF inteiro. Junte tudo num registro só.` }] };
  }
  const record = spf[0].trim();
  const terms = record.split(/\s+/).slice(1);
  const findings: Finding[] = [];
  const all = terms.find((t) => /^[+\-~?]?all$/i.test(t));
  const hasRedirect = terms.some((t) => /^redirect=/i.test(t));
  if (all) {
    const q = /^[+\-~?]/.test(all) ? all[0] : '+';
    if (q === '+') findings.push({ level: 'error', text: 'O SPF termina em "+all": qualquer servidor do mundo passa como se fosse o seu. Troque por "~all" (ou "-all" quando tiver certeza de todos os remetentes).' });
    else if (q === '?') findings.push({ level: 'warning', text: 'O SPF termina em "?all" (neutro): não protege. Prefira "~all" ou "-all".' });
    else findings.push({ level: 'ok', text: q === '-' ? 'SPF presente e restritivo ("-all").' : 'SPF presente ("~all": falha leve; é o usual para começar).' });
  } else if (!hasRedirect) {
    findings.push({ level: 'warning', text: 'O SPF não termina com "all" (nem usa "redirect="): o que não está na lista fica sem decisão. Termine com "~all" ou "-all".' });
  } else {
    findings.push({ level: 'ok', text: 'SPF presente (delega a outro domínio com "redirect=").' });
  }
  // O SPF permite no máximo 10 consultas de DNS (include, a, mx, ptr, exists, redirect), contando as que estão dentro dos "include". Aqui só
  // dá para contar as do próprio registro; as de dentro dos includes ficam de fora.
  const lookups = terms.filter((t) => LOOKUP_TERMS.test(t)).length;
  if (lookups > 10) findings.push({ level: 'error', text: `O SPF tem ${lookups} consultas de DNS só no próprio registro; o limite é 10 (somando as dos "include"). Acima disso o SPF falha. Remova serviços que você não usa mais.` });
  else if (lookups >= 8) findings.push({ level: 'warning', text: `O SPF já usa ${lookups} das 10 consultas de DNS permitidas (sem contar as de dentro dos "include"). Cuidado ao acrescentar serviços.` });
  if (terms.some((t) => /^[+\-~?]?ptr(:|$)/i.test(t))) findings.push({ level: 'warning', text: 'O mecanismo "ptr" está obsoleto e lento; remova-o.' });
  return { record, findings };
}

// ---- DMARC --------------------------------------------------------------------------------------------

export function parseTags(record: string): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const part of record.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) tags[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
  }
  return tags;
}

export function analyzeDmarc(txtRecords: string[]): { record: string | null; policy: string | null; findings: Finding[] } {
  const found = txtRecords.filter((r) => /^v=DMARC1\s*(;|$)/i.test(r.trim()));
  if (found.length === 0) {
    return {
      record: null,
      policy: null,
      findings: [{ level: 'warning', text: 'Não há registro DMARC. Gmail e Yahoo passaram a exigir DMARC de quem envia muitos e-mails, e ele protege o domínio contra falsificação. Comece só monitorando: crie um TXT em "_dmarc.seudominio" com "v=DMARC1; p=none; rua=mailto:um-endereco-seu@seudominio" (p=none não bloqueia nada, apenas gera relatórios).' }],
    };
  }
  if (found.length > 1) return { record: found[0], policy: null, findings: [{ level: 'error', text: `Há ${found.length} registros DMARC. Só pode haver um; com mais de um, o DMARC é ignorado.` }] };
  const record = found[0].trim();
  const tags = parseTags(record);
  const policy = (tags.p ?? '').toLowerCase() || null;
  const findings: Finding[] = [];
  if (policy === 'none') findings.push({ level: 'info', text: 'DMARC em modo de monitoramento (p=none): é o certo para começar. Depois de algumas semanas de relatórios sem e-mails legítimos reprovados, dá para endurecer para "quarantine" e depois "reject"; essa decisão é sua.' });
  else if (policy === 'quarantine' || policy === 'reject') findings.push({ level: 'ok', text: `DMARC ativo com política "${policy}".` });
  else findings.push({ level: 'error', text: 'O DMARC não tem uma política válida (p=none, quarantine ou reject).' });
  if (!tags.rua) findings.push({ level: 'info', text: 'Sem "rua=": você não vai receber os relatórios agregados do DMARC, que mostram quem está enviando e-mail em nome do seu domínio.' });
  const pct = tags.pct ? Number(tags.pct) : 100;
  if (Number.isFinite(pct) && pct < 100) findings.push({ level: 'info', text: `A política vale só para ${pct}% das mensagens (pct=${pct}).` });
  return { record, policy, findings };
}

// ---- Consultas ------------------------------------------------------------------------------------------

const MISSING = new Set(['ENOTFOUND', 'ENODATA']);

async function safe<T>(fn: () => Promise<T>): Promise<{ value: T | null; failed: boolean }> {
  try {
    return { value: await fn(), failed: false };
  } catch (error) {
    // Não existe (NXDOMAIN / sem dados) é uma resposta; qualquer outra coisa (tempo esgotado, servidor de DNS com erro) é "não sei".
    return { value: null, failed: !MISSING.has((error as { code?: string }).code ?? '') };
  }
}

const joinTxt = (records: string[][] | null): string[] => (records ?? []).map((chunks) => chunks.join(''));

export const defaultResolver = (): DnsResolver => new Resolver({ timeout: 3000, tries: 1 }) as unknown as DnsResolver;

export async function checkDomainDns(domain: string, opts: { resolver?: DnsResolver; selectors?: string[]; now?: Date } = {}): Promise<DnsReport> {
  const resolver = opts.resolver ?? defaultResolver();
  const selectors = opts.selectors?.length ? opts.selectors : COMMON_DKIM_SELECTORS;
  const [txt, dmarcTxt, mx] = await Promise.all([safe(() => resolver.resolveTxt(domain)), safe(() => resolver.resolveTxt(`_dmarc.${domain}`)), safe(() => resolver.resolveMx(domain))]);
  const dkimResults = await Promise.all(
    selectors.map(async (selector) => {
      const name = `${selector}._domainkey.${domain}`;
      const t = await safe(() => resolver.resolveTxt(name));
      const records = joinTxt(t.value);
      if (records.some((r) => /v=DKIM1/i.test(r) || /(^|;)\s*p=/i.test(r))) return { selector, via: 'txt' as const, failed: false };
      const c = await safe(() => resolver.resolveCname(name));
      if (c.value && c.value.length) return { selector, via: 'cname' as const, failed: false };
      return { selector, via: null, failed: t.failed || c.failed };
    }),
  );

  const spf = txt.failed ? { record: null, findings: [{ level: 'info' as const, text: 'Não foi possível consultar o DNS agora. Tente de novo em instantes.' }] } : analyzeSpf(joinTxt(txt.value));
  const dmarc = dmarcTxt.failed ? { record: null, policy: null, findings: [{ level: 'info' as const, text: 'Não foi possível consultar o DNS agora. Tente de novo em instantes.' }] } : analyzeDmarc(joinTxt(dmarcTxt.value));

  const foundKeys = dkimResults.filter((r) => r.via).map((r) => ({ selector: r.selector, via: r.via as 'txt' | 'cname' }));
  const dkimFindings: Finding[] = foundKeys.length
    ? [{ level: 'ok', text: `Chave DKIM encontrada (${foundKeys.map((k) => k.selector).join(', ')}). Isto mostra que a chave existe no DNS; só o cabeçalho de um e-mail real prova que as mensagens da loja estão sendo assinadas com ela.` }]
    : [
        {
          level: 'warning',
          text: dkimResults.every((r) => r.failed)
            ? 'Não foi possível consultar o DNS agora. Tente de novo em instantes.'
            : 'Não encontrei chave DKIM nos nomes mais comuns. Isso NÃO prova que não exista: cada provedor escolhe o nome (seletor) e eu não consigo listá-los. Veja no painel do seu provedor de e-mail o nome exato, ou confira o cabeçalho de um e-mail real (docs/EMAIL.md).',
        },
      ];

  const mxHosts = (mx.value ?? []).slice().sort((a, b) => a.priority - b.priority).map((m) => m.exchange).filter(Boolean);
  const mxFindings: Finding[] = mx.failed
    ? [{ level: 'info', text: 'Não foi possível consultar o DNS agora.' }]
    : mxHosts.length
      ? [{ level: 'ok', text: 'O domínio recebe e-mail (tem MX): respostas e avisos de devolução conseguem chegar.' }]
      : [{ level: 'warning', text: 'O domínio não tem MX: respostas dos clientes e avisos de devolução não chegam. Se você usa o e-mail do domínio (Google Workspace, Zoho, Microsoft 365...), confira o MX.' }];

  const all = [...spf.findings, ...dkimFindings, ...dmarc.findings, ...mxFindings];
  const unknown = txt.failed && dmarcTxt.failed;
  const status: DnsReport['status'] = unknown ? 'unknown' : all.some((f) => f.level === 'error') || !spf.record ? 'problem' : all.some((f) => f.level === 'warning') ? 'attention' : 'ok';
  return {
    domain,
    checked_at: (opts.now ?? new Date()).toISOString(),
    spf,
    dkim: { found: foundKeys, tried: selectors, findings: dkimFindings },
    dmarc,
    mx: { hosts: mxHosts.slice(0, 5), findings: mxFindings },
    status,
  };
}
