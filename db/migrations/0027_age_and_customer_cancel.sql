-- COPO CHEIO – Disk Bebidas · Neon PostgreSQL (copocheio-db)
-- 27/27 · Venda responsável de bebidas alcoólicas (18+) e cancelamento do pedido pelo próprio cliente.
--
-- MAIORIDADE
-- • products.alcoholic: marca os produtos com álcool. Todo produto existente nasce TRUE (o lado seguro): o dono desmarca, no painel, o que não tem
--   álcool (refrigerante, água, gelo...). Produto novo também nasce TRUE.
-- • create_order: pedido com algum produto alcoólico só é criado com a declaração de maioridade do cliente (age_confirmed = true); sem ela, recusa com
--   o código 'age_required'. É uma DECLARAÇÃO, não uma prova de idade. Fica gravado só: que o pedido exige conferência (age_required), quando o cliente
--   declarou (age_declared_at) e a versão do texto que ele viu (age_declaration_version). Nenhuma data de nascimento, nenhum documento.
-- • admin_set_order_status: pedido com bebida alcoólica só vira "entregue" com a confirmação de que o documento com foto foi conferido
--   (p_age_checked); quem conferiu e quando ficam em orders.age_checked_by_name / age_checked_at. Entrega recusada: cancela-se o pedido com o motivo.
--
-- CANCELAMENTO PELO CLIENTE
-- • order_cancel_why(pedido): NULL = o cliente pode cancelar agora; senão o motivo (cancelled, final, in_progress, paid, payment_processing).
--   Regra: só até a loja confirmar (aguardando pagamento ou novo) e sem dinheiro recebido; depois, só pela loja.
-- • customer_cancel_order: cancela numa transação (trava a linha, confere a regra, grava histórico com quem/quando/motivo/estado anterior,
--   devolve o estoque UMA vez e encerra a cobrança em aberto). Cancelar de novo devolve o pedido como está (sem devolver o estoque de novo).
-- • order_status_history.reason: motivo (até 200 caracteres) de qualquer mudança de status.
-- • order_json: o pedido que o cliente vê traz 'age_check_required' e 'cancel' ({allowed, why}).
--
-- Só acrescenta colunas (com padrões que não mudam nenhum pedido existente) e troca funções. Nenhum dado é apagado ou alterado, salvo o novo
-- products.alcoholic (TRUE em todos). Quem chama admin_set_order_status com os 3 argumentos de antes continua funcionando (os novos têm padrão).

alter table products
  add column alcoholic boolean not null default true;
-- statement-breakpoint

alter table orders
  add column age_required boolean not null default false,
  add column age_declared_at timestamptz,
  add column age_declaration_version text check (age_declaration_version is null or char_length(age_declaration_version) <= 20),
  add column age_checked_at timestamptz,
  add column age_checked_by_name text check (age_checked_by_name is null or char_length(age_checked_by_name) <= 120);
-- statement-breakpoint

alter table order_status_history
  add column reason text check (reason is null or char_length(reason) <= 200);
-- statement-breakpoint

-- O cliente pode cancelar este pedido agora? NULL = pode. Senão, o motivo:
--   cancelled · já está cancelado · final · já foi entregue · in_progress · a loja já confirmou/está preparando/saiu para entrega (só a loja cancela)
--   paid · há pagamento recebido (a devolução do dinheiro é combinada com a loja) · payment_processing · um pagamento está sendo processado agora
create or replace function order_cancel_why(o orders)
returns text
language sql
stable
as $$
  select case
    when o.order_status = 'cancelled' then 'cancelled'
    when o.order_status = 'delivered' then 'final'
    when o.order_status in ('confirmed', 'preparing', 'out_for_delivery') then 'in_progress'
    when exists (
      select 1 from payments p
       where p.order_id = o.id
         and ((p.method = 'card' and p.status in ('creating', 'pending')) or (p.method = 'pix' and p.status = 'creating'))
    ) then 'payment_processing'
    when o.payment_status = 'paid' or exists (select 1 from payments p where p.order_id = o.id and p.status = 'paid') then 'paid'
    else null
  end;
$$;
-- statement-breakpoint

create or replace function order_json(p_order uuid, p_ids boolean default false)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'order_number', o.order_number,
    'order_status', o.order_status,
    'payment_status', o.payment_status,
    'payment_method', o.payment_method,
    'change_for', o.change_for,
    'delivery_type', o.delivery_type,
    'customer_name', o.customer_name,
    'address', o.address,
    'address_number', o.address_number,
    'neighborhood', o.neighborhood,
    'complement', o.complement,
    'reference', o.reference,
    'notes', o.notes,
    'subtotal', o.subtotal,
    'delivery_fee', o.delivery_fee,
    'discount', o.discount,
    'payment_fee', o.payment_fee,
    'total', o.total,
    'created_at', o.created_at,
    'updated_at', o.updated_at,
    'linked', o.customer_id is not null,
    -- Pedido com bebida alcoólica: o documento com foto será conferido na entrega ou na retirada.
    'age_check_required', o.age_required,
    -- Cancelamento pelo cliente: allowed = pode cancelar agora; why = por que não (ver order_cancel_why).
    'cancel', jsonb_build_object('allowed', order_cancel_why(o) is null, 'why', order_cancel_why(o)),
    'retention_days', (select s.tracking_retention_days from store_settings s where s.id = 1),
    'items', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'product_name', i.product_name,
          'quantity', i.quantity,
          'unit_price', i.unit_price,
          'total_price', i.total_price
        ) || case when i.ice_choice is not null then jsonb_build_object('ice_choice', i.ice_choice) else '{}'::jsonb end
          || case when p_ids then jsonb_build_object('product_id', i.product_id) else '{}'::jsonb end
          || case when p_ids and i.swap_to_product_id is not null then jsonb_build_object('swap_to_product_id', i.swap_to_product_id) else '{}'::jsonb end
        order by i.created_at, i.product_name, i.ice_choice nulls first
      )
      from order_items i
      where i.order_id = o.id
    ), '[]'::jsonb),
    'history', coalesce((
      select jsonb_agg(jsonb_build_object('status', h.to_status, 'at', h.created_at) order by h.created_at)
      from order_status_history h
      where h.order_id = o.id
    ), '[]'::jsonb)
  ) || case
    when exists (select 1 from payments p where p.order_id = o.id) then jsonb_build_object('payment', (
      select jsonb_build_object('method', p.method, 'status', p.status, 'expires_at', p.expires_at, 'paid_at', p.paid_at, 'attempt', p.attempt)
      from payments p
      where p.order_id = o.id
      order by p.created_at desc
      limit 1
    ))
    else '{}'::jsonb
  end
  from orders o
  where o.id = p_order;
$$;
-- statement-breakpoint

create or replace function create_order(payload jsonb)
returns jsonb
language plpgsql
volatile
as $$
declare
  s store_settings;
  v_name text := btrim(coalesce(payload ->> 'customer_name', ''));
  v_phone text := regexp_replace(coalesce(payload ->> 'customer_phone', ''), '\D', '', 'g');
  v_email text := nullif(lower(btrim(coalesce(payload ->> 'customer_email', ''))), '');
  v_type text := coalesce(payload ->> 'delivery_type', '');
  v_payment text := coalesce(payload ->> 'payment_method', '');
  v_address text := nullif(btrim(coalesce(payload ->> 'address', '')), '');
  v_number text := nullif(btrim(coalesce(payload ->> 'address_number', '')), '');
  v_neighborhood text := nullif(btrim(coalesce(payload ->> 'neighborhood', '')), '');
  v_complement text := nullif(btrim(coalesce(payload ->> 'complement', '')), '');
  v_reference text := nullif(btrim(coalesce(payload ->> 'reference', '')), '');
  v_notes text := nullif(btrim(coalesce(payload ->> 'notes', '')), '');
  v_change_text text := nullif(btrim(coalesce(payload ->> 'change_for', '')), '');
  v_change numeric(10, 2);
  v_fee numeric(10, 2) := 0;
  v_subtotal numeric(10, 2) := 0;
  v_total numeric(10, 2);
  -- Cartão de crédito online: a taxa de processamento paga pelo cliente (calculada aqui, em centavos) e os valores com que ela foi calculada.
  v_card_fee numeric(10, 2) := 0;
  v_fee_bps integer;
  v_fee_fixed numeric(10, 2);
  v_fs payment_fee_settings;
  v_item record;
  v_product products;
  v_unit numeric(10, 2);
  v_ids uuid[] := '{}';
  v_names text[] := '{}';
  v_qtys integer[] := '{}';
  v_units numeric[] := '{}';
  -- Escolha do gelo de cada linha (nula nos produtos que não pedem) e os produtos que pedem e vieram sem a escolha.
  v_ices text[] := '{}';
  v_line record;
  v_requires boolean;
  v_missing jsonb := '[]'::jsonb;
  -- Troca de energético (combos): o produto da linha é o combo; v_swaps guarda, linha a linha, o energético escolhido no lugar do que vem nele.
  v_swaps uuid[] := '{}';
  v_swap products;
  v_base products;
  v_line_unit numeric(10, 2);
  v_line_name text;
  v_diff numeric(10, 2);
  v_base_price numeric(10, 2);
  v_order orders;
  v_hash text := coalesce(payload ->> 'tracking_hash', '');
  v_customer uuid := nullif(payload ->> 'customer_id', '')::uuid;
  v_legacy uuid;
  v_key text := nullif(btrim(coalesce(payload ->> 'idempotency_key', '')), '');
  v_expected_text text := nullif(btrim(coalesce(payload ->> 'expected_total', '')), '');
  v_expected numeric(10, 2);
  v_request_hash text;
  v_existing orders;
  -- Maioridade (18+): pedido com bebida alcoólica exige a declaração do cliente (age_confirmed = true, booleano; texto "true" não vale). É uma
  -- DECLARAÇÃO, não uma prova de idade: o documento com foto é conferido na entrega ou na retirada (admin_set_order_status).
  v_alcoholic boolean := false;
  v_age_ok boolean := coalesce(payload -> 'age_confirmed', 'false'::jsonb) = 'true'::jsonb;
  v_age_version text := case when coalesce(payload ->> 'age_text_version', '') ~ '^v[0-9]{1,3}$' then payload ->> 'age_text_version' else 'v1' end;
begin
  -- Envio repetido: a mesma chave devolve o pedido que já existe (sem tocar em estoque nem em nada). Vem antes de qualquer
  -- regra da loja de propósito: se a primeira tentativa funcionou e só a resposta se perdeu, a pessoa precisa ver o pedido
  -- mesmo que a loja tenha fechado nesse meio-tempo. A trava garante que dois envios simultâneos passem um de cada vez.
  if v_key is not null then
    if v_key !~ '^[A-Za-z0-9_-]{16,64}$' then
      raise exception 'Não foi possível identificar o envio do pedido. Atualize a página e tente de novo.' using errcode = 'P0001';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('order-key:' || v_key, 0));
    v_request_hash := encode(
      sha256(convert_to((payload - 'tracking_hash' - 'customer_id' - 'idempotency_key' - 'expected_total')::text, 'UTF8')),
      'hex'
    );
    select * into v_existing from orders where idempotency_key = v_key;
    if found then
      if v_existing.request_hash is distinct from v_request_hash then
        raise exception 'Este envio já foi usado por um pedido diferente. Atualize a página e confira o seu pedido.'
          using errcode = 'CC409', detail = '{"code":"idempotency_conflict"}';
      end if;
      return order_json(v_existing.id) || jsonb_build_object('replayed', true);
    end if;
  end if;

  select * into s from store_settings where id = 1;
  if not found then
    raise exception 'A loja ainda não foi configurada.' using errcode = 'P0001';
  end if;
  if s.orders_paused then
    raise exception 'A loja não está recebendo pedidos agora. Tente novamente mais tarde.' using errcode = 'P0001';
  end if;
  if not store_open_now() then
    raise exception 'Estamos fechados agora. Confira nosso horário de funcionamento.' using errcode = 'P0001';
  end if;

  -- Total que o cliente viu na tela (opcional, em reais). Se não bater com o que o banco calcular, o pedido não é criado.
  if v_expected_text is not null then
    if v_expected_text !~ '^[0-9]{1,7}([.][0-9]{1,2})?$' then
      raise exception 'Não foi possível conferir o total do pedido. Atualize a página e tente de novo.' using errcode = 'P0001';
    end if;
    v_expected := v_expected_text::numeric;
  end if;

  -- Cliente
  if char_length(v_name) < 2 or char_length(v_name) > 80 then
    raise exception 'Informe seu nome.' using errcode = 'P0001';
  end if;
  if v_phone !~ '^[0-9]{10,13}$' then
    raise exception 'Informe um telefone válido, com DDD.' using errcode = 'P0001';
  end if;
  if v_email is not null and (char_length(v_email) > 254 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') then
    raise exception 'Confira o e-mail informado.' using errcode = 'P0001';
  end if;

  -- Código de acompanhamento: o servidor gera o código e manda só o hash (SHA-256 em hex).
  -- Transitório: a versão anterior do site (que pode continuar no ar durante um deploy, ou se alguém voltar
  -- para ela) não manda o hash; nesse caso o código é um UUID (formato antigo), devolvido em "token".
  if v_hash = '' then
    v_legacy := gen_random_uuid();
    v_hash := encode(sha256(convert_to(v_legacy::text, 'UTF8')), 'hex');
  end if;
  if v_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Não foi possível gerar o código de acompanhamento. Tente novamente.' using errcode = 'P0001';
  end if;
  -- Conta do cliente: o servidor só envia o id de uma sessão válida; conta desativada ou com e-mail não confirmado é ignorada.
  if v_customer is not null and not exists (select 1 from customers c where c.id = v_customer and c.active and c.email_verified_at is not null) then
    v_customer := null;
  end if;

  -- Entrega ou retirada
  if v_type = 'delivery' then
    if not s.delivery_enabled then
      raise exception 'A entrega não está disponível no momento.' using errcode = 'P0001';
    end if;
    if v_address is null or v_number is null or v_neighborhood is null then
      raise exception 'Informe rua, número e bairro para a entrega.' using errcode = 'P0001';
    end if;
    if char_length(v_address) > 120 or char_length(v_number) > 20 or char_length(v_neighborhood) > 60
       or char_length(coalesce(v_complement, '')) > 60 or char_length(coalesce(v_reference, '')) > 120 then
      raise exception 'O endereço está longo demais. Confira os campos.' using errcode = 'P0001';
    end if;
  elsif v_type = 'pickup' then
    if not s.pickup_enabled then
      raise exception 'A retirada na loja não está disponível no momento.' using errcode = 'P0001';
    end if;
    v_address := null;
    v_number := null;
    v_neighborhood := null;
    v_complement := null;
    v_reference := null;
  else
    raise exception 'Escolha entrega ou retirada.' using errcode = 'P0001';
  end if;

  -- Pagamento
  if not exists (select 1 from payment_methods m where m.code = v_payment and m.enabled) then
    raise exception 'Escolha uma forma de pagamento disponível.' using errcode = 'P0001';
  end if;
  -- Pagamento online (Pix e cartão): sem uma conta (subconta) aprovada na operadora não há como cobrar. (O painel também não deixa ligar o meio de pagamento assim.)
  if is_online_payment(v_payment) and not exists (select 1 from merchant_accounts a where a.status = 'approved') then
    raise exception 'O pagamento online não está disponível agora. Escolha outra forma de pagamento.' using errcode = 'P0001';
  end if;
  -- Cartão online: só com a taxa conferida pelo dono (o painel não deixa ligar sem isso; aqui é a segunda trava) e com e-mail (a operadora exige).
  if v_payment = 'card_online' then
    select * into v_fs from payment_fee_settings where id = 1;
    if not found or v_fs.confirmed_at is null then
      raise exception 'O pagamento online não está disponível agora. Escolha outra forma de pagamento.' using errcode = 'P0001';
    end if;
    if v_email is null then
      raise exception 'Informe o seu e-mail para pagar com cartão de crédito.' using errcode = 'P0001';
    end if;
  end if;
  if v_notes is not null and char_length(v_notes) > 500 then
    raise exception 'As observações podem ter até 500 caracteres.' using errcode = 'P0001';
  end if;

  -- Proteção contra envios repetidos
  if (select count(*) from orders o
      where o.customer_phone = v_phone and o.created_at > now() - interval '10 minutes') >= 5 then
    raise exception 'Muitos pedidos em pouco tempo. Aguarde alguns minutos ou fale com a loja pelo WhatsApp.'
      using errcode = 'P0001';
  end if;

  -- Itens: preço e disponibilidade vêm do banco; os produtos ficam travados até o fim do pedido
  -- (sempre na mesma ordem), então pedidos simultâneos não vendem o mesmo estoque duas vezes.
  if jsonb_typeof(payload -> 'items') is distinct from 'array' or jsonb_array_length(payload -> 'items') = 0 then
    raise exception 'Seu pedido está vazio.' using errcode = 'P0001';
  end if;
  if jsonb_array_length(payload -> 'items') > 60 or exists (
    select 1 from jsonb_array_elements(payload -> 'items') e
    where coalesce(e ->> 'product_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or coalesce(e ->> 'quantity', '') !~ '^[0-9]{1,3}$'
       or (nullif(e ->> 'swap_to', '') is not null and (e ->> 'swap_to') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  ) then
    raise exception 'Os itens do pedido são inválidos. Atualize a página e tente de novo.' using errcode = 'P0001';
  end if;

  -- Trava de uma vez, sempre na ordem dos ids, todos os produtos do pedido e os energéticos escolhidos nas trocas: pedidos simultâneos
  -- seguem a mesma ordem e não ficam esperando um ao outro.
  perform 1 from products p
   where p.id in (
     select (e ->> 'product_id')::uuid from jsonb_array_elements(payload -> 'items') e
     union
     select (e ->> 'swap_to')::uuid from jsonb_array_elements(payload -> 'items') e where nullif(e ->> 'swap_to', '') is not null
   )
   order by p.id
     for update;

  for v_item in
    select (e ->> 'product_id')::uuid as product_id, sum((e ->> 'quantity')::integer)::integer as qty
    from jsonb_array_elements(payload -> 'items') e
    group by 1
    order by 1
  loop
    if v_item.qty < 1 or v_item.qty > 99 then
      raise exception 'Quantidade inválida no pedido.' using errcode = 'P0001';
    end if;

    select * into v_product from products p where p.id = v_item.product_id for update;
    if not found or not v_product.active or (
      v_product.category_id is not null
      and not exists (select 1 from categories c where c.id = v_product.category_id and c.active)
    ) then
      raise exception 'Um produto do seu pedido não está mais disponível. Atualize a página.' using errcode = 'P0001';
    end if;
    if v_product.sold_out then
      raise exception '% está esgotado. Remova do pedido para continuar.', v_product.name using errcode = 'P0001';
    end if;
    if v_product.stock is not null and v_product.stock < v_item.qty then
      raise exception 'Temos só % unidade(s) de %.', v_product.stock, v_product.name using errcode = 'P0001';
    end if;
    v_alcoholic := v_alcoholic or v_product.alcoholic;

    -- Promoção só vale dentro da janela de datas (sem datas, vale sempre).
    v_unit := coalesce(effective_promo(v_product.promo_price, v_product.promo_starts_at, v_product.promo_ends_at), v_product.price);

    -- Gelo: se o PRODUTO pede a escolha (marca no registro do produto, escolhida no painel; não a categoria nem o nome), cada linha
    -- precisa trazer 'normal' ou 'flavored'. Em produto que não pede, qualquer valor de ice_choice é ignorado (o pedido fica como sempre foi).
    v_requires := v_product.ice_choice_required;

    -- Uma linha por gelo: o mesmo produto com gelos diferentes vira linhas separadas, cada uma com a sua quantidade.
    for v_line in
      select x.ice, x.swap_to, sum(x.qty)::integer as qty
      from (
        select case when v_requires and e ->> 'ice_choice' in ('normal', 'flavored') then e ->> 'ice_choice' end as ice,
               nullif(e ->> 'swap_to', '')::uuid as swap_to,
               (e ->> 'quantity')::integer as qty
        from jsonb_array_elements(payload -> 'items') e
        where (e ->> 'product_id')::uuid = v_item.product_id
      ) x
      group by x.ice, x.swap_to
      order by x.ice nulls first, x.swap_to nulls first
    loop
      if v_requires and v_line.ice is null then
        v_missing := v_missing || jsonb_build_object('product_id', v_product.id, 'name', v_product.name);
        continue;
      end if;

      v_line_unit := v_unit;
      v_line_name := v_product.name;
      if v_line.swap_to is not null then
        -- Troca do energético que vem no combo. O preço NUNCA cai: a linha custa o combo + a diferença (se o novo for mais caro que o que vem
        -- no combo; se for igual ou mais barato, a diferença é zero e não há devolução). O banco confere tudo: o produto precisa ter o energético
        -- do combo definido, o novo precisa ser um energético de 2L diferente dele, ativo e com estoque.
        if v_product.swap_base_product_id is null and v_product.swap_base_price is null then
          raise exception '% não aceita troca de energético.', v_product.name using errcode = 'P0001';
        end if;
        select * into v_swap from products n where n.id = v_line.swap_to;
        if not found or not v_swap.active or (
          v_swap.category_id is not null
          and not exists (select 1 from categories c where c.id = v_swap.category_id and c.active)
        ) then
          raise exception 'O energético escolhido para a troca não está mais disponível. Atualize a página.' using errcode = 'P0001';
        end if;
        if v_swap.id is not distinct from v_product.swap_base_product_id then
          raise exception 'Escolha um energético diferente do que já vem no combo.' using errcode = 'P0001';
        end if;
        -- Com uma lista de energéticos escolhida no painel para este combo, só valem os da lista; sem lista, vale qualquer energético de 2L.
        if exists (select 1 from product_swap_options o where o.product_id = v_product.id) then
          if not exists (select 1 from product_swap_options o where o.product_id = v_product.id and o.option_id = v_swap.id) then
            raise exception 'Escolha um dos energéticos oferecidos para a troca deste combo.' using errcode = 'P0001';
          end if;
        elsif not is_energetic_2l(v_swap.name, (select c.name from categories c where c.id = v_swap.category_id)) then
          raise exception 'Escolha um energético de 2L diferente do que já vem no combo.' using errcode = 'P0001';
        end if;
        if v_swap.sold_out then
          raise exception '% está esgotado. Escolha outro energético.', v_swap.name using errcode = 'P0001';
        end if;
        if v_swap.stock is not null and v_swap.stock < v_line.qty then
          raise exception 'Temos só % unidade(s) de %.', v_swap.stock, v_swap.name using errcode = 'P0001';
        end if;
        v_alcoholic := v_alcoholic or v_swap.alcoholic;
        -- O valor do energético que vem no combo: o preço de agora do produto escolhido no painel ou, se o energético do combo não é um
        -- produto do cardápio, o valor digitado no painel.
        if v_product.swap_base_product_id is not null then
          select * into v_base from products b where b.id = v_product.swap_base_product_id;
          v_base_price := coalesce(effective_promo(v_base.promo_price, v_base.promo_starts_at, v_base.promo_ends_at), v_base.price);
        else
          v_base_price := v_product.swap_base_price;
        end if;
        v_diff := greatest(
          0,
          coalesce(effective_promo(v_swap.promo_price, v_swap.promo_starts_at, v_swap.promo_ends_at), v_swap.price) - v_base_price
        );
        v_line_unit := v_unit + v_diff;
        v_line_name := v_product.name || ' — troca do energético por ' || v_swap.name
                       || case when v_diff > 0 then ' (+ ' || format_brl(v_diff) || ')' else ' (sem diferença)' end;
        if v_swap.stock is not null then
          update products set stock = stock - v_line.qty where id = v_swap.id;
        end if;
      end if;

      v_subtotal := v_subtotal + v_line_unit * v_line.qty;
      v_ids := array_append(v_ids, v_product.id);
      v_names := array_append(v_names, v_line_name);
      v_qtys := array_append(v_qtys, v_line.qty);
      v_units := array_append(v_units, v_line_unit);
      v_ices := array_append(v_ices, v_line.ice);
      v_swaps := array_append(v_swaps, v_line.swap_to);
    end loop;

    if v_product.stock is not null then
      update products set stock = stock - v_item.qty where id = v_product.id;
    end if;
  end loop;

  -- Algum produto que pede o gelo veio sem a escolha: nada é criado (o estoque reservado acima volta junto). O site recebe quais
  -- produtos faltam para mostrar a pergunta de novo.
  if jsonb_array_length(v_missing) > 0 then
    raise exception 'Escolha o tipo de gelo para continuar.'
      using errcode = 'CC400',
            detail = jsonb_build_object('code', 'ice_required', 'products', (select jsonb_agg(distinct m) from jsonb_array_elements(v_missing) m))::text;
  end if;

  -- Bebida alcoólica no pedido sem a declaração de maioridade: nada é criado (o estoque reservado acima volta junto). O site recebe o código
  -- 'age_required' e pede a declaração; quem chama a API direto sem ela recebe a mesma recusa.
  if v_alcoholic and not v_age_ok then
    raise exception 'Confirme que você tem 18 anos ou mais para finalizar o pedido.'
      using errcode = 'CC400', detail = '{"code":"age_required"}';
  end if;

  -- Taxa de entrega: por bairro (quando há bairros cadastrados) ou taxa única.
  if v_type = 'delivery' then
    if exists (select 1 from delivery_zones z where z.active) then
      select z.fee into v_fee
      from delivery_zones z
      where z.active and lower(btrim(z.name)) = lower(v_neighborhood);
      if not found then
        raise exception 'Ainda não entregamos no bairro %. Escolha um bairro da lista ou retire na loja.', v_neighborhood
          using errcode = 'P0001';
      end if;
    else
      v_fee := s.delivery_fee;
    end if;
    if v_subtotal < s.min_order then
      raise exception 'O pedido mínimo para entrega é %.', format_brl(s.min_order) using errcode = 'P0001';
    end if;
  end if;

  v_total := v_subtotal + v_fee;

  -- Cartão online: o cliente paga também a taxa de processamento. A base é tudo o que vai no cartão (itens + entrega); a conta é a de
  -- card_fee_cents(), em centavos inteiros. Nada disto vem do navegador: o total que a pessoa vê é só conferido abaixo (expected_total).
  if v_payment = 'card_online' then
    v_fee_bps := v_fs.card_fee_bps;
    v_fee_fixed := v_fs.card_fee_fixed_cents / 100.0;
    v_card_fee := card_fee_cents(round(v_total * 100)::integer, v_fs.card_fee_bps, v_fs.card_fee_fixed_cents) / 100.0;
    v_total := v_total + v_card_fee;
  elsif v_payment = 'pix_online' then
    -- Pix online: taxa de serviço do cliente (2,5% de itens + entrega). A parte do estabelecimento (outros 2,5%) não entra no total: sai do valor que a
    -- subconta recebe (ver payment_begin). Também só o banco calcula; o navegador só confere o total (expected_total).
    select * into v_fs from payment_fee_settings where id = 1;
    v_fee_bps := v_fs.pix_customer_fee_bps;
    v_card_fee := service_fee_cents(round(v_total * 100)::integer, v_fs.pix_customer_fee_bps) / 100.0;
    v_total := v_total + v_card_fee;
  end if;

  -- O valor mudou entre a tela do cliente e o envio (preço, promoção, taxa): nada é criado (o estoque reservado acima volta
  -- junto) e o site recebe o valor atual para a pessoa confirmar de olhos abertos.
  if v_expected is not null and v_expected <> v_total then
    raise exception 'Os valores do pedido mudaram. Confira o novo total antes de enviar.'
      using errcode = 'CC409',
            detail = jsonb_build_object(
              'code', 'price_changed',
              'subtotal', v_subtotal,
              'delivery_fee', v_fee,
              'payment_fee', v_card_fee,
              'total', v_total,
              'items', (
                select coalesce(jsonb_agg(jsonb_build_object('product_id', x.id, 'name', x.name, 'quantity', x.qty, 'unit_price', x.unit, 'ice_choice', x.ice, 'swap_to', x.swap) order by x.name, x.ice nulls first), '[]'::jsonb)
                from unnest(v_ids, v_names, v_qtys, v_units, v_ices, v_swaps) as x (id, name, qty, unit, ice, swap)
              )
            )::text;
  end if;

  if v_payment = 'cash' and v_change_text is not null then
    if v_change_text !~ '^[0-9]{1,6}([.,][0-9]{1,2})?$' then
      raise exception 'Confira o valor do troco.' using errcode = 'P0001';
    end if;
    v_change := replace(v_change_text, ',', '.')::numeric;
    if v_change < v_total then
      raise exception 'O troco precisa ser para um valor igual ou maior que o total (%).', format_brl(v_total)
        using errcode = 'P0001';
    end if;
  end if;

  insert into orders (
    customer_name, customer_phone, customer_email, delivery_type,
    address, address_number, neighborhood, complement, reference, notes,
    subtotal, delivery_fee, discount, total, payment_method, change_for, payment_fee, payment_fee_bps, payment_fee_fixed,
    customer_id, customer_linked_at, idempotency_key, request_hash, order_status,
    age_required, age_declared_at, age_declaration_version
  ) values (
    v_name, v_phone, v_email, v_type,
    v_address, v_number, v_neighborhood, v_complement, v_reference, v_notes,
    v_subtotal, v_fee, 0, v_total, v_payment, v_change, v_card_fee, v_fee_bps, v_fee_fixed,
    v_customer, case when v_customer is null then null else now() end, v_key, v_request_hash,
    -- Pagamento online: o pedido já reserva o estoque, mas só chega à loja ("novo") depois que o pagamento for confirmado.
    case when is_online_payment(v_payment) then 'awaiting_payment' else 'new' end,
    v_alcoholic, case when v_alcoholic then now() end, case when v_alcoholic then v_age_version end
  )
  returning * into v_order;

  insert into order_items (order_id, product_id, product_name, quantity, unit_price, total_price, ice_choice, swap_to_product_id)
  select v_order.id, x.id, x.name, x.qty, x.unit, x.unit * x.qty, x.ice, x.swap
  from unnest(v_ids, v_names, v_qtys, v_units, v_ices, v_swaps) as x (id, name, qty, unit, ice, swap);

  insert into order_status_history (order_id, from_status, to_status, changed_by_name)
  values (v_order.id, null, v_order.order_status, 'Cliente (site)');

  insert into order_tracking_tokens (order_id, token_hash, source)
  values (v_order.id, v_hash, 'checkout');

  return order_json(v_order.id)
    || case when v_legacy is null then '{}'::jsonb else jsonb_build_object('token', v_legacy) end;
end;
$$;
-- statement-breakpoint

drop function admin_set_order_status(uuid, text, uuid);
-- statement-breakpoint

create or replace function admin_set_order_status(p_order uuid, p_status text, p_admin uuid, p_reason text default null, p_age_checked boolean default false)
returns orders
language plpgsql
as $$
declare
  v_old orders;
  v_new orders;
  v_name text;
  c_flow constant text[] := array['new', 'confirmed', 'preparing', 'out_for_delivery', 'delivered'];
  v_from integer;
  v_to integer;
  v_reason text := nullif(left(btrim(regexp_replace(coalesce(p_reason, ''), '[[:cntrl:]]', ' ', 'g')), 200), '');
  v_check boolean := false;
begin
  if p_status not in ('new', 'confirmed', 'preparing', 'out_for_delivery', 'delivered', 'cancelled') then
    raise exception 'Status inválido.' using errcode = 'P0001';
  end if;

  select * into v_old from orders where id = p_order for update;
  if not found then
    raise exception 'Pedido não encontrado.' using errcode = 'P0001';
  end if;
  if v_old.order_status = p_status then
    return v_old;
  end if;
  if v_old.order_status = 'cancelled' then
    raise exception 'Este pedido foi cancelado e não pode ser reaberto.' using errcode = 'P0001';
  end if;
  -- Pagamento online ainda não confirmado: o pedido só segue para a loja quando a operadora confirmar. Cancelar pode.
  if v_old.order_status = 'awaiting_payment' and p_status <> 'cancelled' then
    raise exception 'Este pedido está aguardando o pagamento online. Ele só segue para a loja depois que o pagamento for confirmado.' using errcode = 'P0001';
  end if;

  if v_old.order_status = 'delivered' then
    if p_status = 'cancelled' then
      raise exception 'Este pedido já foi entregue e não pode ser cancelado. Se o dinheiro foi devolvido, marque o pagamento como reembolsado.'
        using errcode = 'P0001';
    end if;
    if p_status <> 'out_for_delivery' then
      raise exception 'Um pedido entregue só pode voltar para "Saiu para entrega" (se o clique foi por engano).' using errcode = 'P0001';
    end if;
  elsif p_status <> 'cancelled' then
    v_from := array_position(c_flow, v_old.order_status);
    v_to := array_position(c_flow, p_status);
    if v_to < v_from - 1 then
      raise exception 'O pedido só pode voltar uma etapa de cada vez.' using errcode = 'P0001';
    end if;
  end if;

  -- Pedido com bebida alcoólica só é dado como entregue depois de conferir o documento com foto (18 anos ou mais). Fica registrado quem conferiu e quando.
  -- Não se guarda nenhum dado do documento. Entrega recusada por falta de comprovação: cancele o pedido (com o motivo) em vez de concluí-lo.
  if p_status = 'delivered' and v_old.age_required and v_old.age_checked_at is null then
    if coalesce(p_age_checked, false) is not true then
      raise exception 'Confirme que o documento com foto foi conferido (18 anos ou mais) para concluir a entrega. Sem comprovação de maioridade, cancele o pedido.'
        using errcode = 'CC409', detail = '{"code":"age_check_required"}';
    end if;
    v_check := true;
  end if;

  select a.name into v_name from admins a where a.id = p_admin;

  update orders
     set order_status = p_status,
         age_checked_at = case when v_check then now() else age_checked_at end,
         age_checked_by_name = case when v_check then coalesce(v_name, 'Sistema') else age_checked_by_name end
   where id = p_order
  returning * into v_new;

  insert into order_status_history (order_id, from_status, to_status, changed_by, changed_by_name, reason)
  values (p_order, v_old.order_status, p_status, p_admin, coalesce(v_name, 'Sistema'), v_reason);

  if p_status = 'cancelled' then
    perform restore_order_stock(p_order);
    -- Pagamento online: a cobrança em aberto deixa de valer; se já estava paga, fica sinalizada para devolver o valor ao cliente.
    update payments
       set status = case when status = 'pending' then 'cancelled' else 'failed' end,
           closed_at = now(),
           needs_attention = needs_attention or status = 'creating',
           attention_reason = case when status = 'creating'
                                   then 'O pedido foi cancelado enquanto o Pix era criado. Confira na operadora se a cobrança existe e cancele-a.'
                                   else attention_reason end
     where order_id = p_order and status in ('creating', 'pending');
    update payments
       set needs_attention = true,
           attention_reason = 'Pedido cancelado depois de pago. Devolva o valor ao cliente.'
     where order_id = p_order and status = 'paid';
  end if;

  return v_new;
end;
$$;
-- statement-breakpoint

-- Cancelamento pelo cliente. A rota já provou quem é: pelo código de acompanhamento (p_hash, com ou sem o número) ou pela conta (p_customer + número).
-- Devolve o pedido (como o cliente o vê) ou NULL quando não há pedido com esses dados (código errado, vencido e pedido de outra conta são iguais).
create or replace function customer_cancel_order(p_hash text, p_number bigint, p_customer uuid, p_reason text, p_actor text)
returns jsonb
language plpgsql
volatile
as $$
declare
  o orders;
  v_why text;
  v_reason text := nullif(left(btrim(regexp_replace(coalesce(p_reason, ''), '[[:cntrl:]]', ' ', 'g')), 200), '');
begin
  if p_customer is not null then
    select o2.* into o from orders o2 where o2.customer_id = p_customer and o2.order_number = p_number for update;
  else
    select o2.* into o
      from orders o2
      join order_tracking_tokens t on t.order_id = o2.id
      join store_settings s on s.id = 1
     where t.token_hash = p_hash
       and t.revoked_at is null
       and (p_number is null or o2.order_number = p_number)
       and o2.updated_at > now() - make_interval(days => s.tracking_retention_days)
       for update of o2;
  end if;
  if not found then
    return null;
  end if;

  -- Já cancelado (toque duplo, outra aba, a loja cancelou antes): devolve como está. Nada é mexido de novo, em especial o estoque.
  if o.order_status = 'cancelled' then
    return order_json(o.id, p_customer is not null) || jsonb_build_object('already_cancelled', true);
  end if;

  v_why := order_cancel_why(o);
  if v_why is not null then
    raise exception 'Este pedido não pode mais ser cancelado por aqui.'
      using errcode = 'CC409', detail = jsonb_build_object('code', 'cancel_not_allowed', 'why', v_why)::text;
  end if;

  update orders set order_status = 'cancelled' where id = o.id;

  insert into order_status_history (order_id, from_status, to_status, changed_by_name, reason)
  values (o.id, o.order_status, 'cancelled', p_actor, v_reason);

  perform restore_order_stock(o.id);

  -- A cobrança em aberto deixa de valer (a rota cancela também na operadora). Como na mudança feita pelo painel.
  update payments
     set status = case when status = 'pending' then 'cancelled' else 'failed' end,
         closed_at = now(),
         needs_attention = needs_attention or status = 'creating',
         attention_reason = case when status = 'creating'
                                 then 'O pedido foi cancelado enquanto o Pix era criado. Confira na operadora se a cobrança existe e cancele-a.'
                                 else attention_reason end
   where order_id = o.id and status in ('creating', 'pending');

  return order_json(o.id, p_customer is not null);
end;
$$;
