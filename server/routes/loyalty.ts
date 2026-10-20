// Programa de pontos (fidelidade), migration 0035. Nasce DESLIGADO e sem valores: as regras (pontos por R$ 1, pontos para trocar, valor da recompensa e validade do cupom) são do dono.
//  • Cliente (conta): vê o saldo, as regras e o extrato; troca pontos por um CUPOM PESSOAL de valor fixo (a troca é atômica no banco).
//  • Painel (só o owner): liga/desliga e define as regras, vê o resumo e o extrato, e faz acertos manuais com motivo (registrados na trilha de atividades).
// Os pontos são creditados pelo banco quando o pedido de uma conta vira "entregue" (e estornados se o pagamento é devolvido): nada disso depende do navegador.
import { audit, changedFields } from '../audit.js';
import type { FieldLabels } from '../audit.js';
import { reserve } from '../auth.js';
import { requireCustomer } from '../customer.js';
import { one, query } from '../db.js';
import type { Row } from '../db.js';
import { HttpError, json, readJson } from '../http.js';
import type { Router } from '../http.js';
import { bool, int, money, parse } from '../validate.js';
import type { Spec } from '../validate.js';

const spec: Spec = {
  loyalty_enabled: bool('Programa de pontos ligado'),
  loyalty_points_per_real: money('Pontos por R$ 1', { nullable: true, positive: true }),
  loyalty_redeem_points: int('Pontos para trocar', { min: 1, max: 1_000_000, nullable: true }),
  loyalty_reward_value: money('Valor da recompensa', { nullable: true, positive: true }),
  loyalty_coupon_days: int('Validade do cupom (dias)', { min: 1, max: 365, nullable: true }),
};
const LABELS: FieldLabels = {
  loyalty_enabled: { label: 'programa de pontos', format: 'bool' },
  loyalty_points_per_real: { label: 'pontos por R$ 1' },
  loyalty_redeem_points: { label: 'pontos para trocar' },
  loyalty_reward_value: { label: 'valor da recompensa', format: 'money' },
  loyalty_coupon_days: { label: 'validade do cupom (dias)' },
};
const RULES = 'loyalty_enabled, loyalty_points_per_real, loyalty_redeem_points, loyalty_reward_value, loyalty_coupon_days';
const publicRules = (row: Row | null) => ({
  points_per_real: row?.loyalty_points_per_real === null || row?.loyalty_points_per_real === undefined ? null : Number(row.loyalty_points_per_real),
  redeem_points: row?.loyalty_redeem_points ?? null,
  reward_value: row?.loyalty_reward_value === null || row?.loyalty_reward_value === undefined ? null : Number(row.loyalty_reward_value),
  coupon_days: row?.loyalty_coupon_days ?? null,
});

export function registerLoyalty(r: Router) {
  // ---- Cliente ---------------------------------------------------------------------------------------------------

  r.get('/api/account/loyalty', 'public', async (ctx) => {
    const customer = await requireCustomer(ctx);
    const settings = await one<Row>(`select ${RULES} from store_settings where id = 1`);
    if (!settings?.loyalty_enabled) return json({ enabled: false });
    const [balance, movements, coupons] = await Promise.all([
      one<{ n: number }>('select loyalty_balance($1::uuid) as n', [customer.id]),
      query<Row>('select kind, points, note, created_at from loyalty_ledger where customer_id = $1 order by created_at desc, id desc limit 20', [customer.id]),
      // Cupons de troca ainda não usados nem vencidos, para a pessoa achar o código de novo.
      query<Row>(
        `select c.code, c.value, c.ends_at from coupons c
          where c.customer_id = $1 and c.active and (c.ends_at is null or c.ends_at > now())
            and not exists (select 1 from orders o where o.coupon_id = c.id and o.order_status <> 'cancelled')
          order by c.created_at desc limit 5`,
        [customer.id],
      ),
    ]);
    return json({ enabled: true, balance: balance?.n ?? 0, rules: publicRules(settings), movements, coupons }, 200, { 'cache-control': 'no-store' });
  });

  r.post('/api/account/loyalty/redeem', 'public', async (ctx) => {
    const customer = await requireCustomer(ctx);
    await reserve('loyalty-redeem', customer.id, 3600, 20, 'Muitas trocas em pouco tempo. Tente de novo mais tarde.');
    const row = await one<{ result: Row }>('select loyalty_redeem($1::uuid) as result', [customer.id]);
    const result = row?.result;
    if (!result?.ok) throw new HttpError(409, String(result?.message ?? 'Não foi possível trocar os pontos agora.'));
    return json({ coupon: { code: result.code, value: Number(result.value), expires_at: result.expires_at }, balance: result.balance }, 201, { 'cache-control': 'no-store' });
  });

  // ---- Painel (owner) ---------------------------------------------------------------------------------------------

  r.get('/api/admin/loyalty', 'owner', async () => {
    const [settings, totals, movements] = await Promise.all([
      one<Row>(`select ${RULES} from store_settings where id = 1`),
      one<Row>(
        `select coalesce(sum(b.n), 0)::int as outstanding, count(*) filter (where b.n > 0)::int as customers_with_points
           from (select customer_id, sum(points)::int as n from loyalty_ledger group by customer_id) b`,
      ),
      query<Row>(
        `select l.kind, l.points, l.note, l.created_at, c.name as customer_name, c.email as customer_email, o.order_number
           from loyalty_ledger l join customers c on c.id = l.customer_id left join orders o on o.id = l.order_id
          order by l.created_at desc, l.id desc limit 50`,
      ),
    ]);
    return json({ settings: { enabled: settings?.loyalty_enabled === true, ...publicRules(settings) }, totals: { outstanding: totals?.outstanding ?? 0, customers_with_points: totals?.customers_with_points ?? 0 }, movements });
  });

  r.put('/api/admin/loyalty/settings', 'owner', async (ctx) => {
    const { values } = parse(spec, await readJson(ctx.req, 2048), { partial: true });
    const before = await one<Row>(`select ${RULES} from store_settings where id = 1`);
    const merged = { ...before, ...values };
    if (merged.loyalty_enabled === true) {
      const missing = [
        ['pontos por R$ 1', merged.loyalty_points_per_real],
        ['pontos para trocar', merged.loyalty_redeem_points],
        ['valor da recompensa', merged.loyalty_reward_value],
        ['validade do cupom', merged.loyalty_coupon_days],
      ].filter(([, v]) => v === null || v === undefined);
      if (missing.length) throw new HttpError(400, `Para ligar o programa de pontos, preencha: ${missing.map(([label]) => label).join(', ')}.`);
    }
    const keys = Object.keys(values);
    if (keys.length) {
      const sets = keys.map((key, i) => `${key} = $${i + 1}`).join(', ');
      await query(`update store_settings set ${sets} where id = 1`, keys.map((key) => values[key]));
    }
    const diff = changedFields(before, values, LABELS);
    if (diff) await audit(ctx, { action: 'loyalty.settings', summary: `Programa de pontos: ${diff.text}`, entity: 'loyalty', details: diff.details });
    const after = await one<Row>(`select ${RULES} from store_settings where id = 1`);
    return json({ settings: { enabled: after?.loyalty_enabled === true, ...publicRules(after) } });
  });

  // Acerto manual (crédito ou débito), sempre com motivo. Não deixa o saldo ficar negativo por um acerto.
  r.post('/api/admin/loyalty/adjust', 'owner', async (ctx) => {
    await reserve('loyalty-adjust', ctx.admin!.id, 3600, 60, 'Muitos acertos em pouco tempo.');
    const body = await readJson(ctx.req, 2048);
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const points = typeof body.points === 'number' ? body.points : Number.NaN;
    const note = typeof body.note === 'string' ? body.note.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() : '';
    if (!email) throw new HttpError(400, 'Informe o e-mail da conta.');
    if (!Number.isInteger(points) || points === 0 || Math.abs(points) > 1_000_000) throw new HttpError(400, 'Pontos: informe um número inteiro diferente de zero (até 1.000.000).');
    if (note.length < 3 || note.length > 120) throw new HttpError(400, 'Motivo: escreva de 3 a 120 letras.');
    const customer = await one<Row>('select id, name from customers where lower(email) = $1', [email]);
    if (!customer) throw new HttpError(404, 'Não há conta com esse e-mail.');
    const done = await one<Row>(
      `with locked as (select id from customers where id = $1 for update),
            bal as (select coalesce(sum(points), 0)::int as n from loyalty_ledger where customer_id = $1),
            ins as (
              insert into loyalty_ledger (customer_id, kind, points, note, created_by)
              select $1, 'adjust', $2::int, $3, $4 from locked, bal where bal.n + $2::int >= 0
              returning points
            )
       select (select count(*) from ins)::int as inserted, (select n from bal) as before`,
      [customer.id, points, `Acerto: ${note}`, ctx.admin!.id],
    );
    if (!done?.inserted) throw new HttpError(409, 'O saldo ficaria negativo. Reduza os pontos do acerto.');
    await audit(ctx, { action: 'loyalty.adjust', summary: `Acerto de ${points > 0 ? '+' : ''}${points} pontos para ${String(customer.name)} (${note})`, entity: 'loyalty', details: { points, note } });
    const balance = await one<{ n: number }>('select loyalty_balance($1::uuid) as n', [customer.id]);
    return json({ ok: true, balance: balance?.n ?? 0 }, 201);
  });
}
