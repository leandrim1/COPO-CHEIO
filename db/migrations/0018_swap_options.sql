-- ---------------------------------------------------------------------------------------------
-- Troca do energético: a lista de energéticos que o cliente pode escolher e o valor do energético que vem no combo (pedido do dono).
--
-- A 0017 ligou cada combo a UM produto (o energético que vem nele). Dois ajustes, ambos opcionais por combo:
--  • products.swap_base_price: o VALOR do energético que vem no combo, para quando ele não é um produto do cardápio (ex.: o energético do
--    combo não é vendido avulso). Se o combo tem um produto escolhido (swap_base_product_id), vale o preço de agora desse produto.
--  • product_swap_options: os energéticos que o cliente pode escolher na troca deste combo. Combo SEM lista continua aceitando qualquer
--    energético de 2L (como já era); com lista, só os dela.
-- A conta não muda: a linha trocada custa o combo + max(0, preço do energético novo − valor do energético que vem no combo); igual ou mais
-- barato = sem diferença. Combo sem produto nem valor definido não aceita troca.
--
-- Só acrescenta (uma coluna e uma tabela) e troca create_order por uma versão igual para tudo o que já existe.
-- ---------------------------------------------------------------------------------------------

alter table products
  add column swap_base_price numeric(10, 2) check (swap_base_price is null or swap_base_price > 0);
-- statement-breakpoint

create table product_swap_options (
  product_id uuid not null references products (id) on delete cascade,
  option_id uuid not null references products (id) on delete cascade,
  primary key (product_id, option_id),
  check (product_id <> option_id)
);
-- statement-breakpoint

create index product_swap_options_option_idx on product_swap_options (option_id);
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
  -- Pagamento online: sem uma conta aprovada na operadora não há como cobrar. (O painel também não deixa ligar o meio de pagamento assim.)
  if is_online_payment(v_payment) and not exists (select 1 from merchant_accounts a where a.status = 'approved') then
    raise exception 'O pagamento online não está disponível agora. Escolha outra forma de pagamento.' using errcode = 'P0001';
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

    -- Promoção só vale dentro da janela de datas (sem datas, vale sempre).
    v_unit := coalesce(effective_promo(v_product.promo_price, v_product.promo_starts_at, v_product.promo_ends_at), v_product.price);

    -- Gelo: se a categoria do produto pede a escolha (marca no registro da categoria, não o nome), cada linha precisa trazer
    -- 'normal' ou 'flavored'. Em produto que não pede, qualquer valor de ice_choice é ignorado (o pedido fica como sempre foi).
    v_requires := v_product.category_id is not null
      and exists (select 1 from categories c where c.id = v_product.category_id and c.ice_choice_required);

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

  -- O valor mudou entre a tela do cliente e o envio (preço, promoção, taxa): nada é criado (o estoque reservado acima volta
  -- junto) e o site recebe o valor atual para a pessoa confirmar de olhos abertos.
  if v_expected is not null and v_expected <> v_total then
    raise exception 'Os valores do pedido mudaram. Confira o novo total antes de enviar.'
      using errcode = 'CC409',
            detail = jsonb_build_object(
              'code', 'price_changed',
              'subtotal', v_subtotal,
              'delivery_fee', v_fee,
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
    subtotal, delivery_fee, discount, total, payment_method, change_for,
    customer_id, customer_linked_at, idempotency_key, request_hash, order_status
  ) values (
    v_name, v_phone, v_email, v_type,
    v_address, v_number, v_neighborhood, v_complement, v_reference, v_notes,
    v_subtotal, v_fee, 0, v_total, v_payment, v_change,
    v_customer, case when v_customer is null then null else now() end, v_key, v_request_hash,
    -- Pagamento online: o pedido já reserva o estoque, mas só chega à loja ("novo") depois que o pagamento for confirmado.
    case when is_online_payment(v_payment) then 'awaiting_payment' else 'new' end
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
