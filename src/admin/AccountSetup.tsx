import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiError, api, friendlyError } from '../lib/api';
import type { MerchantAccount } from '../lib/types';
import { COMPANY_TYPE_OPTIONS, INCOME_OPTIONS, NET_WORTH_OPTIONS, OCCUPATION_OPTIONS, OWNER_INCOME_OPTIONS, REVENUE_OPTIONS } from './accountOptions';
import type { Option } from './accountOptions';
import { Badge, Button, Field, INPUT, Modal, Spinner, cx, useToast } from './ui';

// Conta (subconta) do estabelecimento na operadora: vincular uma que já existe ou cadastrar uma nova. Nada acontece sozinho: cada ação é
// do owner, com a autorização do titular e, em produção, a ciência das tarifas. Os dados pessoais vão direto para a operadora e NÃO ficam
// guardados neste site.

type Environment = 'sandbox' | 'production' | null;

type Candidate = { accountNumber: string; name: string | null; documentMasked: string | null; status: string; confirmed: boolean; linked: boolean };

function Check({ checked, onChange, children, error }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode; error?: boolean }) {
  return (
    <label className={cx('flex cursor-pointer items-start gap-3 rounded-xl border p-3 text-sm text-white/85', error ? 'border-rose-400/60 bg-rose-500/[0.06]' : 'border-white/10 bg-white/[0.03]')}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-[#145CFF]" />
      <span>{children}</span>
    </label>
  );
}

const money = (cents: number) => `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;

// ---- Vincular uma conta que já existe ----------------------------------------------------------------------------------------------

export function LinkAccountModal({ open, onClose, environment, onDone }: { open: boolean; onClose: () => void; environment: Environment; onDone: () => void }) {
  const toast = useToast();
  const [accounts, setAccounts] = useState<Candidate[] | null>(null);
  const [failed, setFailed] = useState('');
  const [chosen, setChosen] = useState('');
  const [authorized, setAuthorized] = useState(false);
  const [fees, setFees] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!open) return;
    setMessage('');
    setAccounts(null);
    setFailed('');
    setChosen('');
    setAuthorized(false);
    setFees(false);
    setTried(false);
    api
      .get<{ accounts: Candidate[] }>('/api/admin/payments/account/candidates')
      .then((r) => setAccounts(r.accounts))
      .catch((e) => setFailed(friendlyError(e, 'Não foi possível listar as contas agora.')));
  }, [open]);

  const production = environment === 'production';
  const ready = chosen !== '' && authorized && (!production || fees);

  const submit = async () => {
    setTried(true);
    setMessage('');
    if (!ready) {
      setMessage(chosen === '' ? 'Escolha a conta e marque as confirmações abaixo.' : 'Marque as confirmações abaixo para vincular.');
      return;
    }
    setBusy(true);
    try {
      await api.post('/api/admin/payments/account/link', { account_number: chosen, authorized, fees_acknowledged: fees });
      toast.success('Conta vinculada.', 'A conta foi conferida na lista oficial da operadora.');
      onDone();
      onClose();
    } catch (e) {
      setMessage(friendlyError(e, 'Não foi possível vincular a conta agora.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Vincular uma conta que já existe"
      description="Escolha, entre as contas que a operadora informa, a do estabelecimento. Só vale conta já CONFIRMADA por ela."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button loading={busy} onClick={() => void submit()}>
            Vincular esta conta
          </Button>
        </>
      }
    >
      {failed ? (
        <p role="alert" className="rounded-xl border border-rose-400/30 bg-rose-500/10 p-3 text-sm text-rose-100">
          {failed}
        </p>
      ) : accounts === null ? (
        <Spinner label="Consultando a operadora" />
      ) : accounts.length === 0 ? (
        <p className="text-sm text-white/65">A operadora não informou nenhuma conta. Se a conta do estabelecimento ainda não existe, cadastre uma nova.</p>
      ) : (
        <fieldset>
          <legend className="mb-2 text-[13px] font-semibold text-white/80">Contas informadas pela operadora</legend>
          <div className="space-y-2">
            {accounts.map((a) => {
              const disabled = !a.confirmed || a.linked;
              return (
                <label key={a.accountNumber} className={cx('flex items-start gap-3 rounded-xl border p-3', disabled ? 'cursor-not-allowed border-white/[0.06] opacity-60' : 'cursor-pointer border-white/10 hover:border-white/25', chosen === a.accountNumber && 'border-[#2563FF] bg-[#145CFF]/10')}>
                  <input type="radio" name="conta" value={a.accountNumber} disabled={disabled} checked={chosen === a.accountNumber} onChange={() => setChosen(a.accountNumber)} className="mt-1 h-4 w-4 accent-[#145CFF]" />
                  <span className="min-w-0 text-sm">
                    <span className="block font-semibold text-white">{a.name ?? 'Sem nome'}</span>
                    <span className="block text-xs text-white/60">
                      Conta {a.accountNumber}
                      {a.documentMasked ? ` · documento ${a.documentMasked}` : ''}
                    </span>
                    <span className="mt-1 flex flex-wrap gap-1.5">
                      <Badge tone={a.confirmed ? 'green' : 'amber'}>{a.confirmed ? 'Confirmada' : `Ainda não confirmada (${a.status || 'sem status'})`}</Badge>
                      {a.linked && <Badge tone="gray">Já vinculada</Badge>}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
      )}
      <div className="mt-5 space-y-2">
        <Check checked={authorized} onChange={setAuthorized} error={tried && !authorized}>
          O titular desta conta <strong>autorizou</strong> que ela receba os pagamentos do site.
        </Check>
        {production && (
          <Check checked={fees} onChange={setFees} error={tried && !fees}>
            Conheço e aceito as <strong>tarifas</strong> da ValidaPay para cada cobrança. As tarifas não são definidas por este site: confira no seu contrato com a ValidaPay.
          </Check>
        )}
        {!production && <p className="text-xs text-white/55">Ambiente de testes (sandbox): nenhuma tarifa é cobrada.</p>}
      </div>
      {message && (
        <p role="alert" className="mt-4 rounded-xl border border-rose-400/30 bg-rose-500/10 p-3 text-sm text-rose-100">
          {message}
        </p>
      )}
    </Modal>
  );
}

// ---- Cadastrar uma conta nova ---------------------------------------------------------------------------------------------------------

type Form = Record<string, unknown>;

const getIn = (form: Form, path: string): string => {
  const value = path.split('.').reduce<unknown>((node, key) => (node && typeof node === 'object' ? (node as Form)[key] : undefined), form);
  return typeof value === 'string' ? value : '';
};
const setIn = (form: Form, path: string, value: unknown): Form => {
  const [head, ...rest] = path.split('.');
  if (rest.length === 0) return { ...form, [head]: value };
  const child = (form[head] && typeof form[head] === 'object' ? form[head] : {}) as Form;
  return { ...form, [head]: setIn(child, rest.join('.'), value) };
};

function Text({ form, set, errors, path, label, hint, type = 'text', inputMode, autoComplete, className }: { form: Form; set: (path: string, value: unknown) => void; errors: Record<string, string>; path: string; label: string; hint?: string; type?: string; inputMode?: 'numeric' | 'tel' | 'email' | 'text'; autoComplete?: string; className?: string }) {
  return (
    <Field label={label} hint={hint} error={errors[path]} className={className}>
      {(p) => <input {...p} type={type} inputMode={inputMode} autoComplete={autoComplete ?? 'off'} value={getIn(form, path)} onChange={(e) => set(path, e.target.value)} className={INPUT} />}
    </Field>
  );
}

function Pick({ form, set, errors, path, label, options, className }: { form: Form; set: (path: string, value: unknown) => void; errors: Record<string, string>; path: string; label: string; options: Option[]; className?: string }) {
  return (
    <Field label={label} error={errors[path]} className={className}>
      {(p) => (
        <select {...p} value={getIn(form, path)} onChange={(e) => set(path, e.target.value)} className={INPUT}>
          <option value="">Escolha…</option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

function YesNo({ form, set, errors, path, label }: { form: Form; set: (path: string, value: unknown) => void; errors: Record<string, string>; path: string; label: string }) {
  const value = (() => {
    const raw = path.split('.').reduce<unknown>((node, key) => (node && typeof node === 'object' ? (node as Form)[key] : undefined), form);
    return raw === true ? 'sim' : raw === false ? 'nao' : '';
  })();
  return (
    <Field label={label} error={errors[path]}>
      {(p) => (
        <select {...p} value={value} onChange={(e) => set(path, e.target.value === 'sim' ? true : e.target.value === 'nao' ? false : '')} className={INPUT}>
          <option value="">Escolha…</option>
          <option value="nao">Não</option>
          <option value="sim">Sim</option>
        </select>
      )}
    </Field>
  );
}

function AddressFields({ prefix, ...rest }: { prefix: string; form: Form; set: (path: string, value: unknown) => void; errors: Record<string, string> }) {
  const f = { ...rest };
  return (
    <div className="grid gap-3 sm:grid-cols-6">
      <Text {...f} path={`${prefix}.postalCode`} label="CEP" inputMode="numeric" autoComplete="postal-code" className="sm:col-span-2" />
      <Text {...f} path={`${prefix}.street`} label="Rua" className="sm:col-span-4" />
      <Text {...f} path={`${prefix}.number`} label="Número" className="sm:col-span-2" />
      <Text {...f} path={`${prefix}.addressComplement`} label="Complemento (opcional)" className="sm:col-span-4" />
      <Text {...f} path={`${prefix}.neighborhood`} label="Bairro" className="sm:col-span-2" />
      <Text {...f} path={`${prefix}.city`} label="Cidade" className="sm:col-span-3" />
      <Text {...f} path={`${prefix}.state`} label="UF" className="sm:col-span-1" />
    </div>
  );
}

export function NewAccountModal({
  open,
  onClose,
  environment,
  feeCents,
  needsRiskConfirmation,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  environment: Environment;
  feeCents: number | null;
  needsRiskConfirmation: boolean;
  onDone: () => void;
}) {
  const toast = useToast();
  const [kind, setKind] = useState<'pf' | 'pj'>('pj');
  const [form, setForm] = useState<Form>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [authorized, setAuthorized] = useState(false);
  const [fees, setFees] = useState(false);
  const [risk, setRisk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!open) return;
    setKind('pj');
    setForm({});
    setErrors({});
    setAuthorized(false);
    setFees(false);
    setRisk(false);
    setTried(false);
    setMessage('');
  }, [open]);

  const production = environment === 'production';
  const set = (path: string, value: unknown) => {
    setForm((current) => setIn(current, path, value));
    setErrors((current) => {
      if (!(path in current)) return current;
      const { [path]: _gone, ...rest } = current;
      return rest;
    });
  };
  const common = { form, set, errors };

  const submit = async () => {
    setTried(true);
    setMessage('');
    if (!authorized || (production && !fees) || (needsRiskConfirmation && !risk)) {
      setMessage('Marque as confirmações no fim do formulário para enviar.');
      return;
    }
    setBusy(true);
    try {
      const r = await api.post<{ account: MerchantAccount }>('/api/admin/payments/account/proposal', {
        kind,
        authorized,
        fees_acknowledged: fees,
        confirm_duplicate_risk: risk,
        form,
      });
      if (r.account.status === 'pending') toast.success('Cadastro enviado.', 'Agora é aguardar a análise da operadora. O andamento aparece nesta página.');
      else toast.error('A operadora não aceitou o cadastro.', r.account.status_detail ?? 'Veja o motivo na página.');
      onDone();
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'invalid_form' && typeof e.data.fields === 'object' && e.data.fields) {
        setErrors(e.data.fields as Record<string, string>);
        setMessage('Confira os campos destacados.');
      } else {
        setMessage(friendlyError(e, 'Não foi possível enviar o cadastro agora.'));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="Cadastrar a conta do estabelecimento"
      description="Os dados vão direto para a operadora, que analisa o cadastro. Eles NÃO ficam guardados neste site."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button loading={busy} onClick={() => void submit()}>
            Enviar cadastro à operadora
          </Button>
        </>
      }
    >
      <fieldset className="mb-5">
        <legend className="mb-2 text-[13px] font-semibold text-white/80">Quem é o titular da conta?</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {(
            [
              ['pj', 'Empresa (CNPJ)', 'PJ, ME ou MEI, com um sócio responsável'],
              ['pf', 'Pessoa física (CPF)', 'O próprio dono, sem empresa'],
            ] as const
          ).map(([value, title, text]) => (
            <label key={value} className={cx('flex cursor-pointer items-start gap-3 rounded-xl border p-3', kind === value ? 'border-[#2563FF] bg-[#145CFF]/10' : 'border-white/10')}>
              <input type="radio" name="tipo" checked={kind === value} onChange={() => { setKind(value); setForm({}); setErrors({}); }} className="mt-1 h-4 w-4 accent-[#145CFF]" />
              <span className="text-sm">
                <span className="block font-semibold text-white">{title}</span>
                <span className="block text-xs text-white/60">{text}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {kind === 'pf' ? (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Text {...common} path="fullName" label="Nome completo" autoComplete="name" />
            <Text {...common} path="socialName" label="Nome social (opcional)" />
            <Text {...common} path="documentNumber" label="CPF" inputMode="numeric" />
            <Text {...common} path="birthDate" label="Data de nascimento" type="date" />
            <Text {...common} path="motherName" label="Nome da mãe" />
            <Text {...common} path="email" label="E-mail do titular" type="email" inputMode="email" hint="Precisa ser diferente do e-mail da conta master." />
            <Text {...common} path="phoneNumber" label="Celular com DDD" type="tel" inputMode="tel" hint="Precisa ser diferente do telefone da conta master." />
            <YesNo {...common} path="isPoliticallyExposedPerson" label="É pessoa politicamente exposta?" />
          </div>
          <h3 className="text-sm font-black text-white">Endereço do titular</h3>
          <AddressFields prefix="address" {...common} />
          <h3 className="text-sm font-black text-white">Dados financeiros</h3>
          <div className="grid gap-3 sm:grid-cols-3">
            <Pick {...common} path="financialDetails.declaredIncome" label="Renda mensal" options={INCOME_OPTIONS} />
            <Pick {...common} path="financialDetails.occupation" label="Ocupação" options={OCCUPATION_OPTIONS} />
            <Pick {...common} path="financialDetails.netWorth" label="Patrimônio" options={NET_WORTH_OPTIONS} />
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <h3 className="text-sm font-black text-white">A empresa</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <Text {...common} path="businessName" label="Razão social" />
            <Text {...common} path="tradingName" label="Nome fantasia" />
            <Text {...common} path="documentNumber" label="CNPJ" inputMode="numeric" />
            <Pick {...common} path="companyType" label="Tipo da empresa" options={COMPANY_TYPE_OPTIONS} />
            <Text {...common} path="businessEmail" label="E-mail da empresa" type="email" inputMode="email" hint="Precisa ser diferente do e-mail da conta master." />
            <Text {...common} path="contactNumber" label="Telefone da empresa com DDD" type="tel" inputMode="tel" hint="Precisa ser diferente do telefone da conta master." />
          </div>
          <AddressFields prefix="businessAddress" {...common} />
          <h3 className="text-sm font-black text-white">O sócio responsável</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <Text {...common} path="owner.fullName" label="Nome completo" autoComplete="name" />
            <Text {...common} path="owner.socialName" label="Nome social" hint="A operadora exige este campo para o sócio." />
            <Text {...common} path="owner.documentNumber" label="CPF" inputMode="numeric" />
            <Text {...common} path="owner.birthDate" label="Data de nascimento" type="date" />
            <Text {...common} path="owner.motherName" label="Nome da mãe" />
            <Text {...common} path="owner.email" label="E-mail do sócio" type="email" inputMode="email" />
            <Text {...common} path="owner.phoneNumber" label="Celular do sócio com DDD" type="tel" inputMode="tel" />
            <YesNo {...common} path="owner.isPoliticallyExposedPerson" label="É pessoa politicamente exposta?" />
          </div>
          <AddressFields prefix="owner.address" {...common} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Pick {...common} path="owner.financialOwnerDetails.ownerDeclaredIncome" label="Renda mensal do sócio" options={OWNER_INCOME_OPTIONS} />
            <Pick {...common} path="owner.financialOwnerDetails.ownerDeclaredRevenue" label="Faturamento da empresa" options={REVENUE_OPTIONS} />
          </div>
        </div>
      )}

      <div className="mt-6 space-y-2">
        <Check checked={authorized} onChange={setAuthorized} error={tried && !authorized}>
          O titular <strong>autorizou</strong> este cadastro e os dados acima são dele.
        </Check>
        {production ? (
          <Check checked={fees} onChange={setFees} error={tried && !fees}>
            Sei que a criação da conta custa <strong>{money(feeCents ?? 1500)}</strong>, debitados do saldo da conta master quando o cadastro é enviado, e que existem outras tarifas por cobrança (confira no contrato com a ValidaPay).
          </Check>
        ) : (
          <p className="text-xs text-white/55">Ambiente de testes (sandbox): nenhuma tarifa é cobrada.</p>
        )}
        {needsRiskConfirmation && (
          <Check checked={risk} onChange={setRisk} error={tried && !risk}>
            A tentativa anterior ficou sem resposta da operadora e o cadastro <strong>pode ter sido criado (e cobrado)</strong>. Já conferi na ValidaPay e quero enviar de novo.
          </Check>
        )}
      </div>
      {message && (
        <p role="alert" className="mt-4 rounded-xl border border-rose-400/30 bg-rose-500/10 p-3 text-sm text-rose-100">
          {message}
        </p>
      )}
    </Modal>
  );
}
