import { Bike, Pencil, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, friendlyError } from '../lib/api';
import { formatPhone, onlyDigits } from '../lib/format';
import type { Courier } from '../lib/types';
import { Badge, Button, Card, Field, INPUT, IconButton, Modal, Spinner, Switch, useConfirm, useToast } from './ui';

// Entregadores: o essencial. O nome do entregador escolhido fica gravado no pedido (mudar ou apagar o cadastro depois não mexe no histórico).

export function CouriersCard() {
  const toast = useToast();
  const confirm = useConfirm();
  const [rows, setRows] = useState<Courier[] | null>(null);
  const [editing, setEditing] = useState<{ id?: string; name: string; phone: string; active: boolean } | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setRows((await api.get<{ couriers: Courier[] }>('/api/admin/couriers')).couriers);
    } catch {
      setRows([]);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    const name = editing.name.trim();
    if (name.length < 2) return setError('Informe o nome do entregador.');
    const phone = onlyDigits(editing.phone);
    if (phone && (phone.length < 10 || phone.length > 13)) return setError('Informe o telefone com DDD, ou deixe vazio.');
    setSaving(true);
    setError('');
    try {
      const body = { name, phone: phone || null, active: editing.active };
      if (editing.id) await api.patch(`/api/admin/couriers/${editing.id}`, body);
      else await api.post('/api/admin/couriers', body);
      toast.success('Entregador salvo.');
      setEditing(null);
      void load();
    } catch (err) {
      setError(friendlyError(err, 'Não foi possível salvar.'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (c: Courier) => {
    if (!(await confirm({ title: `Remover ${c.name}?`, description: 'Os pedidos antigos continuam com o nome dele. Para só parar de usar, prefira desativar.', confirmLabel: 'Remover' }))) return;
    try {
      await api.delete(`/api/admin/couriers/${c.id}`);
      toast.success('Entregador removido.');
      void load();
    } catch (err) {
      toast.error('Não foi possível remover.', friendlyError(err, ''));
    }
  };

  return (
    <div data-couriers>
      <Card
        title="Entregadores"
        description="Cadastre quem entrega e escolha o entregador em cada pedido de entrega. O cliente vê só o primeiro nome, enquanto o pedido está a caminho."
        actions={
          <Button size="sm" icon={<Plus className="h-4 w-4" aria-hidden="true" />} onClick={() => (setError(''), setEditing({ name: '', phone: '', active: true }))} data-courier-new>
            Entregador
          </Button>
        }
        padded={false}
      >
        {!rows ? (
          <Spinner />
        ) : rows.length === 0 ? (
          <p className="px-5 py-6 text-sm text-white/60">Nenhum entregador cadastrado.</p>
        ) : (
          <ul className="divide-y divide-white/[0.06]">
            {rows.map((c) => (
              <li key={c.id} data-courier={c.name} className="flex flex-wrap items-center gap-3 px-4 py-2.5 sm:px-5">
                <Bike className="h-4 w-4 shrink-0 text-white/45" aria-hidden="true" />
                <span className="min-w-0 flex-1 basis-40">
                  <span className="block truncate font-semibold text-white">{c.name}</span>
                  {c.phone && <span className="block text-xs text-white/55">{formatPhone(c.phone)}</span>}
                </span>
                {!c.active && <Badge>Desativado</Badge>}
                {(c.on_route ?? 0) > 0 && <Badge tone="blue">{c.on_route} a caminho</Badge>}
                <Button size="sm" variant="ghost" onClick={() => (setError(''), setEditing({ id: c.id, name: c.name, phone: c.phone ? formatPhone(c.phone) : '', active: c.active }))}>
                  <Pencil className="h-3.5 w-3.5" aria-hidden="true" /> Editar
                </Button>
                <IconButton label={`Remover ${c.name}`} className="hover:text-rose-300" onClick={() => void remove(c)}>
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Modal
        open={Boolean(editing)}
        onClose={() => (saving ? undefined : setEditing(null))}
        size="sm"
        title={editing?.id ? 'Editar entregador' : 'Novo entregador'}
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(null)} disabled={saving}>
              Cancelar
            </Button>
            <Button type="submit" form="entregador-form" loading={saving}>
              Salvar
            </Button>
          </>
        }
      >
        {editing && (
          <form id="entregador-form" onSubmit={save} noValidate className="space-y-4">
            <Field label="Nome" count={editing.name.length} max={60}>
              {(p) => <input {...p} className={INPUT} maxLength={60} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} data-courier-name />}
            </Field>
            <Field label="Telefone (opcional)">
              {(p) => <input {...p} className={INPUT} inputMode="tel" value={editing.phone} onChange={(e) => setEditing({ ...editing, phone: e.target.value })} placeholder="(34) 99999-0000" />}
            </Field>
            <Switch checked={editing.active} onChange={(v) => setEditing({ ...editing, active: v })} label="Ativo" description="Desativado, ele não aparece para escolher nos pedidos." />
            {error && (
              <p role="alert" className="text-sm font-medium text-rose-300">
                {error}
              </p>
            )}
          </form>
        )}
      </Modal>
    </div>
  );
}

// No detalhe do pedido de entrega: escolher quem leva.
export function CourierPicker({ orderId, current, onChanged }: { orderId: string; current: string | null | undefined; onChanged: (name: string | null, id: string | null) => void }) {
  const toast = useToast();
  const [list, setList] = useState<Courier[]>([]);
  const [busy, setBusy] = useState(false);
  const [value, setValue] = useState('');

  useEffect(() => {
    let alive = true;
    api.get<{ couriers: Courier[] }>('/api/admin/couriers').then(
      (d) => alive && setList(d.couriers.filter((c) => c.active)),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, []);

  const choose = async (courierId: string) => {
    setBusy(true);
    try {
      const { order } = await api.patch<{ order: { courier_id: string | null; courier_name: string | null } }>(`/api/admin/orders/${orderId}/courier`, { courier_id: courierId || null });
      setValue(courierId);
      onChanged(order.courier_name, order.courier_id);
      toast.success(order.courier_name ? `Entregador: ${order.courier_name}` : 'Entregador removido do pedido.');
    } catch (e) {
      toast.error('Não foi possível salvar o entregador.', friendlyError(e, ''));
    } finally {
      setBusy(false);
    }
  };

  if (list.length === 0 && !current) return null;
  return (
    <Card title="Entregador" description={current ? `Atual: ${current}` : 'Quem vai levar este pedido.'}>
      <div data-courier-picker>
        <label className="sr-only" htmlFor="entregador-do-pedido">
          Entregador do pedido
        </label>
        <select id="entregador-do-pedido" className={INPUT} disabled={busy} value={value} onChange={(e) => void choose(e.target.value)}>
          <option value="">{current ? 'Tirar o entregador' : 'Escolha o entregador'}</option>
          {list.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
    </Card>
  );
}
