import { Check, LoaderCircle, ShieldCheck, Trash2, XCircle } from 'lucide-react';
import { useId, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { api, friendlyError } from '../lib/api';
import { formatPhone } from '../lib/format';
import { fullAddress, storeWhatsappUrl, useShop } from './data';
import { Field, PageShell } from './shell';
import { BLUE_BUTTON, FIELD, GHOST_BUTTON, WHATSAPP_BUTTON, WhatsAppIcon } from './ui';

// Política de privacidade (LGPD). Descreve só o que o site faz de fato: cada item abaixo corresponde a um comportamento do código.
// O texto não substitui a revisão de um profissional jurídico; razão social, CNPJ e o encarregado (DPO) da loja são dela e não
// estão inventados aqui: a página usa o nome, o WhatsApp e o endereço cadastrados no painel.

const UPDATED = '11 de outubro de 2026';

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="rounded-[1.75rem] border border-white/10 bg-gradient-to-b from-white/[0.05] to-white/[0.02] p-5 sm:p-6">
      <h2 id={id} className="text-lg font-black text-white">
        {title}
      </h2>
      <div className="mt-3 space-y-3 text-[15px] leading-relaxed text-white/75">{children}</div>
    </section>
  );
}

const List = ({ items }: { items: ReactNode[] }) => (
  <ul className="list-disc space-y-1.5 pl-5 marker:text-[#2563FF]">
    {items.map((item, i) => (
      <li key={i}>{item}</li>
    ))}
  </ul>
);

const KINDS = [
  { value: 'access', label: 'Quero ver os meus dados' },
  { value: 'correction', label: 'Quero corrigir algum dado' },
  { value: 'deletion', label: 'Quero apagar os meus dados' },
  { value: 'other', label: 'Outro assunto de privacidade' },
] as const;

// Tudo o que o site guarda no aparelho começa com "copocheio:" (carrinho, dados do último pedido, cópia do cardápio, pedidos recentes).
function clearDeviceData() {
  for (const storage of [localStorage, sessionStorage]) {
    try {
      Object.keys(storage)
        .filter((key) => key.startsWith('copocheio:'))
        .forEach((key) => storage.removeItem(key));
    } catch {
      /* armazenamento bloqueado: não há o que apagar */
    }
  }
}

function RequestForm() {
  const [form, setForm] = useState({ kind: 'access' as (typeof KINDS)[number]['value'], name: '', contact: '', message: '', website: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState('');
  const set = (key: keyof typeof form, value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => ({ ...e, [key]: '' }));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (form.name.trim().length < 2) next.name = 'Informe seu nome.';
    const contact = form.contact.trim();
    const digits = contact.replace(/\D/g, '');
    if (contact.includes('@') ? !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contact) : digits.length < 10 || digits.length > 13) next.contact = 'Informe um telefone com DDD ou um e-mail válido.';
    setErrors(next);
    if (Object.keys(next).length) {
      requestAnimationFrame(() => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    setState('sending');
    setError('');
    try {
      await api.post('/api/privacy/request', { kind: form.kind, name: form.name.trim(), contact: contact.includes('@') ? contact : digits, message: form.message.trim() || null, website: form.website });
      setState('sent');
    } catch (err) {
      setState('idle');
      setError(friendlyError(err, 'Não foi possível enviar agora. Tente de novo ou fale com a loja pelo WhatsApp.'));
    }
  };

  if (state === 'sent') {
    return (
      <div role="status" className="flex items-start gap-3 rounded-2xl border border-emerald-400/25 bg-emerald-400/10 px-4 py-4 text-emerald-100">
        <Check className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
        <p>
          <strong className="text-white">Pedido enviado.</strong> A loja vai responder pelo contato que você informou. Para confirmar que é você, ela pode pedir dados do seu último pedido.
        </p>
      </div>
    );
  }
  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <Field label="O que você precisa?">
        {(p) => (
          <select {...p} value={form.kind} onChange={(e) => set('kind', e.target.value)} className={`${FIELD} appearance-none`}>
            {KINDS.map((k) => (
              <option key={k.value} value={k.value} className="bg-[#0A0D14]">
                {k.label}
              </option>
            ))}
          </select>
        )}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Seu nome *" error={errors.name}>
          {(p) => <input {...p} value={form.name} onChange={(e) => set('name', e.target.value)} autoComplete="name" maxLength={80} className={FIELD} />}
        </Field>
        <Field label="Telefone ou e-mail para a resposta *" error={errors.contact} hint="De preferência o mesmo dos seus pedidos.">
          {(p) => <input {...p} value={form.contact} onChange={(e) => set('contact', e.target.value)} autoComplete="email" maxLength={254} className={FIELD} placeholder="(34) 99999-0000 ou voce@email.com" />}
        </Field>
      </div>
      <Field label="Mensagem (opcional)">
        {(p) => <textarea {...p} value={form.message} onChange={(e) => set('message', e.target.value)} maxLength={1000} rows={3} className={`${FIELD} resize-none`} placeholder="Conte o que você precisa. Não escreva senhas." />}
      </Field>
      {/* Armadilha para robôs: pessoas não veem nem preenchem este campo. */}
      <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
        <label>
          Não preencha este campo
          <input tabIndex={-1} autoComplete="off" value={form.website} onChange={(e) => set('website', e.target.value)} />
        </label>
      </div>
      {error && (
        <p role="alert" className="flex items-start gap-2 rounded-2xl border border-rose-400/30 bg-rose-500/10 px-3.5 py-2.5 text-sm text-rose-100">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {error}
        </p>
      )}
      <button type="submit" disabled={state === 'sending'} className={`${BLUE_BUTTON} disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:scale-100`}>
        {state === 'sending' ? (
          <>
            <LoaderCircle className="h-5 w-5 animate-spin" aria-hidden="true" /> Enviando...
          </>
        ) : (
          'Enviar pedido'
        )}
      </button>
    </form>
  );
}

export function PrivacyPage() {
  const { store, cart } = useShop();
  const [cleared, setCleared] = useState(false);
  const address = fullAddress(store);
  const phone = store.whatsapp ? formatPhone(store.whatsapp) : '';
  const name = store.store_name;

  const wipeDevice = () => {
    clearDeviceData();
    cart.clear();
    setCleared(true);
  };

  return (
    <PageShell back="/" backLabel="Início">
      <h1 className="text-3xl font-black tracking-tight text-white sm:text-4xl">
        Política de <span className="text-[#2563FF] [text-shadow:0_0_28px_rgba(20,92,255,0.6)]">privacidade</span>
      </h1>
      <p className="mt-2 text-white/60">Atualizada em {UPDATED}.</p>
      <p className="mt-4 max-w-3xl leading-relaxed text-white/75">
        Aqui explicamos, sem juridiquês, quais dados o site da {name} usa, para quê, com quem passam por aí e como você pode ver, corrigir ou apagar o que for seu. Seguimos a Lei Geral de Proteção de Dados (LGPD, Lei 13.709/2018).
      </p>

      <div className="mt-8 space-y-5">
        <Section title="Quem cuida dos seus dados">
          <p>
            O responsável pelos dados é a própria loja: <strong className="text-white">{name}</strong>
            {store.tagline ? ` ${store.tagline}` : ''}
            {address ? `, ${address}` : ''}. Para qualquer assunto de privacidade, use o formulário desta página{phone ? ` ou o WhatsApp ${phone}` : ''}.
          </p>
        </Section>

        <Section title="Quais dados usamos e para quê">
          <List
            items={[
              <>
                <strong className="text-white">Ao fazer um pedido:</strong> nome, telefone, e-mail (opcional), endereço de entrega (rua, número, bairro, complemento e referência) ou retirada, forma de pagamento, valor do troco, observações e os itens. Servem para preparar, entregar e permitir que você acompanhe o pedido.
              </>,
              <>
                <strong className="text-white">Se criar uma conta (opcional):</strong> nome, e-mail, telefone, senha e endereço salvo. A senha é guardada só de forma embaralhada (hash): nem a loja consegue lê-la. Servem para guardar o histórico e agilizar os próximos pedidos. A conta só vale depois de você confirmar o e-mail.
              </>,
              <>
                <strong className="text-white">Segurança:</strong> o seu endereço de rede (IP) e o horário das tentativas de entrar, criar conta, enviar pedido ou usar formulários. Servem para barrar fraudes e abusos e são apagados automaticamente em até 1 dia.
              </>,
              <>
                <strong className="text-white">Pedidos de privacidade:</strong> nome, contato e mensagem que você enviar pelo formulário abaixo.
              </>,
              <>
                <strong className="text-white">E-mails de serviço:</strong> confirmar a conta, recuperar a senha, avisos de segurança e avisos dos seus pedidos (recebido, confirmado, saiu para entrega, entregue ou cancelado, e pagamento). O endereço digitado num pedido recebe os avisos desse pedido; se o endereço não for seu, use o link no fim da mensagem para não receber mais.
              </>,
              <>
                <strong className="text-white">Novidades e promoções por e-mail:</strong> só se você marcar essa opção ao criar a conta ou em “Minha conta” (a caixa vem desmarcada). O consentimento fica registrado com a data, a origem e a versão do texto que você viu. Você cancela quando quiser, com um clique no “Cancelar inscrição” de qualquer promoção ou em “Minha conta”, e os e-mails de serviço continuam chegando.
              </>,
              <>
                <strong className="text-white">Registro dos e-mails enviados:</strong> para saber se uma mensagem saiu e corrigir falhas, a loja guarda o destinatário, o tipo de e-mail, a data e o resultado do envio. O texto da mensagem, os códigos e os links <em>não</em> são guardados. Endereços que o servidor de e-mail recusa, ou que pedem para não receber, ficam numa lista para a loja não insistir.
              </>,
            ]}
          />
          <p>Não vendemos os seus dados, não fazemos perfil de consumo e o site não usa anúncios nem ferramentas de estatística de terceiros.</p>
        </Section>

        <Section title="Cookies e dados guardados no seu aparelho">
          <List
            items={[
              <>
                <strong className="text-white">Cookies necessários:</strong> um mantém você logado na conta (30 dias) e outro protege o cadastro contra uso indevido (7 dias). Não são cookies de publicidade nem de rastreamento.
              </>,
              <>
                <strong className="text-white">Armazenamento local do navegador:</strong> o seu pedido em andamento (carrinho), os dados do último pedido para preencher o próximo (nome, telefone, e-mail e endereço), uma cópia do cardápio para abrir mais rápido e a lista de pedidos recentes deste aparelho.
              </>,
            ]}
          />
          <p>Em computador compartilhado, apague tudo no botão abaixo.</p>
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" onClick={wipeDevice} className={GHOST_BUTTON}>
              <Trash2 className="h-5 w-5" aria-hidden="true" /> Apagar os dados deste aparelho
            </button>
            {cleared && (
              <p role="status" className="flex items-center gap-2 text-sm font-semibold text-emerald-300">
                <Check className="h-4 w-4" aria-hidden="true" /> Pronto: carrinho e dados salvos aqui foram apagados.
              </p>
            )}
          </div>
        </Section>

        <Section title="Com quem os dados passam">
          <p>Para o site funcionar, usamos serviços de terceiros. Cada um recebe só o necessário para a sua função:</p>
          <List
            items={[
              <>
                <strong className="text-white">Vercel</strong> (hospedagem do site) e <strong className="text-white">Neon</strong> (banco de dados onde ficam pedidos e contas).
              </>,
              <>
                <strong className="text-white">Serviço de envio de e-mails</strong> contratado pela loja (e o servidor de e-mail de quem recebe), por onde passam as mensagens de serviço e, se você aceitou, as promoções.
              </>,
              <>
                <strong className="text-white">WhatsApp:</strong> ao tocar num botão de WhatsApp você sai do site e a conversa segue as regras do WhatsApp.
              </>,
              <>
                <strong className="text-white">Google Maps:</strong> quando a loja cadastra o endereço, a seção Contato mostra um mapa do Google. Ele só carrega quando você rola até essa seção e, nesse momento, o Google recebe o seu IP e dados do navegador.
              </>,
              <>
                <strong className="text-white">Amazon CloudFront:</strong> hospeda o vídeo da página inicial; o navegador o busca diretamente de lá.
              </>,
              <>
                <strong className="text-white">Entrega:</strong> o nome, o telefone e o endereço do pedido são vistos por quem prepara e entrega na loja.
              </>,
            ]}
          />
        </Section>

        <Section title="Por quanto tempo guardamos">
          <List
            items={[
              <>
                <strong className="text-white">Pedidos:</strong> ficam no histórico da loja (controle de vendas e obrigações legais) enquanto forem necessários. Você pode pedir que o seu nome, telefone, e-mail, endereço e observações sejam removidos deles (anonimização); os valores e os itens continuam, sem ligação com você.
              </>,
              <>
                <strong className="text-white">Link de acompanhamento:</strong> vale por {store.tracking_retention_days} dias depois da última atualização do pedido.
              </>,
              <>
                <strong className="text-white">Conta:</strong> até você pedir a exclusão. Cadastros que nunca são confirmados por e-mail são apagados sozinhos.
              </>,
              <>
                <strong className="text-white">Sessão (login):</strong> 30 dias, ou até você sair.
              </>,
              <>
                <strong className="text-white">Registro dos e-mails enviados:</strong> 180 dias. Ao excluir a conta ou pedir a anonimização, o seu endereço sai desses registros, da lista de preferências e da lista de endereços bloqueados.
              </>,
              <>
                <strong className="text-white">Pedidos de privacidade:</strong> até 2 anos depois de atendidos, para a loja provar que respondeu.
              </>,
            ]}
          />
        </Section>

        <Section title="Seus direitos">
          <p>Pela LGPD você pode pedir, a qualquer momento: confirmação de que usamos seus dados, acesso a eles, correção de dados errados, anonimização ou exclusão do que for desnecessário, informação sobre com quem compartilhamos, portabilidade e a retirada de consentimento. Também pode reclamar à Autoridade Nacional de Proteção de Dados (ANPD).</p>
          <p>Para confirmar que é você, a loja responde pelo contato informado e pode pedir dados do seu último pedido. O prazo de resposta é o da lei (até 15 dias para o acesso completo).</p>
        </Section>

        <Section title="Segurança">
          <p>O site usa conexão criptografada (HTTPS). Senhas e códigos de acompanhamento são guardados só de forma embaralhada. O painel da loja exige senha (e, se a loja ativar, verificação em duas etapas) e registra quem mexeu em quê.</p>
        </Section>

        <section aria-labelledby="pedido-privacidade" className="rounded-[1.75rem] border border-[#145CFF]/35 bg-gradient-to-b from-[#0C1B4D] via-[#08112F] to-[#060913] p-5 sm:p-6">
          <h2 id="pedido-privacidade" className="flex items-center gap-2 text-lg font-black text-white">
            <ShieldCheck className="h-5 w-5 text-[#8FB1FF]" aria-hidden="true" /> Pedir acesso, correção ou exclusão
          </h2>
          <p className="mb-5 mt-2 text-[15px] text-white/70">Mesmo sem conta, você pode pedir. A loja recebe o pedido no painel e responde pelo contato que você informar.</p>
          <RequestForm />
          {store.whatsapp && (
            <p className="mt-5 text-sm text-white/65">
              Prefere falar direto?{' '}
              <a href={storeWhatsappUrl(store, `Olá, ${name}! Tenho uma dúvida sobre privacidade e meus dados.`)} target="_blank" rel="noopener noreferrer" className="font-semibold text-[#8FB1FF] underline-offset-4 hover:text-white hover:underline">
                Chamar no WhatsApp
              </a>
              .
            </p>
          )}
        </section>

        <Section title="Mudanças nesta política">
          <p>Se algo mudar na forma como usamos os dados, esta página é atualizada e a data no topo muda. Dúvidas? Fale com a gente.</p>
          {store.whatsapp && (
            <a href={storeWhatsappUrl(store, `Olá, ${name}!`)} target="_blank" rel="noopener noreferrer" className={`${WHATSAPP_BUTTON} mt-2`}>
              <WhatsAppIcon /> Falar no WhatsApp
            </a>
          )}
        </Section>
      </div>
    </PageShell>
  );
}

export function NotFoundPage() {
  return (
    <PageShell back="/" backLabel="Início">
      <div className="mx-auto mt-10 max-w-md rounded-[2rem] border border-white/10 bg-gradient-to-b from-white/[0.06] to-transparent p-8 text-center">
        <p className="text-6xl font-black tracking-tight text-[#2563FF] [text-shadow:0_0_28px_rgba(20,92,255,0.6)]" aria-hidden="true">
          404
        </p>
        <h1 className="mt-4 text-2xl font-black text-white">Página não encontrada</h1>
        <p className="mt-2 text-white/65">O endereço que você abriu não existe ou mudou de lugar.</p>
        <div className="mt-7 flex flex-col justify-center gap-3 sm:flex-row">
          <a href="/bebidas" className={BLUE_BUTTON}>
            Ver bebidas
          </a>
          <a href="/" className={GHOST_BUTTON}>
            Ir para o início
          </a>
        </div>
      </div>
    </PageShell>
  );
}
