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

export function installDnsMock({ broken = false } = {}) {
  const answer = (domain, type) => {
    if (broken) throw err('ENOTFOUND'); // o DNS inteiro "caiu": até gmail.com não resolve
    const entry = DOMAINS[domain];
    const value = entry ? entry[type] : type === 'mx' ? [{ exchange: `mx.${domain}`, priority: 10 }] : type === 'a' ? ['198.51.100.7'] : 'NODATA';
    if (value === 'NX') throw err('ENOTFOUND');
    if (value === 'NODATA') throw err('ENODATA');
    if (typeof value === 'string') throw err(value);
    return value;
  };
  Resolver.prototype.resolveMx = async (domain) => answer(domain, 'mx');
  Resolver.prototype.resolve4 = async (domain) => answer(domain, 'a');
  Resolver.prototype.resolve6 = async (domain) => answer(domain, 'aaaa');
}
