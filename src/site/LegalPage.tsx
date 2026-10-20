import { LoaderCircle } from 'lucide-react';
import { Fragment, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiError, api } from '../lib/api';
import { instagramHandle, storeWhatsappUrl, useShop } from './data';
import { PageShell } from './shell';
import { WHATSAPP_BUTTON, WhatsAppIcon } from './ui';

// Termos e políticas (uso, cancelamento e trocas, entrega, pagamento e reembolso). O texto é da loja e se edita no painel; aqui ele só é desenhado.
// Formato do texto (sempre texto puro, nunca HTML): "## Título" abre uma seção, "- item" é uma lista, o resto são parágrafos separados por linha em branco.

export type LegalSlug = 'termos' | 'trocas-e-cancelamentos' | 'entrega' | 'pagamento-e-reembolso' | 'contato-e-responsavel';
export const LEGAL_PATHS: Record<LegalSlug, string> = {
  termos: '/termos',
  'trocas-e-cancelamentos': '/trocas-e-cancelamentos',
  entrega: '/entrega',
  'pagamento-e-reembolso': '/pagamento-e-reembolso',
  'contato-e-responsavel': '/contato-e-responsavel',
};
export const LEGAL_LABEL: Record<LegalSlug, string> = {
  termos: 'Termos de uso',
  'trocas-e-cancelamentos': 'Cancelamento e trocas',
  entrega: 'Entrega e retirada',
  'pagamento-e-reembolso': 'Pagamento e reembolso',
  'contato-e-responsavel': 'Contato e responsável',
};

type Block = { kind: 'h'; text: string } | { kind: 'p'; text: string } | { kind: 'ul'; items: string[] };

export function parseLegal(body: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: 'p', text: paragraph.join(' ') });
    paragraph = [];
  };
  for (const raw of body.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) flush();
    else if (line.startsWith('## ')) {
      flush();
      blocks.push({ kind: 'h', text: line.slice(3).trim() });
    } else if (/^[-*] /.test(line)) {
      flush();
      const last = blocks[blocks.length - 1];
      if (last?.kind === 'ul') last.items.push(line.slice(2).trim());
      else blocks.push({ kind: 'ul', items: [line.slice(2).trim()] });
    } else paragraph.push(line);
  }
  flush();
  return blocks;
}

function Rendered({ body }: { body: string }): ReactNode {
  return (
    <>
      {parseLegal(body).map((block, i) =>
        block.kind === 'h' ? (
          <h2 key={i} className="pt-4 text-lg font-black text-white first:pt-0">
            {block.text}
          </h2>
        ) : block.kind === 'ul' ? (
          <ul key={i} className="list-disc space-y-1.5 pl-5 marker:text-[#2563FF]">
            {block.items.map((item, j) => (
              <li key={j}>{item}</li>
            ))}
          </ul>
        ) : (
          <p key={i}>{block.text}</p>
        ),
      )}
    </>
  );
}

// Os dados de contato que a loja já cadastrou no painel (endereço, WhatsApp, Instagram). Nome empresarial, CNPJ e endereço do responsável NÃO vêm daqui: a loja os
// escreve no texto da página (painel → Configurações → Termos e políticas), porque só ela sabe e o sistema não inventa.
function StoreContact() {
  const { store } = useShop();
  const address = [store.address, [store.city, store.state].filter(Boolean).join(' - '), store.cep].filter(Boolean).join(', ');
  const handle = instagramHandle(store);
  const whatsapp = store.whatsapp ? storeWhatsappUrl(store, 'Olá!') : '';
  if (!address && !whatsapp && !handle) return null;
  return (
    <dl data-store-contact className="mt-6 grid max-w-3xl gap-3 rounded-[1.75rem] border border-white/10 bg-white/[0.04] p-5 text-[15px] text-white/75 sm:grid-cols-[auto_1fr] sm:gap-x-6 sm:p-7">
      <dt className="font-bold text-white">Loja</dt>
      <dd>{store.store_name}</dd>
      {address && (
        <>
          <dt className="font-bold text-white">Endereço</dt>
          <dd>{address}</dd>
        </>
      )}
      {whatsapp && (
        <>
          <dt className="font-bold text-white">WhatsApp</dt>
          <dd>
            <a href={whatsapp} target="_blank" rel="noopener noreferrer" className="font-semibold text-[#8FB1FF] underline-offset-4 hover:text-white hover:underline">
              Chamar no WhatsApp
            </a>
          </dd>
        </>
      )}
      {handle && (
        <>
          <dt className="font-bold text-white">Instagram</dt>
          <dd>
            <a href={`https://instagram.com/${handle}`} target="_blank" rel="noopener noreferrer" className="font-semibold text-[#8FB1FF] underline-offset-4 hover:text-white hover:underline">
              @{handle}
            </a>
          </dd>
        </>
      )}
    </dl>
  );
}

export function LegalPage({ slug }: { slug: LegalSlug }) {
  const { store } = useShop();
  const [page, setPage] = useState<{ title: string; body: string; updated_at: string } | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'missing' | 'error'>('loading');

  useEffect(() => {
    let alive = true;
    setState('loading');
    api.get<{ page: { title: string; body: string; updated_at: string } }>(`/api/legal/${slug}`).then(
      (data) => {
        if (!alive) return;
        setPage(data.page);
        setState('ok');
      },
      (e) => alive && setState(e instanceof ApiError && e.status === 404 ? 'missing' : 'error'),
    );
    return () => {
      alive = false;
    };
  }, [slug]);

  useEffect(() => {
    if (page) document.title = `${page.title} · ${store.store_name}`;
  }, [page, store.store_name]);

  const whatsapp = store.whatsapp ? storeWhatsappUrl(store, 'Olá! Tenho uma dúvida sobre a política da loja.') : '';
  return (
    <PageShell back="/" backLabel="Início">
      <h1 className="text-3xl font-black tracking-tight text-white sm:text-4xl">{page?.title ?? LEGAL_LABEL[slug]}</h1>
      {state === 'ok' && page ? (
        <>
          <p className="mt-2 text-white/60">Atualizada em {new Intl.DateTimeFormat('pt-BR', { dateStyle: 'long', timeZone: store.timezone }).format(new Date(page.updated_at))}.</p>
          {slug === 'contato-e-responsavel' && <StoreContact />}
          <div data-legal={slug} className="mt-6 max-w-3xl space-y-3 rounded-[1.75rem] border border-white/10 bg-gradient-to-b from-white/[0.05] to-white/[0.02] p-5 text-[15px] leading-relaxed text-white/75 sm:p-7">
            <Rendered body={page.body} />
          </div>
        </>
      ) : state === 'loading' ? (
        <p className="mt-6 flex items-center gap-2 text-white/60" role="status">
          <LoaderCircle className="h-5 w-5 animate-spin" aria-hidden="true" /> Carregando…
        </p>
      ) : (
        <p role="alert" className="mt-6 text-white/70">
          {state === 'missing' ? 'Esta página não existe.' : 'Não foi possível carregar esta página agora. Tente de novo em instantes.'}
        </p>
      )}
      {whatsapp && (
        <p className="mt-8">
          <a href={whatsapp} target="_blank" rel="noopener noreferrer" className={WHATSAPP_BUTTON}>
            <WhatsAppIcon /> Falar com a loja
          </a>
        </p>
      )}
      <p className="mt-6 text-sm text-white/60">
        {(Object.keys(LEGAL_PATHS) as LegalSlug[])
          .filter((s) => s !== slug)
          .map((s, i) => (
            <Fragment key={s}>
              {i > 0 && <span aria-hidden="true"> · </span>}
              <a href={LEGAL_PATHS[s]} className="underline-offset-4 hover:text-white hover:underline">
                {LEGAL_LABEL[s]}
              </a>
            </Fragment>
          ))}
        <span aria-hidden="true"> · </span>
        <a href="/privacidade" className="underline-offset-4 hover:text-white hover:underline">
          Política de privacidade
        </a>
      </p>
    </PageShell>
  );
}
