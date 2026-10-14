import { CheckCircle2, CircleAlert, Info, Send, ShieldCheck, TriangleAlert, XCircle } from 'lucide-react';
import { useState } from 'react';
import { api, friendlyError } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import type { DnsFinding, DnsReport, EmailOverview } from '../../lib/types';
import { useAdmin } from '../AdminApp';
import { Badge, Button, Card, INPUT, cx, useToast } from '../ui';

const LEVEL = {
  ok: { Icon: CheckCircle2, color: 'text-emerald-300' },
  info: { Icon: Info, color: 'text-[#8FB1FF]' },
  warning: { Icon: TriangleAlert, color: 'text-amber-200' },
  error: { Icon: XCircle, color: 'text-rose-300' },
} as const;

function Findings({ items }: { items: DnsFinding[] }) {
  return (
    <ul className="mt-2 space-y-1.5">
      {items.map((f, i) => {
        const { Icon, color } = LEVEL[f.level];
        return (
          <li key={i} className="flex items-start gap-2 text-sm text-white/80">
            <Icon className={cx('mt-0.5 h-4 w-4 shrink-0', color)} aria-hidden="true" />
            <span className="min-w-0">{f.text}</span>
          </li>
        );
      })}
    </ul>
  );
}

function Record({ value }: { value: string | null }) {
  if (!value) return <p className="mt-1 text-xs text-white/45">Nenhum registro encontrado.</p>;
  return <code className="mt-1 block break-all rounded-lg bg-black/40 px-2.5 py-2 text-[11px] text-white/80">{value}</code>;
}

const STATUS = {
  ok: { label: 'Base certa', tone: 'green' as const, text: 'SPF, DKIM e DMARC aparecem no DNS. Isso é a base; a prova final é o cabeçalho de um e-mail real (guia abaixo).' },
  attention: { label: 'Falta algo recomendado', tone: 'amber' as const, text: 'Há itens recomendados que não aparecem no DNS. Veja abaixo.' },
  problem: { label: 'Há um problema', tone: 'red' as const, text: 'Falta algo essencial ou há um erro de configuração. Veja abaixo.' },
  unknown: { label: 'Não consegui consultar', tone: 'gray' as const, text: 'O DNS não respondeu. Tente de novo em instantes.' },
};

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[#145CFF]/20 text-xs font-black text-[#9DBBFF] ring-1 ring-[#145CFF]/40">{n}</span>
      <div className="min-w-0">
        <p className="font-semibold text-white">{title}</p>
        <div className="mt-1 space-y-1.5 text-sm text-white/70">{children}</div>
      </div>
    </li>
  );
}

function Guide({ overview }: { overview: EmailOverview }) {
  return (
    <div className="space-y-5">
      {overview.transport.free_sender ? (
        <Card title="Sua situação: remetente de e-mail gratuito" description={`Hoje os e-mails saem de ${overview.transport.from_email ?? 'um e-mail gratuito'}.`}>
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-white/75">
            <li>Funciona para começar: códigos de confirmação, nova senha e avisos de pedido chegam, e o sistema já separa o que é conta/pedido do que é promoção.</li>
            <li>Não existe domínio da loja para autenticar. SPF, DKIM e DMARC pertencem ao Gmail/Outlook e a mensagem sai “em nome” de uma conta pessoal.</li>
            <li>O limite de uma conta pessoal do Gmail é de cerca de 500 e-mails por dia (o sistema usa 450 como teto de segurança). Promoções em massa por ela podem bloquear a conta.</li>
            <li>O SMTP comum não avisa entrega, devolução nem spam: o painel mostra “não informado” em vez de inventar números.</li>
          </ul>
        </Card>
      ) : (
        <Card title="Sua situação: domínio próprio" description={`Os e-mails saem de ${overview.transport.from_email ?? 'um endereço do domínio'}. Use “Verificar agora” acima para ver o que está no DNS.`}>
          <p className="text-sm text-white/75">Com domínio próprio, SPF, DKIM e DMARC podem ser todos seus. Confira o resultado acima e o guia de verificação abaixo.</p>
        </Card>
      )}

      <Card title="Passo a passo para ter autenticação profissional" description="Nada disso muda o sistema por dentro: são configurações no seu domínio e nas variáveis da Vercel.">
        <ol className="space-y-4">
          <Step n={1} title="Tenha um domínio da loja">
            <p>Por exemplo, um endereço .com.br registrado no Registro.br. Você precisa conseguir editar o DNS dele.</p>
          </Step>
          <Step n={2} title="Escolha como enviar">
            <p>
              <strong>a)</strong> E-mail do próprio domínio (Google Workspace, Zoho, Microsoft 365) usando as variáveis <code>SMTP_*</code> que o sistema já tem; ou <strong>b)</strong> um serviço de envio transacional (Brevo, Amazon SES, SendGrid, Mailgun, Postmark ou Resend) também por SMTP, sem mudar o sistema; ou <strong>c)</strong> a Resend pela API (<code>EMAIL_PROVIDER=resend</code>), que já está pronta no sistema e passa a informar entrega, devolução e spam por aviso assinado.
            </p>
          </Step>
          <Step n={3} title="Crie no DNS os registros que o PROVEDOR indicar">
            <p>
              O <strong>SPF</strong> (um único TXT no domínio) e o <strong>DKIM</strong> (um ou mais CNAME/TXT com nome e valor exatos) são dados pelo provedor. <strong>Copie do painel dele: não invente valores</strong>. Só pode haver um registro SPF por domínio.
            </p>
          </Step>
          <Step n={4} title="Crie o DMARC começando só por monitoramento">
            <p>
              TXT em <code>_dmarc.seudominio.com.br</code> com <code>v=DMARC1; p=none; rua=mailto:alguem@seudominio.com.br</code>. <code>p=none</code> não bloqueia nada: só gera relatórios. Depois de algumas semanas sem e-mails legítimos reprovados, você decide se endurece para <code>quarantine</code> e depois <code>reject</code>.
            </p>
          </Step>
          <Step n={5} title="Troque o remetente e publique">
            <p>
              Na Vercel, ponha <code>MAIL_FROM</code> = <code>Copo Cheio &lt;loja@seudominio.com.br&gt;</code> (com o domínio autenticado), confira as demais variáveis e faça um novo deploy. Depois clique em “Verificar agora” acima.
            </p>
          </Step>
          <Step n={6} title="Confira num e-mail de verdade">
            <p>Use o guia abaixo: SPF, DKIM e DMARC têm de aparecer como PASS no Gmail e no Outlook.</p>
          </Step>
        </ol>
      </Card>

      <Card title="Como conferir no Gmail e no Outlook" description="É a única prova real de que o e-mail da loja está autenticado.">
        <div className="grid gap-5 md:grid-cols-2">
          <div>
            <h3 className="text-sm font-bold text-white">Gmail</h3>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-white/75">
              <li>Peça um e-mail do sistema para uma conta Gmail (cadastro, nova senha, pedido ou “Enviar teste” de uma campanha).</li>
              <li>Abra a mensagem, clique nos três pontinhos (⋮) e em <strong>“Mostrar original”</strong>.</li>
              <li>No topo aparecem <strong>SPF</strong>, <strong>DKIM</strong> e <strong>DMARC</strong> com o resultado. O esperado é <strong>PASS</strong> nos três e o domínio da loja ao lado.</li>
              <li>Anote em que pasta caiu (Entrada, Promoções ou Spam): o sistema não consegue saber.</li>
            </ol>
          </div>
          <div>
            <h3 className="text-sm font-bold text-white">Outlook / Hotmail</h3>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-white/75">
              <li>Peça o mesmo e-mail para uma conta Outlook.com ou Hotmail.</li>
              <li>Abra a mensagem, clique em <strong>“...” → “Exibir” → “Exibir origem da mensagem”</strong> (na versão em inglês: View → View message source).</li>
              <li>Procure a linha <code>Authentication-Results</code>. O esperado é <code>spf=pass</code>, <code>dkim=pass</code> e <code>dmarc=pass</code>.</li>
              <li>Veja se caiu em Caixa de Entrada, Lixo Eletrônico ou “Outros”.</li>
            </ol>
          </div>
        </div>
        <p className="mt-4 rounded-xl bg-white/[0.04] p-3 text-xs leading-relaxed text-white/65">
          Se aparecer <strong>FAIL</strong> ou <strong>NONE</strong> em algum item, o DNS do domínio não está como o provedor pede: revise o registro correspondente. Repita o teste com um e-mail de cada tipo (confirmação de conta, nova senha, pedido e promoção). Cada mensagem enviada tem um <em>Message-ID</em> no histórico, útil para achá-la na caixa de entrada.
        </p>
      </Card>

      <Card title="O que o sistema já faz por você">
        <ul className="list-disc space-y-1.5 pl-5 text-sm text-white/75">
          <li>Separa e-mails de conta/pedido (transacionais) de promoções: promoção só vai para quem aceitou e confirmou o e-mail, e nunca bloqueia um código de login.</li>
          <li>“Cancelar inscrição” com um clique em toda promoção (cabeçalhos List-Unsubscribe e List-Unsubscribe-Post) e página de preferências.</li>
          <li>Lista de supressão automática (endereço inexistente, reclamação) e tetos por endereço e por dia, para não insistir nem parecer spam.</li>
          <li>E-mails em HTML simples, com versão em texto, sem imagem de rastreio, sem encurtador de link e com remetente e assunto claros.</li>
          <li>Fila com novas tentativas e espera crescente quando o servidor de e-mail falha, sem repetir código de login nem aviso duplicado.</li>
        </ul>
      </Card>
    </div>
  );
}

// Manda para a caixa do owner um exemplo de cada modelo de e-mail, para conferir de verdade no Gmail e no Outlook (guia logo abaixo).
function SamplesCard() {
  const { user } = useAdmin();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ to: string; results: { label: string; ok: boolean; detail: string | null }[] } | null>(null);
  const owner = user.role === 'owner';

  const send = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ to: string; sent: number; total: number; results: { label: string; ok: boolean; detail: string | null }[] }>('/api/admin/emails/samples', {});
      setResult({ to: r.to, results: r.results });
      if (r.sent === r.total) toast.success(`${r.sent} exemplos enviados para ${r.to}.`, 'Abra no Gmail e no Outlook e siga o guia abaixo (Mostrar original).');
      else toast.error(`${r.sent} de ${r.total} exemplos enviados.`, 'Veja quais falharam na lista e o motivo em Mensagens.');
    } catch (err) {
      toast.error('Não foi possível enviar os exemplos.', friendlyError(err, ''));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Conferir os e-mails de verdade" description="Manda para a sua caixa de entrada um exemplo de cada modelo: confirmação de conta, nova senha, pedido recebido, pagamento confirmado, saiu para entrega, cancelado e promoção.">
      <p className="text-sm text-white/70">
        Todos chegam marcados “[Teste]”, com dados inventados: nenhum cliente recebe nada e nenhum pedido é criado. Use-os para ver, no Gmail e no Outlook, como cada modelo aparece, em que pasta cai e se SPF, DKIM e DMARC estão em PASS.
      </p>
      {owner ? (
        <Button className="mt-4" loading={busy} icon={<Send className="h-4 w-4" aria-hidden="true" />} onClick={() => void send()}>
          Enviar exemplos para mim
        </Button>
      ) : (
        <p className="mt-3 text-xs text-white/55">Só o owner envia os exemplos (eles vão para o e-mail de quem pede).</p>
      )}
      {result && (
        <ul className="mt-4 space-y-1.5 text-sm" aria-live="polite">
          {result.results.map((r) => (
            <li key={r.label} className="flex items-start gap-2 text-white/80">
              {r.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" aria-hidden="true" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-300" aria-hidden="true" />}
              <span className="min-w-0">
                {r.label}
                <span className="sr-only">{r.ok ? ' (enviado)' : ' (falhou)'}</span>
                {!r.ok && r.detail && <span className="text-white/55"> — {r.detail}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export default function AuthenticationTab({ overview }: { overview: EmailOverview }) {
  const toast = useToast();
  const [report, setReport] = useState<DnsReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [selector, setSelector] = useState('');

  const check = async () => {
    setChecking(true);
    try {
      setReport(await api.get<DnsReport>(`/api/admin/emails/dns${selector.trim() ? `?selector=${encodeURIComponent(selector.trim().toLowerCase())}` : ''}`));
    } catch (err) {
      toast.error('Não foi possível verificar o DNS.', friendlyError(err, ''));
    } finally {
      setChecking(false);
    }
  };

  const st = report?.applicable ? STATUS[report.status] : null;
  return (
    <div className="space-y-5">
      <Card
        title="Autenticação do domínio (SPF, DKIM e DMARC)"
        description={overview.transport.from_domain ? `Domínio do remetente: ${overview.transport.from_domain}` : 'Remetente ainda não configurado.'}
        actions={
          <Button size="sm" icon={<ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />} loading={checking} onClick={() => void check()}>
            Verificar agora
          </Button>
        }
      >
        <p className="text-sm text-white/70">Consulta o DNS público do domínio. Não altera nada e não envia e-mail.</p>
        <label className="mt-3 block max-w-sm">
          <span className="mb-1 block text-xs font-semibold text-white/65">Nome da chave DKIM (opcional)</span>
          <input value={selector} onChange={(e) => setSelector(e.target.value)} className={INPUT} placeholder="Ex.: resend, google, selector1" autoComplete="off" />
          <span className="mt-1 block text-[11px] text-white/50">Cada provedor escolhe o nome da chave. Sem preencher, tento os nomes mais comuns.</span>
        </label>

        {report && !report.applicable && (
          <p className="mt-4 flex items-start gap-2 rounded-xl border border-amber-400/25 bg-amber-400/[0.07] p-3 text-sm text-amber-100" role="status">
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            {report.reason}
          </p>
        )}

        {report?.applicable && st && (
          <div className="mt-5 space-y-5" aria-live="polite">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={st.tone}>{st.label}</Badge>
              <span className="text-sm text-white/70">{st.text}</span>
              <span className="text-[11px] text-white/45">Conferido em {formatDateTime(report.checked_at)}</span>
            </div>
            <section>
              <h3 className="text-sm font-bold text-white">SPF</h3>
              <Record value={report.spf.record} />
              <Findings items={report.spf.findings} />
            </section>
            <section>
              <h3 className="text-sm font-bold text-white">DKIM</h3>
              {report.dkim.found.length > 0 ? <p className="mt-1 text-xs text-white/60">Encontrado: {report.dkim.found.map((k) => `${k.selector}._domainkey (${k.via === 'cname' ? 'CNAME' : 'TXT'})`).join(', ')}</p> : <p className="mt-1 text-xs text-white/45">Nomes testados: {report.dkim.tried.join(', ')}</p>}
              <Findings items={report.dkim.findings} />
            </section>
            <section>
              <h3 className="text-sm font-bold text-white">DMARC</h3>
              <Record value={report.dmarc.record} />
              <Findings items={report.dmarc.findings} />
            </section>
            <section>
              <h3 className="text-sm font-bold text-white">Recebimento (MX)</h3>
              {report.mx.hosts.length > 0 && <p className="mt-1 text-xs text-white/60">{report.mx.hosts.join(', ')}</p>}
              <Findings items={report.mx.findings} />
            </section>
          </div>
        )}
      </Card>
      <SamplesCard />
      <Guide overview={overview} />
    </div>
  );
}
