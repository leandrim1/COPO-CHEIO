-- COPO CHEIO – Disk Bebidas · Neon PostgreSQL (copocheio-db)
-- 15/15 · Conta (subconta) do estabelecimento na operadora: um cadastro ativo por vez e o aviso de "pode ter sido criado".
--
-- O que esta migration FAZ
-- • Só pode existir UM cadastro "em andamento ou aprovado" por operadora (draft, submitted, pending, approved). Isso impede, no banco,
--   dois cliques ou duas abas criarem duas propostas (cada subconta nova custa R$ 15,00 em produção). Cadastro reprovado, com erro ou
--   duplicado deixa de ser ativo e permite uma nova tentativa.
-- • merchant_accounts.ambiguous: a operadora não respondeu ao enviar a proposta, então ela PODE ter sido criada (e cobrada). Uma nova
--   tentativa depois disso exige uma confirmação explícita do dono.
-- • payment_events aceita dois desfechos novos, para os avisos de cadastro da conta: 'unknown_proposal' (a loja não tem essa proposta; nenhuma conta
--   é criada por aviso) e 'conflict' (o aviso quebraria uma regra de unicidade; nada é aprovado e o dono confere).
-- • Cada ambiente da operadora (sandbox × produção) é uma "operadora" própria na coluna provider (o adaptador usa nomes diferentes), então
--   conta, cobranças e avisos de testes nunca se misturam com os de produção.
--
-- O que NÃO faz
-- • Não cria subconta, não chama operadora e não altera cobrança nenhuma. Só acrescenta uma coluna com padrão e um índice.

alter table merchant_accounts add column ambiguous boolean not null default false;
-- statement-breakpoint

create unique index merchant_accounts_one_active on merchant_accounts (provider) where status in ('draft', 'submitted', 'pending', 'approved');
-- statement-breakpoint

alter table payment_events drop constraint payment_events_outcome_check;
-- statement-breakpoint

alter table payment_events
  add constraint payment_events_outcome_check
  check (outcome is null or outcome in ('applied', 'stale', 'ignored', 'needs_attention', 'unknown_charge', 'error', 'unknown_proposal', 'conflict'));
-- statement-breakpoint
