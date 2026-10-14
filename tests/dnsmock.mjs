// DNS de mentira para os testes (este ambiente não tem DNS de verdade). Troca os métodos do Resolver do Node,
// que é exatamente o que server/mailDomain.ts usa. Domínio que não está na tabela "tem MX" (o caso comum).
import { Resolver } from 'node:dns/promises';

const err = (code) => Object.assign(new Error(`${code} (simulado)`), { code });

// tipo → resposta: array (dados) | 'NX' (não existe) | 'NODATA' | código de erro (ex.: 'ESERVFAIL', 'ETIMEOUT')
export const DOMAINS = {
  'sem-mx-com-a.com.br': { mx: 'NODATA', a: ['203.0.113.10'], aaaa: 'NODATA' },
  'so-ipv6.com.br': { mx: 'NODATA', a: 'NODATA', aaaa: ['2001:db8::1'] },
  'dominio-inexistente-xyz.com': { mx: 'NX', a: 'NX', aaaa: 'NX' },
  'outro-dominio-inexistente.com.br': { mx: 'NX', a: 'NX', aaaa: 'NX' },
  'sem-registros.com.br': { mx: 'NODATA', a: 'NODATA', aaaa: 'NODATA' },
  'mxnulo.com.br': { mx: [{ exchange: '', priority: 0 }], a: 'NODATA', aaaa: 'NODATA' },
  'mxnulo-ponto.com.br': { mx: [{ exchange: '.', priority: 0 }], a: 'NODATA', aaaa: 'NODATA' },
  'dns-quebrado.com.br': { mx: 'ESERVFAIL', a: 'ESERVFAIL', aaaa: 'ESERVFAIL' },
  'dns-lento.com.br': { mx: 'ETIMEOUT', a: 'ETIMEOUT', aaaa: 'ETIMEOUT' },
  'so-nxdomain-no-mx.com.br': { mx: 'NX', a: 'ESERVFAIL', aaaa: 'NODATA' },
};

// Registros TXT e CNAME (a conferência de SPF/DKIM/DMARC do painel). Nome que não está aqui "não existe". Os testes mudam estas tabelas
// pela rota /__dns do servidor de teste. Valores como os de um domínio bem configurado; o remetente dos testes é loja@copocheio.test.
export const TXT = {};
export const CNAME = {};
export const MX_OF = {};
export function resetRecords() {
  for (const t of [TXT, CNAME, MX_OF]) for (const k of Object.keys(t)) delete t[k];
  Object.assign(TXT, {
    'copocheio.test': ['v=spf1 include:_spf.copocheio.test ~all'],
    '_dmarc.copocheio.test': ['v=DMARC1; p=none; rua=mailto:dmarc@copocheio.test'],
    'selector1._domainkey.copocheio.test': ['v=DKIM1; k=rsa; p=' + 'A'.repeat(220)],
  });
  Object.assign(MX_OF, { 'copocheio.test': [{ exchange: 'mx.copocheio.test', priority: 10 }] });
}
resetRecords();

export function installDnsMock({ broken = false } = {}) {
  const answer = (domain, type) => {
    if (broken) throw err('ENOTFOUND'); // o DNS inteiro "caiu": até gmail.com não resolve
    const entry = DOMAINS[domain];
    if (type === 'mx' && MX_OF[domain] !== undefined) return MX_OF[domain];
    const value = entry ? entry[type] : type === 'mx' ? [{ exchange: `mx.${domain}`, priority: 10 }] : type === 'a' ? ['198.51.100.7'] : 'NODATA';
    if (value === 'NX') throw err('ENOTFOUND');
    if (value === 'NODATA') throw err('ENODATA');
    if (typeof value === 'string') throw err(value);
    return value;
  };
  Resolver.prototype.resolveMx = async (domain) => answer(domain, 'mx');
  Resolver.prototype.resolve4 = async (domain) => answer(domain, 'a');
  Resolver.prototype.resolve6 = async (domain) => answer(domain, 'aaaa');
  const lookup = (table, name) => {
    if (broken) throw err('ETIMEOUT');
    if (!table[name]) throw err('ENOTFOUND');
    return table[name];
  };
  // TXT longo vem em pedaços de até 255 caracteres, como no DNS de verdade.
  Resolver.prototype.resolveTxt = async (name) => lookup(TXT, name).map((r) => (r.length > 200 ? [r.slice(0, 200), r.slice(200)] : [r]));
  Resolver.prototype.resolveCname = async (name) => lookup(CNAME, name);
}
