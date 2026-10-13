-- ---------------------------------------------------------------------------------------------
-- Comissão do Pix online: de 5% para 2% do total do pedido (pedido do dono do sistema).
--
-- Só troca a taxa de AGORA EM DIANTE: payment_commission_bps() é lida na hora de criar cada cobrança e o valor (bps e centavos) fica
-- guardado nela. Cobranças já criadas — se houver alguma — mantêm a taxa com a qual nasceram, para o histórico e a conciliação com a
-- operadora continuarem batendo. Nada é apagado nem reescrito.
--
-- Fica numa migration nova (e não na 0014) porque as migrations aplicadas nunca são refeitas: quem já rodou a 0014 em algum banco
-- (por exemplo um preview com MIGRATE_ON_PREVIEW=1) receberia a taxa antiga. Pedido de R$ 100,00 → R$ 2,00; R$ 10,10 → R$ 0,20.
-- ---------------------------------------------------------------------------------------------

create or replace function payment_commission_bps()
returns integer
language sql
immutable
as $$
  select 200;
$$;
