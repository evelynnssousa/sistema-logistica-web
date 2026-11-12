# Relatórios e planilhas

Criado em 11/11/2026. As planilhas são arquivos Excel (.xlsx) gerados na hora, só com leitura dos
dados: baixar não altera nada. Cada download fica registrado na auditoria (quem e qual período).
Os números continuam numéricos, para somar e filtrar no Excel.

## Onde baixar

| Planilha | Onde | Quem vê o botão |
|---|---|---|
| Almoxarifado | Almoxarifado → Relatórios → "Planilha do Almoxarifado" | Quem administra o Almoxarifado (Administrador e Operador SLM da equipe) |
| Frota | Frota → "Planilha da Frota", abaixo da lista de solicitações | Quem consulta relatórios e a Frota. As abas de carga horária só para quem administra os motoristas |
| Manutenção | Manutenção → "Planilha da Manutenção", abaixo da lista | Quem consulta relatórios e a Manutenção |
| Passagens aéreas | Passagens Aéreas → "Planilha das Passagens Aéreas", abaixo da lista | Quem consulta relatórios e as Passagens. Valor e companhia só para quem atende as Passagens |
| Geral | Relatórios → "Baixar planilha (Excel)", no alto da tela | Quem consulta relatórios. Usa os filtros da tela (período, módulo, setor, responsável e situação) |
| Controle de Demandas | Controle de Demandas → Relatórios → Excel | Quem acessa os relatórios de Demandas. Usa os filtros da tela |

Escolha o período ("De" e "Até", até cerca de 13 meses) e clique em **Baixar planilha (Excel)**.

## Planilha do Almoxarifado

| Aba | Conteúdo |
|---|---|
| Sobre | Período, quem gerou, quando, e como cada número é calculado |
| Estoque | Situação **de agora**: código, material, unidade, estoque físico, reservado, disponível, mínimo, se está abaixo do mínimo, **consumo médio por mês**, base do consumo (meses), entregue nos últimos 12 meses, total fornecido e última movimentação |
| Pedidos | Pedidos abertos no período: protocolo, data, situação, origem (interna ou governamental), setor, solicitante, itens, quantidades solicitadas e atendidas, data da entrega |
| Itens entregues | Cada material entregue no período, com o pedido, o setor e as quantidades |
| Movimentações | Entradas e saídas do estoque interno registradas no período |

### Consumo médio por mês

Também aparece na tela **Almoxarifado → Estoque**, na coluna "Consumo médio por mês".

- Soma as quantidades **entregues** (pedidos na situação "Entregue") nos **últimos 12 meses**.
- Divide pelos meses da base: 12, ou menos se a primeira entrega do material foi mais recente
  (no mínimo 1 mês). Assim, um material novo não fica com uma média artificialmente baixa.
- Mostra a base ("base: 3 meses") para indicar o quanto a média já é confiável.
- **Não** usa as movimentações manuais do estoque, que podem repetir as mesmas entregas.
- "Sem entregas": o material nunca foi entregue por pedido.

## Planilha da Frota

| Aba | Conteúdo |
|---|---|
| Sobre | Período, quem gerou, quando, e as regras de cálculo |
| Viagens | Protocolo, data, situação, origem, destino, finalidade, setor, motorista, veículo, início e fim reais, duração, hodômetro inicial e final, **km rodados**. Última linha: totais de horas e de km |
| Veículos | Diário de bordo do período por placa: utilizações, km rodados, abastecimentos, litros, valor, manutenções, ocorrências e km atual |
| Carga horária | Por motorista: dias com viagem, viagens, tempo em viagem, tempo em viagem fora do horário, jornada estimada, jornada prevista, **horas extras**, **horas a menos** e saldo |
| Carga horária por dia | O mesmo, dia a dia, com a primeira saída e a última chegada |

- **Data da viagem:** o início real; se ainda não começou, a data agendada; sem agendamento, a do pedido.
- **Km rodados:** hodômetro final menos o inicial, quando o motorista informou os dois no portal.
  Para isso, ligue o hodômetro em **Configurações → Configurações do Portal do Motorista → Execução das viagens → Obrigatório para iniciar** e
  **Obrigatório para finalizar** (marque o hodômetro nos dois).
- Os passageiros e o solicitante não entram na planilha.

### Carga horária: é uma estimativa

**Os motoristas não batem ponto no sistema** (decisão da responsável, 12/11/2026). As horas vêm só
do início e do fim real de cada viagem. Por isso:

- **Jornada estimada do dia** = da primeira saída à última chegada, menos o intervalo configurado.
  Nunca fica menor que o tempo efetivamente em viagem.
- **Jornada prevista** = a duração prevista em **Configurações → Configurações do Portal do Motorista → Jornada de trabalho** ou, sem ela, do início ao fim da faixa, menos o intervalo. Só nos dias da jornada. Em
  outro dia (por exemplo, sábado), a prevista é zero e tudo conta como hora extra.
- **Horas extras** = o que passa da prevista. **Horas a menos** = o que falta para ela.
- **Dias sem viagem não entram.** O sistema não sabe se a pessoa trabalhou na base ou não
  trabalhou, então não conta horas a menos nesses dias.
- **Em viagem fora do horário** = minutos de viagem antes do início, depois do fim da faixa ou em
  dia fora da jornada.
- A jornada usada é a que está em Configurações **no momento do download**.

Os números servem para acompanhar a carga de trabalho da Frota. Não substituem o controle de
frequência oficial dos servidores.

## Planilha da Manutenção

| Aba | Conteúdo |
|---|---|
| Sobre | Período, quem gerou e regras |
| Solicitações | Protocolo, abertura, situação, setor, andar, sala, local, tipo de serviço, prioridade, complexidade, solicitante, responsável, prazo, agendamento, início e fim reais, tempo de execução, conclusão, dias até concluir, se ficou dentro do prazo e motivo do cancelamento |
| Por tipo de serviço, Por setor, Por andar | Total, em aberto, concluídas, canceladas e dias médios até concluir |
| Evolução mensal | Abertas e concluídas por mês |
| Execuções | Registros de execução (quem fez, equipamento, serviço e pendências), para quem vê todas as solicitações |

## Planilha das Passagens Aéreas

| Aba | Conteúdo |
|---|---|
| Solicitações | Protocolo, abertura, situação, setor, solicitante, responsável, tipo de viagem, trechos e datas de ida e volta, **quantidade** de passageiros, bagagem, companhia e valor da cotação escolhida (para quem atende), data de emissão e dias até emitir. Última linha: total dos valores |
| Por setor, Por destino | Total, em aberto, emitidas, canceladas e dias médios até emitir |
| Evolução mensal | Abertas e emitidas por mês |

**Nomes e CPFs de passageiros nunca entram em planilha.**

## Planilha geral (Relatórios)

Substitui o antigo "Exportar para Excel (CSV)". É gerada no servidor e respeita os filtros da tela.
Sem período escolhido, vale todo o período.

| Aba | Conteúdo |
|---|---|
| Sobre | Filtros usados, quem gerou e quando |
| Indicadores | Solicitações, em aberto, concluídas, canceladas, atrasadas, dias médios até concluir e tempo médio de execução |
| Por módulo, Por setor, Por responsável | Total, em aberto, concluídas, canceladas e dias médios até concluir |
| Por situação | Contagem por módulo e situação |
| Evolução mensal | Abertas e concluídas por mês |
| Atrasadas | Prazo vencido e ainda em aberto, da mais atrasada para a menos |
| Solicitações | Lista de Manutenção, Frota e Passagens (sem o título das Passagens, que repete o trecho) |

## Planilha do Controle de Demandas

Melhorada em 12/11/2026: ganhou a aba **Sobre** (quem gerou e quais filtros), a aba **Atrasadas**
(com os dias de atraso), os indicadores de **conclusão dentro do prazo** e, na lista, setor de
origem, solicitante, início previsto, data de conclusão, dias de atraso, etapas, progresso,
reaberturas e com quem a demanda está aguardando.

## Para quem mantém o sistema

- Rotas novas (12/11/2026): `GET /api/reports/maintenance/spreadsheet` (`reports:read` e `maintenance:read`), `GET /api/reports/flights/spreadsheet` (`reports:read` e `flights:read`) e `GET /api/reports/general/spreadsheet` (`reports:read`; filtros opcionais `from`, `to`, `module`, `sectorId`, `responsibleId`, `status`). Código em `backend/src/reports/requestSpreadsheets.ts`; auditoria `maintenance.spreadsheet_exported`, `flights.spreadsheet_exported` e `reports.spreadsheet_exported`.
- Rotas: `GET /api/reports/warehouse/spreadsheet` (exige `warehouse:manage`) e
  `GET /api/reports/fleet/spreadsheet` (exige `reports:read` e `fleet:read`; as abas de horas
  exigem `fleet:manage`). Ambas pedem `from` e `to` (instantes ISO) e recusam períodos acima de 400 dias.
- Código: `backend/src/reports/operationalSpreadsheets.ts`, `driverWorkload.ts` (regras das horas)
  e `backend/src/requests/warehouseConsumption.ts` (consumo médio).
- Auditoria: `warehouse.spreadsheet_exported` e `fleet.spreadsheet_exported`, com o período.
- Sem migração nova: tudo vem das tabelas existentes (005, 009, 011, 016, 017).
