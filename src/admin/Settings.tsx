import { Bell, Clock, CreditCard, Plus, Store, Trash2, Truck, Users } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { formatPhone, maskPhone, money, moneyInput, onlyDigits, parseMoney } from '../lib/format';
import { DAYS, isOpenNow } from '../lib/hours';
import { friendlyError } from '../lib/supabase';
import type { AdminUser, DeliveryZone, OpeningHours, StoreSettings } from '../lib/types';
import { playOrderChime, useAdmin, useLiveOrders } from './AdminApp';
import { admin } from './client';
import { Badge, Button, Card, ErrorState, Field, INPUT, IconButton, Modal, PageHeader, Spinner, Switch, cx, useConfirm, useToast } from './ui';

const TABS = [
  { id: 'loja', label: 'Loja', icon: Store },
  { id: 'horarios', label: 'Horários', icon: Clock },
  { id: 'entrega', label: 'Entrega', icon: Truck },
  { id: 'pagamento', label: 'Pagamento', icon: CreditCard },
  { id: 'painel', label: 'Painel', icon: Bell },
  { id: 'equipe', label: 'Administradores', icon: Users },
] as const;
type Tab = (typeof TABS)[number]['id'];

const UFS = 'AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO'.split(' ');

// Salva só os campos de uma aba; o resto da linha fica como está.
function useStoreSave(onSaved: (s: StoreSettings) => void) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const save = async (change: Partial<StoreSettings>, message: string) => {
    setSaving(true);
    const { data, error } = await admin.from('store_settings').update(change).eq('id', 1).select().single();
    setSaving(false);
    if (error) {
      toast.error('Não foi possível salvar.', friendlyError(error, ''));
      return false;
    }
    onSaved(data as StoreSettings);
    toast.success(message, 'O site já usa os novos dados.');
    return true;
  };
  return { saving, save };
}

function Footer({ saving, children }: { saving: boolean; children?: ReactNode }) {
  return (
    <div className="mt-5 flex items-center justify-end gap-3 border-t border-white/[0.06] pt-4">
      {children}
      <Button type="submit" loading={saving}>
        Salvar
      </Button>
    </div>
  );
}

// ---- Loja ---------------------------------------------------------------------------------------

function StoreTab({ store, onSaved }: { store: StoreSettings; onSaved: (s: StoreSettings) => void }) {
  const { saving, save } = useStoreSave(onSaved);
  const [form, setForm] = useState({
    store_name: store.store_name,
    whatsapp: formatPhone(store.whatsapp),
    instagram: store.instagram ? `@${store.instagram}` : '',
    address: store.address ?? '',
    cep: store.cep ? store.cep.replace(/^(\d{5})(\d{3})$/, '$1-$2') : '',
    city: store.city ?? '',
    state: store.state ?? '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (key: keyof typeof form, value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => ({ ...e, [key]: '' }));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const next: Record<string, string> = {};
    const phone = onlyDigits(form.whatsapp);
    const whatsapp = phone ? (phone.length <= 11 ? `55${phone}` : phone) : null;
    if (whatsapp && !/^\d{12,13}$/.test(whatsapp)) next.whatsapp = 'Informe DDD + número. Ex.: (34) 99999-0000';
    const instagram = form.instagram.trim().replace(/^@/, '').replace(/^https?:\/\/(www\.)?instagram\.com\//, '').replace(/\/.*$/, '');
    if (instagram && !/^[A-Za-z0-9._]{1,30}$/.test(instagram)) next.instagram = 'Só letras, números, ponto e _.';
    const cep = onlyDigits(form.cep);
    if (cep && cep.length !== 8) next.cep = 'O CEP tem 8 números.';
    if (form.store_name.trim().length < 2) next.store_name = 'Informe o nome.';
    setErrors(next);
    if (Object.keys(next).length) return;
    await save(
      {
        store_name: form.store_name.trim(),
        whatsapp,
        instagram: instagram || null,
        address: form.address.trim() || null,
        cep: cep || null,
        city: form.city.trim() || null,
        state: form.state || null,
      },
      'Dados da loja salvos.',
    );
  };

  return (
    <form onSubmit={submit} noValidate>
      <Card title="Dados da loja" description="Usados no site (Contato, rodapé, botões de WhatsApp) e na mensagem do pedido.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nome da loja" error={errors.store_name} count={form.store_name.length} max={30}>
            {(p) => <input {...p} value={form.store_name} maxLength={30} onChange={(e) => set('store_name', e.target.value)} className={INPUT} />}
          </Field>
          <Field label="WhatsApp da loja" error={errors.whatsapp} hint="Recebe as mensagens dos pedidos. Vazio: o cliente escolhe o contato.">
            {(p) => <input {...p} type="tel" value={form.whatsapp} onChange={(e) => set('whatsapp', maskPhone(e.target.value))} className={INPUT} placeholder="(34) 99999-0000" />}
          </Field>
          <Field label="Instagram" error={errors.instagram}>
            {(p) => <input {...p} value={form.instagram} onChange={(e) => set('instagram', e.target.value)} className={INPUT} placeholder="@copocheiodisk" />}
          </Field>
          <Field label="Endereço" hint="Rua e número. Com endereço, o site mostra o mapa e “Como chegar”." count={form.address.length} max={160}>
            {(p) => <input {...p} value={form.address} maxLength={160} onChange={(e) => set('address', e.target.value)} className={INPUT} />}
          </Field>
          <Field label="CEP" error={errors.cep}>
            {(p) => (
              <input
                {...p}
                inputMode="numeric"
                value={form.cep}
                onChange={(e) => set('cep', onlyDigits(e.target.value).slice(0, 8).replace(/^(\d{5})(\d)/, '$1-$2'))}
                className={INPUT}
                placeholder="00000-000"
              />
            )}
          </Field>
          <div className="grid grid-cols-[1fr_6rem] gap-3">
            <Field label="Cidade">
              {(p) => <input {...p} value={form.city} maxLength={60} onChange={(e) => set('city', e.target.value)} className={INPUT} />}
            </Field>
            <Field label="Estado">
              {(p) => (
                <select {...p} value={form.state} onChange={(e) => set('state', e.target.value)} className={INPUT}>
                  <option value="">—</option>
                  {UFS.map((uf) => (
                    <option key={uf} value={uf}>
                      {uf}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </div>
        </div>
        <Footer saving={saving} />
      </Card>
    </form>
  );
}

// ---- Horários ----------------------------------------------------------------------------------

function HoursTab({ store, onSaved }: { store: StoreSettings; onSaved: (s: StoreSettings) => void }) {
  const { saving, save } = useStoreSave(onSaved);
  const [hours, setHours] = useState<OpeningHours>(store.opening_hours);
  const [paused, setPaused] = useState(store.orders_paused);
  const openNow = !paused && isOpenNow(hours, store.timezone);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    await save({ opening_hours: hours, orders_paused: paused }, 'Horários salvos.');
  };

  return (
    <form onSubmit={submit} noValidate>
      <Card
        title="Horário de funcionamento"
        description="Fora do horário o site mostra “Fechado” e não aceita pedidos."
        actions={openNow ? <Badge tone="green">Aberto agora</Badge> : <Badge tone="red">Fechado agora</Badge>}
      >
        <ul className="divide-y divide-white/[0.06]">
          {DAYS.map((day) => {
            const h = hours[day.key];
            const set = (change: Partial<typeof h>) => setHours((all) => ({ ...all, [day.key]: { ...all[day.key], ...change } }));
            return (
              <li key={day.key} className="grid grid-cols-[6.5rem_auto_1fr] items-center gap-3 py-3 sm:grid-cols-[8rem_auto_1fr]">
                <span className="text-sm font-semibold text-white">{day.label}</span>
                <Switch checked={h.open} onChange={(v) => set({ open: v })} />
                {h.open ? (
                  <div className="flex items-center gap-2">
                    <input type="time" aria-label={`${day.label}: abre às`} value={h.start} onChange={(e) => set({ start: e.target.value })} className={cx(INPUT, 'w-28 [color-scheme:dark]')} />
                    <span className="text-sm text-white/40">às</span>
                    <input type="time" aria-label={`${day.label}: fecha às`} value={h.end} onChange={(e) => set({ end: e.target.value })} className={cx(INPUT, 'w-28 [color-scheme:dark]')} />
                  </div>
                ) : (
                  <span className="text-sm text-white/40">Fechado</span>
                )}
              </li>
            );
          })}
        </ul>
        <p className="mt-3 text-xs text-white/45">Fecha depois da meia-noite? Coloque o fim menor que o início (ex.: 18:00 às 02:00). Início igual ao fim = 24 horas.</p>
        <div className="mt-5 rounded-xl border border-amber-400/20 bg-amber-400/[0.06] p-4">
          <Switch checked={paused} onChange={setPaused} label="Pausar pedidos pelo site" description="Para dias de muito movimento ou imprevistos: o site mostra a loja fechada até você desligar." />
        </div>
        <Footer saving={saving} />
      </Card>
    </form>
  );
}

// ---- Entrega ------------------------------------------------------------------------------------

function DeliveryTab({ store, onSaved }: { store: StoreSettings; onSaved: (s: StoreSettings) => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { saving, save } = useStoreSave(onSaved);
  const [form, setForm] = useState({
    delivery_enabled: store.delivery_enabled,
    pickup_enabled: store.pickup_enabled,
    fee: moneyInput(Number(store.delivery_fee)),
    min: moneyInput(Number(store.min_order)),
    time: store.delivery_time ?? '',
  });
  const [zones, setZones] = useState<DeliveryZone[] | null>(null);
  const [zone, setZone] = useState<{ id?: string; name: string; fee: string; active: boolean } | null>(null);
  const [zoneError, setZoneError] = useState('');

  const loadZones = useCallback(async () => {
    const { data } = await admin.from('delivery_zones').select('*').order('position').order('name');
    setZones(((data ?? []) as DeliveryZone[]).map((z) => ({ ...z, fee: Number(z.fee) })));
  }, []);
  useEffect(() => {
    void loadZones();
  }, [loadZones]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const fee = parseMoney(form.fee) ?? 0;
    const min = parseMoney(form.min) ?? 0;
    if (Number.isNaN(fee) || Number.isNaN(min)) {
      toast.error('Confira os valores.', 'Use o formato 5,00');
      return;
    }
    if (!form.delivery_enabled && !form.pickup_enabled) {
      toast.error('Deixe pelo menos uma opção ativa.', 'Delivery ou retirada.');
      return;
    }
    await save(
      { delivery_enabled: form.delivery_enabled, pickup_enabled: form.pickup_enabled, delivery_fee: fee, min_order: min, delivery_time: form.time.trim() || null },
      'Entrega salva.',
    );
  };

  const saveZone = async (e: FormEvent) => {
    e.preventDefault();
    if (!zone) return;
    const fee = parseMoney(zone.fee);
    if (!zone.name.trim()) return setZoneError('Informe o bairro.');
    if (fee === null || Number.isNaN(fee)) return setZoneError('Informe a taxa. Ex.: 7,00');
    const row = { name: zone.name.trim(), fee, active: zone.active };
    const { error } = zone.id ? await admin.from('delivery_zones').update(row).eq('id', zone.id) : await admin.from('delivery_zones').insert({ ...row, position: zones?.length ?? 0 });
    if (error) return setZoneError(error.code === '23505' ? 'Esse bairro já está na lista.' : friendlyError(error, 'Não foi possível salvar.'));
    toast.success('Bairro salvo.');
    setZone(null);
    void loadZones();
  };

  const removeZone = async (z: DeliveryZone) => {
    if (!(await confirm({ title: `Remover ${z.name}?`, confirmLabel: 'Remover' }))) return;
    const { error } = await admin.from('delivery_zones').delete().eq('id', z.id);
    if (error) toast.error('Não foi possível remover.');
    else {
      toast.success('Bairro removido.');
      void loadZones();
    }
  };

  const activeZones = zones?.filter((z) => z.active).length ?? 0;

  return (
    <div className="space-y-4">
      <form onSubmit={submit} noValidate>
        <Card title="Delivery e retirada">
          <div className="space-y-4">
            <Switch checked={form.delivery_enabled} onChange={(v) => setForm({ ...form, delivery_enabled: v })} label="Ativar delivery" description="O cliente informa o endereço e paga a taxa de entrega." />
            <Switch checked={form.pickup_enabled} onChange={(v) => setForm({ ...form, pickup_enabled: v })} label="Ativar retirada na loja" description="Sem taxa de entrega." />
          </div>
          <div className="mt-5 grid gap-4 sm:grid-cols-3">
            <Field label="Taxa de entrega" hint={activeZones ? 'Com bairros cadastrados, vale a taxa de cada bairro.' : 'Taxa única para qualquer endereço.'}>
              {(p) => <input {...p} inputMode="decimal" value={form.fee} onChange={(e) => setForm({ ...form, fee: e.target.value })} className={INPUT} placeholder="5,00" />}
            </Field>
            <Field label="Pedido mínimo (entrega)" hint="0 = sem mínimo.">
              {(p) => <input {...p} inputMode="decimal" value={form.min} onChange={(e) => setForm({ ...form, min: e.target.value })} className={INPUT} placeholder="0,00" />}
            </Field>
            <Field label="Tempo estimado" count={form.time.length} max={30}>
              {(p) => <input {...p} value={form.time} maxLength={30} onChange={(e) => setForm({ ...form, time: e.target.value })} className={INPUT} placeholder="30 a 45 min" />}
            </Field>
          </div>
          <Footer saving={saving} />
        </Card>
      </form>

      <Card
        title="Taxa por bairro"
        description="Opcional. Cadastrando bairros, o cliente escolhe o seu na lista e a taxa é a do bairro; bairros fora da lista não recebem entrega."
        actions={
          <Button size="sm" icon={<Plus className="h-4 w-4" aria-hidden="true" />} onClick={() => (setZoneError(''), setZone({ name: '', fee: '', active: true }))}>
            Bairro
          </Button>
        }
        padded={false}
      >
        {!zones ? (
          <Spinner />
        ) : zones.length === 0 ? (
          <p className="px-5 py-6 text-sm text-white/45">Nenhum bairro cadastrado: vale a taxa única.</p>
        ) : (
          <ul className="divide-y divide-white/[0.06]">
            {zones.map((z) => (
              <li key={z.id} className="flex items-center gap-3 px-4 py-2.5 sm:px-5">
                <span className="min-w-0 flex-1 truncate font-semibold text-white">{z.name}</span>
                {!z.active && <Badge>Inativo</Badge>}
                <span className="text-sm tabular-nums text-white/75">{money(z.fee)}</span>
                <Button size="sm" variant="ghost" onClick={() => (setZoneError(''), setZone({ id: z.id, name: z.name, fee: moneyInput(z.fee), active: z.active }))}>
                  Editar
                </Button>
                <IconButton label={`Remover ${z.name}`} className="hover:text-rose-300" onClick={() => void removeZone(z)}>
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Modal
        open={Boolean(zone)}
        onClose={() => setZone(null)}
        size="sm"
        title={zone?.id ? 'Editar bairro' : 'Novo bairro'}
        footer={
          <>
            <Button variant="secondary" onClick={() => setZone(null)}>
              Cancelar
            </Button>
            <Button type="submit" form="bairro-form">
              Salvar
            </Button>
          </>
        }
      >
        {zone && (
          <form id="bairro-form" onSubmit={saveZone} noValidate className="space-y-4">
            <Field label="Bairro">
              {(p) => <input {...p} value={zone.name} maxLength={60} onChange={(e) => setZone({ ...zone, name: e.target.value })} className={INPUT} />}
            </Field>
            <Field label="Taxa de entrega">
              {(p) => <input {...p} inputMode="decimal" value={zone.fee} onChange={(e) => setZone({ ...zone, fee: e.target.value })} className={INPUT} placeholder="7,00" />}
            </Field>
            <Switch checked={zone.active} onChange={(v) => setZone({ ...zone, active: v })} label="Ativo" />
            {zoneError && <p className="text-sm text-rose-300">{zoneError}</p>}
          </form>
        )}
      </Modal>
    </div>
  );
}

// ---- Pagamento ----------------------------------------------------------------------------------

function PaymentTab({ store, onSaved }: { store: StoreSettings; onSaved: (s: StoreSettings) => void }) {
  const toast = useToast();
  const { saving, save } = useStoreSave(onSaved);
  const [form, setForm] = useState({ pix: store.pix_enabled, cash: store.cash_enabled, card: store.card_enabled, key: store.pix_key ?? '' });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!form.pix && !form.cash && !form.card) {
      toast.error('Deixe pelo menos uma forma de pagamento ativa.');
      return;
    }
    await save({ pix_enabled: form.pix, cash_enabled: form.cash, card_enabled: form.card, pix_key: form.key.trim() || null }, 'Pagamentos salvos.');
  };

  return (
    <form onSubmit={submit} noValidate>
      <Card title="Formas de pagamento" description="O cliente escolhe no checkout. O pagamento online ainda não está ligado: PIX é enviado pelo cliente; dinheiro e cartão são pagos na entrega/retirada.">
        <div className="space-y-4">
          <Switch checked={form.pix} onChange={(v) => setForm({ ...form, pix: v })} label={<>PIX {form.pix ? <Badge tone="green">ATIVO</Badge> : <Badge>INATIVO</Badge>}</>} />
          <Switch checked={form.cash} onChange={(v) => setForm({ ...form, cash: v })} label={<>Dinheiro {form.cash ? <Badge tone="green">ATIVO</Badge> : <Badge>INATIVO</Badge>}</>} description="O cliente pode informar o troco." />
          <Switch checked={form.card} onChange={(v) => setForm({ ...form, card: v })} label={<>Cartão {form.card ? <Badge tone="green">ATIVO</Badge> : <Badge>INATIVO</Badge>}</>} description="Na maquininha, na entrega ou na retirada." />
        </div>
        <Field label="Chave PIX" hint="Aparece para o cliente depois que ele finaliza um pedido com PIX." count={form.key.length} max={100} className="mt-5 sm:max-w-md">
          {(p) => <input {...p} value={form.key} maxLength={100} onChange={(e) => setForm({ ...form, key: e.target.value })} className={INPUT} placeholder="CNPJ, e-mail, telefone ou chave aleatória" />}
        </Field>
        <Footer saving={saving} />
      </Card>
    </form>
  );
}

// ---- Painel (som) -------------------------------------------------------------------------------

function PanelTab() {
  const { sound, setSound } = useLiveOrders();
  return (
    <Card title="Notificações" description="Vale para este aparelho.">
      <Switch checked={sound} onChange={setSound} label={<>Som de novos pedidos {sound ? <Badge tone="green">ON</Badge> : <Badge>OFF</Badge>}</>} description="Toca um aviso quando chega um pedido novo (com o painel aberto)." />
      <Button variant="secondary" className="mt-4" onClick={playOrderChime}>
        Testar som
      </Button>
    </Card>
  );
}

// ---- Administradores ----------------------------------------------------------------------------

function TeamTab() {
  const toast = useToast();
  const confirm = useConfirm();
  const { user } = useAdmin();
  const owner = user.role === 'owner';
  const [team, setTeam] = useState<AdminUser[] | null>(null);
  const [adding, setAdding] = useState<{ email: string; name: string; role: 'admin' | 'owner' } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data } = await admin.from('admin_users').select('*').order('created_at');
    setTeam((data ?? []) as AdminUser[]);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!adding) return;
    setBusy(true);
    const { error: err } = await admin.rpc('add_admin', { p_email: adding.email, p_name: adding.name, p_role: adding.role });
    setBusy(false);
    if (err) return setError(friendlyError(err, 'Não foi possível adicionar.'));
    toast.success('Administrador adicionado.');
    setAdding(null);
    void load();
  };

  const update = async (a: AdminUser, change: Partial<AdminUser>, message: string) => {
    const { error: err } = await admin.from('admin_users').update(change).eq('id', a.id);
    if (err) toast.error('Não foi possível salvar.', friendlyError(err, ''));
    else {
      toast.success(message);
      void load();
    }
  };

  const remove = async (a: AdminUser) => {
    if (!(await confirm({ title: `Remover ${a.name} do painel?`, description: 'A conta continua existindo no Supabase, mas perde o acesso ao painel.', confirmLabel: 'Remover acesso' }))) return;
    const { error: err } = await admin.from('admin_users').delete().eq('id', a.id);
    if (err) toast.error('Não foi possível remover.', friendlyError(err, ''));
    else {
      toast.success('Acesso removido.');
      void load();
    }
  };

  return (
    <Card
      title="Administradores"
      description={owner ? 'O owner tem acesso total e gerencia a equipe. Admins cuidam da operação.' : 'Só o owner pode alterar a equipe.'}
      actions={
        owner && (
          <Button size="sm" icon={<Plus className="h-4 w-4" aria-hidden="true" />} onClick={() => (setError(''), setAdding({ email: '', name: '', role: 'admin' }))}>
            Adicionar
          </Button>
        )
      }
      padded={false}
    >
      {!team ? (
        <Spinner />
      ) : (
        <ul className="divide-y divide-white/[0.06]">
          {team.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-5">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[#145CFF]/20 text-sm font-black text-[#9DBBFF]">{a.name.slice(0, 1).toUpperCase()}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold text-white">
                  {a.name} {a.user_id === user.user_id && <span className="text-xs font-normal text-white/40">(você)</span>}
                </p>
                <p className="truncate text-xs text-white/45">{a.email}</p>
              </div>
              <Badge tone={a.role === 'owner' ? 'blue' : 'gray'}>{a.role === 'owner' ? 'Owner' : 'Admin'}</Badge>
              {!a.active && <Badge tone="red">Inativo</Badge>}
              {owner && a.user_id !== user.user_id && (
                <div className="flex items-center gap-1">
                  <Button size="sm" variant="ghost" onClick={() => void update(a, { role: a.role === 'owner' ? 'admin' : 'owner' }, 'Função alterada.')}>
                    Tornar {a.role === 'owner' ? 'admin' : 'owner'}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void update(a, { active: !a.active }, a.active ? 'Acesso desativado.' : 'Acesso reativado.')}>
                    {a.active ? 'Desativar' : 'Reativar'}
                  </Button>
                  <IconButton label={`Remover ${a.name}`} className="hover:text-rose-300" onClick={() => void remove(a)}>
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </IconButton>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <Modal
        open={Boolean(adding)}
        onClose={() => setAdding(null)}
        size="sm"
        title="Adicionar administrador"
        description="Primeiro crie a conta no Supabase (Authentication → Users → Add user). Depois informe o e-mail aqui."
        footer={
          <>
            <Button variant="secondary" onClick={() => setAdding(null)}>
              Cancelar
            </Button>
            <Button type="submit" form="admin-form" loading={busy}>
              Adicionar
            </Button>
          </>
        }
      >
        {adding && (
          <form id="admin-form" onSubmit={add} noValidate className="space-y-4">
            <Field label="Nome">
              {(p) => <input {...p} value={adding.name} maxLength={80} onChange={(e) => setAdding({ ...adding, name: e.target.value })} className={INPUT} />}
            </Field>
            <Field label="E-mail da conta">
              {(p) => <input {...p} type="email" value={adding.email} onChange={(e) => setAdding({ ...adding, email: e.target.value })} className={INPUT} />}
            </Field>
            <Field label="Função">
              {(p) => (
                <select {...p} value={adding.role} onChange={(e) => setAdding({ ...adding, role: e.target.value as 'admin' | 'owner' })} className={INPUT}>
                  <option value="admin">Admin – pedidos, produtos e conteúdo</option>
                  <option value="owner">Owner – acesso total, inclusive equipe</option>
                </select>
              )}
            </Field>
            {error && <p className="text-sm text-rose-300">{error}</p>}
          </form>
        )}
      </Modal>
    </Card>
  );
}

export default function SettingsPage() {
  const [tab, setTab] = useState<Tab>(() => {
    const hash = window.location.hash.slice(1) as Tab;
    return TABS.some((t) => t.id === hash) ? hash : 'loja';
  });
  const [store, setStore] = useState<StoreSettings | null>(null);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    const { data, error: err } = await admin.from('store_settings').select('*').eq('id', 1).single();
    if (err) setError(true);
    else setStore(data as StoreSettings);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const choose = (id: Tab) => {
    setTab(id);
    window.history.replaceState(null, '', `#${id}`);
  };
  const body = useMemo(() => {
    if (!store) return null;
    switch (tab) {
      case 'loja':
        return <StoreTab store={store} onSaved={setStore} />;
      case 'horarios':
        return <HoursTab store={store} onSaved={setStore} />;
      case 'entrega':
        return <DeliveryTab store={store} onSaved={setStore} />;
      case 'pagamento':
        return <PaymentTab store={store} onSaved={setStore} />;
      case 'painel':
        return <PanelTab />;
      case 'equipe':
        return <TeamTab />;
    }
  }, [store, tab]);

  return (
    <>
      <PageHeader title="Configurações" description="Dados da loja, horários, entrega, pagamento e equipe." />
      <div role="tablist" aria-label="Seções" className="-mx-3 mb-4 flex gap-1 overflow-x-auto px-3 [scrollbar-width:none] sm:mx-0 sm:px-0">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => choose(id)}
            className={cx(
              'inline-flex shrink-0 items-center gap-2 rounded-xl px-3.5 py-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#5B8CFF]',
              tab === id ? 'bg-[#145CFF] text-white' : 'text-white/60 hover:bg-white/[0.05] hover:text-white',
            )}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
            {label}
          </button>
        ))}
      </div>
      {error ? <ErrorState message="Não foi possível carregar as configurações." onRetry={() => void load()} /> : !store ? <Spinner /> : <div role="tabpanel" key={tab}>{body}</div>}
    </>
  );
}
