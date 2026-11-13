-- Pendente: esta migração ainda não foi aplicada em nenhum banco remoto.
--
-- Formulários editáveis em mais telas e atas ligadas ao Almoxarifado (13/11/2026, pedido da
-- responsável).
--
-- 1. campos_personalizados (jsonb) e formulario_versao em cada registro cujo formulário passou a ser
--    editável pelo Gerenciador de formulários: pedidos de materiais (inclusive o pedido externo),
--    demandas, atas e contratos, veículos, equipamentos, materiais, motoristas, cotações de passagem,
--    execuções de manutenção e ocorrências. Guardam os valores dos campos criados na tela, com os
--    nomes usados, para o registro não mudar quando o formulário mudar depois.
-- 2. material_requests.campos_entrega: campos criados no formulário de registro de entrega.
-- 3. Ligação das atas e contratos (021) com o Almoxarifado: a entrada de material pode indicar o
--    item da ata ou do contrato (stock_movements.instrumento_item_id), e a utilização gerada guarda
--    a entrada que a originou (contract_instrument_usages.stock_movement_id).
--
-- Não altera registros existentes: as colunas novas começam vazias. Depende da 021.
-- Para desfazer: 022_forms_and_links.rollback.sql.
BEGIN;

ALTER TABLE public.material_requests
  ADD COLUMN campos_personalizados jsonb,
  ADD COLUMN formulario_versao integer,
  ADD COLUMN campos_entrega jsonb;
ALTER TABLE public.demands
  ADD COLUMN campos_personalizados jsonb,
  ADD COLUMN formulario_versao integer;
ALTER TABLE public.contract_instruments
  ADD COLUMN campos_personalizados jsonb,
  ADD COLUMN formulario_versao integer;
ALTER TABLE public.vehicles
  ADD COLUMN campos_personalizados jsonb,
  ADD COLUMN formulario_versao integer;
ALTER TABLE public.equipments
  ADD COLUMN campos_personalizados jsonb,
  ADD COLUMN formulario_versao integer;
ALTER TABLE public.materials
  ADD COLUMN campos_personalizados jsonb,
  ADD COLUMN formulario_versao integer;
ALTER TABLE public.fleet_drivers
  ADD COLUMN campos_personalizados jsonb,
  ADD COLUMN formulario_versao integer;
ALTER TABLE public.flight_quotes
  ADD COLUMN campos_personalizados jsonb,
  ADD COLUMN formulario_versao integer;
ALTER TABLE public.maintenance_executions
  ADD COLUMN campos_personalizados jsonb,
  ADD COLUMN formulario_versao integer;
ALTER TABLE public.request_occurrences
  ADD COLUMN campos_personalizados jsonb,
  ADD COLUMN formulario_versao integer;

ALTER TABLE public.stock_movements
  ADD COLUMN instrumento_item_id uuid REFERENCES public.contract_instrument_items(id);
CREATE INDEX idx_sm_instrumento_item ON public.stock_movements (instrumento_item_id) WHERE instrumento_item_id IS NOT NULL;

ALTER TABLE public.contract_instrument_usages
  ADD COLUMN stock_movement_id uuid UNIQUE REFERENCES public.stock_movements(id);

COMMIT;
