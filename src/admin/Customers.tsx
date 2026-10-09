import { Check, Copy, ExternalLink, KeyRound, MessageCircle, Search, Trash2, Users } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api, friendlyError } from '../lib/api';
import { formatDateTime, formatPhone, timeAgo, whatsappTo } from '../lib/format';
import { copyText } from '../lib/tracking';
import type { CustomerRow } from '../lib/types';
import { useAdmin } from './AdminApp';
import { Badge, Button, Card, EmptyState, ErrorState, INPUT, PageHeader, Skeleton, cx, useConfirm, useToast } from './ui';

type ResetLink = { customer: CustomerRow; token: string; expires_at: string };

// Contas de clientes (opcionais). A loja não vê senhas: só ajuda a recuperar o acesso, desativa ou exclui a pedido do titular.
export default function CustomersPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const { user } = useAdmin();
  const [query, setQuery] = useState(() => new URLSearchParams(window.location.search).get('q') ?? '');
  const [term, setTerm] = useState(query.trim());
  const [customers, setCustomers] = useState<CustomerRow[] | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [reset, setReset] = useState<ResetLink | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setTerm(query.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ customers: CustomerRow[] }>(`/api/admin/customers${term ? `?q=${encodeURIComponent(term)}` : ''}`);
      setCustomers(data.customers);
      setError(false);
    } catch {
      setError(true);
    }
  }, [term]);

  useEffect(() => {
    void load();
  }, [load]);

  const url = reset ? `${window.location.origin}/conta/redefinir/${reset.token}` : '';

  const makeReset = async (c: CustomerRow) => {
    setBusy(`reset:${c.id}`);
    try {
      const data = await api.post<{ token: string; expires_at: string }>(`/api/admin/customers/${c.id}/reset-link`, {});
      setReset({ customer: c, ...data });
      setCopied(false);
    } catch (err) {
      toast.error('Não foi possível gerar o link.', friendlyError(err, ''));
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (c: CustomerRow) => {
    if (c.active) {
      const ok = await confirm({
        title: `Desativar a conta de ${c.name}?`,
        description: 'A pessoa é desconectada e não consegue entrar até você reativar. Os pedidos continuam guardados.',
        confirmLabel: 'Desativar',
      });
      if (!ok) return;
    }
    setBusy(`toggle:${c.id}`);
    try {
      await api.patch(`/api/admin/customers/${c.id}`, { active: !c.active });
      toast.success(c.active ? 'Conta desativada.' : 'Conta reativada.');
      void load();
    } catch (err) {
      toast.error('Não foi possível atualizar a conta.', friendlyError(err, ''));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (c: CustomerRow) => {
    const ok = await confirm({
      title: `Excluir a conta de ${c.name}?`,
      description: 'Use quando o titular pedir a exclusão dos dados. Apaga o cadastro e o endereço guardado; os pedidos ficam no histórico da loja, sem ligação com a conta. Não dá para desfazer.',
      confirmLabel: 'Excluir conta',
    });
    if (!ok) return;
    setBusy(`del:${c.id}`);
    try {
      await api.delete(`/api/admin/customers/${c.id}`);
      toast.success('Conta excluída.');
      void load();
    } catch (err) {
      toast.error('Não foi possível excluir a conta.', friendlyError(err, ''));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <PageHeader title="Clientes" description="Contas criadas no site. Criar conta é opcional: quem compra como visitante não aparece aqui." />

      {reset && (
        <Card className="mb-4" title={`Link para ${reset.customer.name} criar uma senha nova`} description={`Vale uma vez e expira em ${formatDateTime(reset.expires_at)}. Envie só depois de confirmar que é a própria pessoa.`}>
          <input readOnly value={url} aria-label="Link de redefinição" onFocus={(e) => e.currentTarget.select()} className={cx(INPUT, 'text-xs')} />
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              icon={copied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
              onClick={() => void copyText(url).then((ok) => (ok ? setCopied(true) : toast.error('Não foi possível copiar.', 'Selecione o link e copie à mão.')))}
            >
              {copied ? 'Copiado' : 'Copiar'}
            </Button>
            <a
              href={whatsappTo(reset.customer.phone, `Olá, ${reset.customer.name.split(' ')[0]}! Aqui é da Copo Cheio. Use este link para criar uma senha nova (vale uma vez):\n${url}`)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-8 items-center gap-1.5 rounded-xl bg-[#25D366] px-3 text-xs font-bold text-[#04210F] hover:bg-[#3DE07A]"
            >
              <MessageCircle className="h-3.5 w-3.5" aria-hidden="true" /> Enviar por WhatsApp
            </a>
            <Button size="sm" variant="ghost" onClick={() => setReset(null)}>
              Fechar
            </Button>
          </div>
        </Card>
      )}

      <label className="relative mb-4 block sm:w-96">
        <span className="sr-only">Buscar clientes</span>
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/35" aria-hidden="true" />
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Nome, e-mail ou telefone" className={cx(INPUT, 'pl-9')} />
      </label>

      {error && !customers ? (
        <Card>
          <ErrorState message="Não foi possível carregar os clientes." onRetry={() => void load()} />
        </Card>
      ) : !customers ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-16 rounded-2xl" />
          ))}
        </div>
      ) : customers.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Users className="h-6 w-6" aria-hidden="true" />}
            title={term ? 'Nenhum cliente encontrado' : 'Nenhuma conta criada ainda'}
            description={term ? 'Tente outro nome, e-mail ou telefone.' : 'Quando um cliente criar uma conta no site, ela aparece aqui.'}
          />
        </Card>
      ) : (
        <ul className="space-y-2.5">
          {customers.map((c) => (
            <li key={c.id} className={cx('rounded-2xl border bg-[#0C1018] p-4', c.active ? 'border-white/[0.08]' : 'border-rose-500/25')}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 font-bold text-white">
                    {c.name}
                    {!c.active && <Badge tone="red">Desativada</Badge>}
                  </p>
                  <p className="truncate text-sm text-white/65">{c.email}</p>
                  <p className="text-xs text-white/45">
                    {formatPhone(c.phone)} · cadastro em {formatDateTime(c.created_at)} · {c.last_login_at ? `último acesso ${timeAgo(c.last_login_at)}` : 'nunca entrou depois do cadastro'}
                  </p>
                </div>
                <a href={`/admin/pedidos?q=${encodeURIComponent(c.email)}`} className="inline-flex items-center gap-1.5 text-sm font-semibold text-[#8FB1FF] hover:text-white">
                  {c.orders} {c.orders === 1 ? 'pedido' : 'pedidos'} <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                </a>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" icon={<KeyRound className="h-3.5 w-3.5" aria-hidden="true" />} loading={busy === `reset:${c.id}`} onClick={() => void makeReset(c)}>
                  Link para nova senha
                </Button>
                <Button size="sm" variant="secondary" loading={busy === `toggle:${c.id}`} onClick={() => void toggle(c)}>
                  {c.active ? 'Desativar' : 'Reativar'}
                </Button>
                {user.role === 'owner' && (
                  <Button size="sm" variant="danger-ghost" icon={<Trash2 className="h-3.5 w-3.5" aria-hidden="true" />} loading={busy === `del:${c.id}`} onClick={() => void remove(c)}>
                    Excluir
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
