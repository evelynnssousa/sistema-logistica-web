-- Pendente: esta migração ainda não foi aplicada em nenhum banco remoto.
--
-- Atas unificadas (13/11/2026, pedido da responsável): nem toda ata é só de materiais do
-- Almoxarifado. As atas passam a ficar todas em Controle de Demandas → Atas e contratos (021), que
-- aceita material, serviço, curso ou outro e tem o registro de utilização. As atas do Almoxarifado
-- (020) deixam de ser cadastradas.
--
-- 1. public.warehouse_price_agreements.instrumento_id: para qual ata do Controle de Demandas cada
--    ata do Almoxarifado foi convertida. A tabela antiga fica como histórico, encerrada.
-- 2. Cada ata do Almoxarifado vira uma ata (categoria "material") do setor do Almoxarifado, com um
--    item "Valor global da ata" em reais (quantidade = valor da ata, valor unitário R$ 1,00): o saldo
--    continua sendo controlado em dinheiro, como antes.
-- 3. Cada entrada no estoque com valor que usou a ata vira uma utilização desse item, ligada à
--    entrada (stock_movement_id). O gasto e o saldo ficam iguais aos de antes.
-- 4. Setor responsável: o setor do Controle de Demandas cujo nome contém "Almoxarifado"; sem ele, é
--    criado o setor "Almoxarifado". Quem cadastrou as atas antigas entra nesse setor como
--    colaborador, para continuar podendo registrar utilizações.
--
-- Sem atas do Almoxarifado, só acrescenta a coluna. Não apaga nem altera movimentações de estoque.
-- Depende da 020, 021 e 022. Para desfazer: 024_unified_agreements.rollback.sql (só antes de haver
-- conversão).
BEGIN;

ALTER TABLE public.warehouse_price_agreements
  ADD COLUMN instrumento_id uuid REFERENCES public.contract_instruments(id);

DO $convert$
DECLARE
  agreement record;
  movement record;
  sector uuid;
  instrument uuid;
  item uuid;
  number text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.warehouse_price_agreements) THEN
    RETURN;
  END IF;

  SELECT id INTO sector FROM public.demand_sectors
   WHERE lower(nome) LIKE '%almoxarifado%'
   ORDER BY ativo DESC, ordem, nome LIMIT 1;
  IF sector IS NULL THEN
    INSERT INTO public.demand_sectors (nome, sigla, descricao)
    VALUES ('Almoxarifado', 'ALM', 'Criado pela migração 024 para receber as atas do Almoxarifado.')
    RETURNING id INTO sector;
  END IF;

  INSERT INTO public.demand_sector_members (sector_id, user_id)
  SELECT DISTINCT sector, a.criado_por FROM public.warehouse_price_agreements a
  ON CONFLICT DO NOTHING;

  FOR agreement IN SELECT * FROM public.warehouse_price_agreements ORDER BY created_at LOOP
    -- Número já usado por outra ata do Controle de Demandas: ganha o sufixo do Almoxarifado.
    number := trim(agreement.numero);
    IF EXISTS (SELECT 1 FROM public.contract_instruments
                WHERE tipo = 'ata' AND lower(trim(numero)) = lower(number)) THEN
      number := left(number, 50) || ' (Almox.)';
    END IF;

    INSERT INTO public.contract_instruments
      (tipo, numero, objeto, categoria, fornecedor, valor_total, vigencia_inicio, vigencia_fim,
       setor_responsavel_id, encerrado, observacoes, criado_por, created_at)
    VALUES
      ('ata', number,
       COALESCE(NULLIF(trim(agreement.objeto), ''), 'Ata do Almoxarifado ' || trim(agreement.numero)),
       'material', agreement.fornecedor, agreement.valor_total, agreement.vigencia_inicio,
       agreement.vigencia_fim, sector, NOT agreement.ativo,
       'Convertida da ata do Almoxarifado pela migração 024. O saldo é controlado em reais pelo item "Valor global da ata".',
       agreement.criado_por, agreement.created_at)
    RETURNING id INTO instrument;

    INSERT INTO public.contract_instrument_items
      (instrument_id, numero_item, descricao, unidade, quantidade_registrada, valor_unitario)
    VALUES (instrument, '1', 'Valor global da ata', 'R$', agreement.valor_total, 1)
    RETURNING id INTO item;

    -- Mesmo critério do gasto antigo: entradas com valor informado.
    FOR movement IN
      SELECT s.* FROM public.stock_movements s
       WHERE s.ata_id = agreement.id AND s.tipo = 'entrada' AND s.valor_informado AND s.valor_total > 0
         AND NOT EXISTS (SELECT 1 FROM public.contract_instrument_usages u WHERE u.stock_movement_id = s.id)
       ORDER BY s.created_at
    LOOP
      INSERT INTO public.contract_instrument_usages
        (instrument_id, item_id, quantidade, valor_total, data_utilizacao, documento, observacao,
         registrado_por, stock_movement_id, created_at)
      VALUES
        (instrument, item, movement.valor_total, movement.valor_total,
         (movement.created_at AT TIME ZONE 'America/Sao_Paulo')::date,
         NULLIF(concat_ws(' · ', 'NF ' || movement.nota_fiscal, 'Empenho ' || movement.empenho), ''),
         'Entrada registrada no Almoxarifado (ata convertida pela migração 024).',
         movement.usuario_id, movement.id, movement.created_at);
    END LOOP;

    UPDATE public.warehouse_price_agreements
       SET instrumento_id = instrument, ativo = false, updated_at = now()
     WHERE id = agreement.id;
  END LOOP;
END
$convert$;

COMMIT;
