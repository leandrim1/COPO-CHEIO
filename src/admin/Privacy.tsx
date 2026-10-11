import { Eraser, Mail, MessageCircle, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, friendlyError } from '../lib/api';
import { formatDateTime, formatPhone, maskPhone, whatsappTo } from '../lib/format';
import type { PrivacyRequest } from '../lib/types';
import { useAdmin } from './AdminApp';
import { Badge, Button, Card, Field, INPUT, Modal, Spinner, cx, useToast } from './ui';

// Pedidos de privacidade (LGPD): a pessoa pede, pelo site, para ver, corrigir ou apagar os próprios dados. Aqui a loja responde
// (pelo contato que ela deixou) e marca como atendido. Para quem comprou como visitante, o owner anonimiza os pedidos.

const KIND_LABEL: Record<PrivacyRequest['kind'], string> = {
  access: 'Quer ver os dados',
  correction: 'Quer corrigir dados',
  deletion: 'Quer apagar os dados',
  other: 'Outro assunto',
};

const isPhone = (contact: string) => /^\d{10,13}$/.test(contact);

type Decision = { request: PrivacyRequest; status: 'done' | 'rejected' | 'open' };

export function PrivacyPanel({ onChange }: { onChange?: (open: number) => void }) {
  const toast = useToast();
  const { user } = useAdmin();
  const owner = user.role === 'owner';
  const [requests, setRequests] = useState<PrivacyRequest[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [wipe, setWipe] = useState<{ phone: string; email: string } | null>(null);
  const [wipeError, setWipeError] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ requests: PrivacyRequest[]; open: number }>('/api/admin/privacy');
      setRequests(data.requests);
      setFailed(false);
      onChange?.(Number(data.open));
    } catch {
      setFailed(true);
    }
  }, [onChange]);
  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (e: FormEvent) => {
    e.preventDefault();
    if (!decision) return;
    setBusy(true);
    try {
      await api.patch(`/api/admin/privacy/${decision.request.id}`, { status: decision.status, handled_note: note.trim() || null });
      toast.success(decision.status === 'done' ? 'Marcado como atendido.' : decision.status === 'rejected' ? 'Marcado como recusado.' : 'Pedido reaberto.');
      setDecision(null);
      void load();
    } catch (error) {
      toast.error('Não foi possível salvar.', friendlyError(error, ''));
    } finally {
      setBusy(false);
    }
  };

  const anonymize = async (e: FormEvent) => {
    e.preventDefault();
    if (!wipe) return;
    if (!wipe.phone.replace(/\D/g, '') && !wipe.email.trim()) return setWipeError('Informe o telefone (com DDD) ou o e-mail da pessoa.');
    setWipeError('');
    setBusy(true);
    try {
      const done = await api.post<{ orders: number; customers: number }>('/api/admin/privacy/anonymize', { phone: wipe.phone, email: wipe.email });
      toast.success('Dados anonimizados.', `${done.orders} pedido(s) e ${done.customers} conta(s) tratados.`);
      setWipe(null);
    } catch (error) {
      setWipeError(friendlyError(error, 'Não foi possível concluir.'));
    } finally {
      setBusy(false);
    }
  };

  const open = requests?.filter((r) => r.status === 'open') ?? [];
  const closed = requests?.filter((r) => r.status !== 'open') ?? [];
  const shown = showAll ? [...open, ...closed] : open;

  return (
    <Card
      className="mb-4"
      title="Privacidade (LGPD)"
      description="Pedidos de clientes para ver, corrigir ou apagar os próprios dados. A resposta vai pelo contato que a pessoa deixou."
      actions={
        <>
          {open.length > 0 && <Badge tone="amber">{open.length} em aberto</Badge>}
          {owner && (
            <Button size="sm" variant="secondary" icon={<Eraser className="h-3.5 w-3.5" aria-hidden="true" />} onClick={() => (setWipeError(''), setWipe({ phone: '', email: '' }))}>
              Anonimizar uma pessoa
            </Button>
          )}
        </>
      }
    >
      {failed && !requests ? (
        <p className="text-sm text-rose-300">Não foi possível carregar os pedidos de privacidade.</p>
      ) : !requests ? (
        <Spinner />
      ) : (
        <>
          {shown.length === 0 ? (
            <p className="flex items-center gap-2 text-sm text-white/65">
              <ShieldCheck className="h-4 w-4 text-emerald-300" aria-hidden="true" /> Nenhum pedido em aberto.
            </p>
          ) : (
            <ul className="space-y-2.5">
              {shown.map((r) => (
                <li key={r.id} className={cx('rounded-xl border p-3.5', r.status === 'open' ? 'border-amber-400/30 bg-amber-400/[0.05]' : 'border-white/[0.08] bg-white/[0.02]')}>
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold text-white">{r.name}</p>
                    <Badge tone={r.status === 'open' ? 'amber' : r.status === 'done' ? 'green' : 'gray'}>{r.status === 'open' ? 'Em aberto' : r.status === 'done' ? 'Atendido' : 'Recusado'}</Badge>
                    <Badge tone="blue">{KIND_LABEL[r.kind]}</Badge>
                    <span className="text-xs text-white/55">{formatDateTime(r.created_at)}</span>
                  </div>
                  <p className="mt-1 text-sm text-white/75">
                    Contato: <span className="font-semibold text-white">{isPhone(r.contact) ? formatPhone(r.contact) : r.contact}</span>
                  </p>
                  {r.message && <p className="mt-1 whitespace-pre-wrap break-words text-sm text-white/70">{r.message}</p>}
                  {r.status !== 'open' && (
                    <p className="mt-1 text-xs text-white/55">
                      {r.handled_by_name ? `Por ${r.handled_by_name}` : ''} {r.handled_at ? `em ${formatDateTime(r.handled_at)}` : ''}
                      {r.handled_note ? ` · ${r.handled_note}` : ''}
                    </p>
                  )}
                  <div className="mt-2.5 flex flex-wrap gap-2">
                    {isPhone(r.contact) ? (
                      <a
                        href={whatsappTo(r.contact, `Olá, ${r.name.split(' ')[0]}! Aqui é da Copo Cheio, sobre o seu pedido de privacidade.`)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex h-8 items-center gap-1.5 rounded-xl bg-[#25D366] px-3 text-xs font-bold text-[#04210F] hover:bg-[#3DE07A]"
                      >
                        <MessageCircle className="h-3.5 w-3.5" aria-hidden="true" /> Responder no WhatsApp
                      </a>
                    ) : (
                      <a href={`mailto:${r.contact}`} className="inline-flex h-8 items-center gap-1.5 rounded-xl border border-white/15 px-3 text-xs font-bold text-white hover:bg-white/10">
                        <Mail className="h-3.5 w-3.5" aria-hidden="true" /> Responder por e-mail
                      </a>
                    )}
                    {r.status === 'open' ? (
                      <>
                        <Button size="sm" variant="secondary" onClick={() => (setNote(''), setDecision({ request: r, status: 'done' }))}>
                          Marcar como atendido
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => (setNote(''), setDecision({ request: r, status: 'rejected' }))}>
                          Recusar
                        </Button>
                      </>
                    ) : (
                      <Button size="sm" variant="ghost" onClick={() => (setNote(r.handled_note ?? ''), setDecision({ request: r, status: 'open' }))}>
                        Reabrir
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {closed.length > 0 && (
            <button type="button" onClick={() => setShowAll((v) => !v)} className="mt-3 text-sm font-semibold text-[#8FB1FF] hover:text-white">
              {showAll ? 'Esconder os já tratados' : `Mostrar os já tratados (${closed.length})`}
            </button>
          )}
        </>
      )}

      <Modal
        open={Boolean(decision)}
        onClose={() => setDecision(null)}
        size="sm"
        title={decision?.status === 'done' ? 'Marcar como atendido' : decision?.status === 'rejected' ? 'Recusar o pedido' : 'Reabrir o pedido'}
        description={decision ? `${decision.request.name} · ${KIND_LABEL[decision.request.kind]}` : undefined}
        footer={
          <>
            <Button variant="secondary" onClick={() => setDecision(null)}>
              Cancelar
            </Button>
            <Button type="submit" form="privacidade-decisao" loading={busy}>
              Confirmar
            </Button>
          </>
        }
      >
        <form id="privacidade-decisao" onSubmit={decide} noValidate className="space-y-4">
          <Field label="Observação (opcional)" hint="Fica registrada junto com o seu nome. Não escreva dados pessoais.">
            {(p) => <input {...p} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} className={INPUT} />}
          </Field>
        </form>
      </Modal>

      <Modal
        open={Boolean(wipe)}
        onClose={() => setWipe(null)}
        size="sm"
        title="Anonimizar os dados de uma pessoa"
        description="Use a pedido do titular. Apaga a conta e tira dos pedidos antigos o nome, o telefone, o e-mail, o endereço e as observações. Não dá para desfazer."
        footer={
          <>
            <Button variant="secondary" onClick={() => setWipe(null)}>
              Cancelar
            </Button>
            <Button type="submit" form="privacidade-anonimizar" variant="danger" loading={busy}>
              Anonimizar
            </Button>
          </>
        }
      >
        {wipe && (
          <form id="privacidade-anonimizar" onSubmit={anonymize} noValidate className="space-y-4">
            <p className="text-sm text-white/70">Informe o telefone ou o e-mail que a pessoa usou nos pedidos. Os valores e os itens dos pedidos continuam no histórico da loja.</p>
            <Field label="Telefone com DDD">
              {(p) => <input {...p} type="tel" value={wipe.phone} onChange={(e) => setWipe({ ...wipe, phone: maskPhone(e.target.value) })} className={INPUT} placeholder="(34) 99999-0000" />}
            </Field>
            <Field label="E-mail">
              {(p) => <input {...p} type="email" value={wipe.email} onChange={(e) => setWipe({ ...wipe, email: e.target.value })} className={INPUT} />}
            </Field>
            {wipeError && (
              <p role="alert" className="text-sm font-medium text-rose-300">
                {wipeError}
              </p>
            )}
          </form>
        )}
      </Modal>
    </Card>
  );
}
