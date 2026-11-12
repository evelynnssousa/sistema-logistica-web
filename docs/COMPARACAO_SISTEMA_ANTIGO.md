# Comparação com o sistema antigo

Preparado em 06/11/2026 (achado P-06 da auditoria de 05/11). **Conclusão: a paridade com o sistema antigo continua sem comprovação e é bloqueio de homologação.** Este documento registra o que foi possível comparar, o que não foi, e o roteiro para concluir a comparação com a área usuária. Nenhuma regra foi presumida ou inventada.

## 1. Fontes procuradas

| Fonte | Situação |
|---|---|
| Sistema antigo (Google Sheets e Google Apps Script) | **Não disponível.** Não está no repositório, em nenhum branch, nem nos documentos. Não foi acessado: os Supercomandos proíbem modificá-lo, e não houve acesso de leitura autorizado |
| Planilhas, formulários e modelos de e-mail antigos | Não disponíveis |
| Textos dos Supercomandos 01 a 12 (histórico das sessões) | Disponíveis. Descrevem o sistema antigo só em termos gerais (seção 2) |
| Versão web anterior no banco real (11 tabelas, `backend/database/schema/001_public_schema_snapshot.sql`) | Disponível. É a versão web anterior a este trabalho, e não o sistema de planilhas. Comparada na seção 3 |
| Documentos do repositório | Registram, desde o início, que a paridade não pôde ser verificada (`PLANO_DESENVOLVIMENTO_INTEGRAL.md`, `INTEGRACOES_E_AUTOMACOES.md`) |

## 2. O que os Supercomandos dizem do sistema antigo

Trechos dos textos originais, sem interpretação adicional:

- "O sistema antigo já possui rotinas de e-mail, histórico, calendários e atualização de solicitações."
- "Preservar e modernizar os fluxos de comunicação do sistema antigo."
- "A migração gradual do sistema antigo deve preservar os fluxos, históricos e informações que foram definidos como necessários."
- "O sistema antigo de Google Sheets e Apps Script continuará funcionando durante a transição." / "Não modificar o Google Apps Script ou as planilhas antigas."
- "Não implementar sincronização automática com as planilhas sem uma decisão e autorização específicas."

| Capacidade citada do antigo | Equivalente no sistema novo | Paridade |
|---|---|---|
| Rotinas de e-mail | Fila de e-mails com modelos versionados, por evento e módulo (`INTEGRACOES_E_AUTOMACOES.md`) | **Não verificada:** textos, destinatários, cópias e momentos de envio do antigo são desconhecidos. Envio real ainda não homologado (P-05) |
| Histórico | Histórico imutável por solicitação, com autor, data, motivo, anterior e novo | **Não verificada:** não se sabe quais informações o antigo registrava |
| Calendários | Agenda interna (Manutenção, Frota e Passagens). Integração com Google Calendar removida em 11/11/2026 | **Não verificada:** não se sabe quais calendários o antigo usa nem o formato dos eventos. Risco de eventos duplicados se os dois escreverem nos mesmos calendários |
| Atualização de solicitações | Status, agendamento, reagendamento, cancelamento, execução, por módulo | **Não verificada** quanto a campos e status do antigo |

## 3. Comparação com a versão web anterior (banco real)

Esta é a única comparação verificável. Os registros da versão anterior permanecem no banco e continuam legíveis.

### Manutenção e Frota (`service_requests`, `tipo` = `manutencao` ou `frota`)

| Versão anterior | Sistema novo | Observação |
|---|---|---|
| `pendente`, `em_analise` | Aguardando agendamento | Os dois viram um só na exibição. O valor gravado não muda |
| `agendada` | Agendado | — |
| `concluida` | Concluído | — |
| `cancelada` | Cancelado | — |
| `rejeitada` | Cancelado | **Perda de distinção na exibição:** o novo fluxo não tem "Rejeitada". O valor original fica no banco, mas a tela mostra "Cancelado". Confirmar com a área se recusa e cancelamento precisam aparecer separados |
| `titulo`, `descricao`, `prioridade`, `dados`, `data_agendada`, `responsavel_id`, `observacao_operador`, `concluida_em`, `lgpd_aceite` | Mantidos, com campos novos por módulo | Nenhuma coluna removida (teste "registros de status antigo aparecem traduzidos e seguem o fluxo") |
| — | Reagendado, Em andamento, motivos padronizados, execução real, ocorrências | Novos |

### Passagens aéreas (`tipo` = `passagem`)

| Versão anterior | Sistema novo | Observação |
|---|---|---|
| `pendente`, `em_analise` | Em cotação | — |
| `agendada` | Em emissão | Tradução por equivalência de etapa, a confirmar com a área |
| `concluida` | Emitida | — |
| `rejeitada`, `cancelada` | Cancelada | Mesma observação sobre "Rejeitada" |

### Almoxarifado (`material_requests`, `materials`, `stock_movements`)

| Versão anterior | Sistema novo | Observação |
|---|---|---|
| Status `pendente`, `em_analise`, `atendido`, `rejeitado`, `cancelado` | Mantidos, mais `atendido_parcial` | Sem perda |
| `estoque_atual`, `estoque_minimo`, `stock_movements` com gatilho de saldo | Mantidos; saldo físico, reservado e disponível separados | O gatilho antigo continua (a 018 só fixa o `search_path`) |
| `request_forms` (campos configuráveis) | Formulários em `system_settings` | `request_forms` fica sem uso e sem exclusão |
| `setores` | Cadastro central de setores | Mantido |

## 4. Diferenças e possíveis perdas funcionais conhecidas

| # | Diferença | Origem | Situação |
|---|---|---|---|
| 1 | "Rejeitada" exibida como "Cancelado"/"Cancelada" | Versão web anterior | Decisão da área: manter ou criar status próprio |
| 2 | Duas origens de pedido de material ("Nova solicitação" e "Pedir material") | P-07 | Decisão pendente |
| 3 | Sem sincronização com as planilhas | Proibida sem autorização | Pedidos feitos no antigo não aparecem no novo, e vice-versa |
| 4 | Calendários possivelmente compartilhados | Desconhecido | Decidir quem escreve em cada calendário antes de ligar o Google Calendar |
| 5 | Textos e destinatários de e-mail | Desconhecidos | Comparar modelo a modelo (seção 5) |

## 5. Roteiro para concluir a comparação

A ser feito com uma pessoa da SLM que use o sistema antigo, sem alterá-lo (só leitura ou demonstração):

1. **Para cada módulo (Manutenção, Frota, Passagens, Almoxarifado):** listar as colunas da planilha e os campos do formulário antigo; marcar, para cada um, o campo correspondente no novo ou "não existe".
2. **Status:** listar todos os valores usados na planilha e o significado de cada um; conferir com as tabelas da seção 3.
3. **E-mails:** para cada evento (abertura, agendamento, reagendamento, cancelamento, conclusão), copiar assunto, corpo, destinatários e cópias do antigo e comparar com o modelo correspondente na tela de Modelos de e-mail.
4. **Calendários:** identificar quais calendários o Apps Script usa e o formato do evento.
5. **Histórico e relatórios:** listar o que a área consulta hoje e confirmar que o novo oferece.
6. Registrar cada diferença como "igual", "melhorado", "faltando" ou "decisão da área", com a assinatura de quem conferiu.

**Critério de conclusão:** todas as linhas do roteiro preenchidas e nenhuma diferença "faltando" sem decisão registrada. Até lá, este item permanece **BLOQUEADO POR DEPENDÊNCIA EXTERNA**.
