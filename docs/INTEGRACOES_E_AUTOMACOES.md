# Integrações e automações

Situação ao fim do Supercomando 03 (04/11/2026).

**Nenhuma integração externa está ativa.** Nenhum e-mail real foi enviado e nenhum evento foi criado em um Google Calendar real. Os dois conectores existem e foram testados só contra provedores simulados. A migração 006 não foi aplicada no banco real.

| Item | Situação |
|---|---|
| Notificações internas | Prontas, dependem da migração 006 |
| Fila, modelos e histórico de e-mails | Prontos, dependem da migração 006 |
| Envio pelo Resend | Conector pronto, **nunca usado com o provedor real**. Falta configuração e validação |
| Sincronização com Google Calendar | Conector pronto, **nunca usado com o provedor real**. Falta autorização, configuração e validação |
| Agenda interna, conflitos, filtros e detalhes | Prontos. Filtros e detalhes não dependem da 006 |
| Relatórios operacionais | Prontos |
| Sistema antigo | Não alterado, e sem sincronização com as planilhas |

## Como funciona

```
Ação na solicitação ── mesma transação ──> evento, fila de e-mails, notificações, agenda
                                                    │
                       worker, fora da requisição <─┘
                          ├─ Resend (ou simulado)
                          └─ Google Calendar (ou simulado)
```

- **Registro garantido:** o evento é gravado na mesma transação da mudança. Se a mudança for desfeita, nada é comunicado.
- **Provedor nunca bloqueia:** a requisição só grava no banco. Quem fala com o provedor é o worker. Provedor fora do ar não atrasa nem impede o registro.
- **Falha ao publicar:** a publicação roda em um `SAVEPOINT`. Se falhar, inclusive por falta da migração 006, a solicitação é registrada mesmo assim, e a falha vai para o log como `integration_publish_failed`. Nesse caso, aquela comunicação não existe na fila, mas o histórico da solicitação continua completo.
- **Código:** `backend/src/integrations/` e `backend/src/database/integrationRepository.ts`. Tabelas na migração `006_integrations.sql`.

### Controle de duplicidade

| Situação | Proteção |
|---|---|
| O mesmo fato registrado de novo | `integration_events.event_key` é único |
| O mesmo destinatário no mesmo evento | Único em `email_deliveries (event_id, recipient)` |
| Reagendar para a mesma data | A chave inclui a data: não gera nova mensagem |
| Mais de um processo na fila | `FOR UPDATE SKIP LOCKED` |
| Queda durante o envio | O item volta à fila depois de 2 minutos, com a mesma chave de idempotência no provedor |
| Evento de calendário | O identificador deriva da solicitação (`slm` + UUID sem hifens) |
| Agendamento alterado durante a sincronização | Controle por revisão: o item volta à fila, e a alteração mais recente prevalece |

**Limite conhecido:** enviar o formulário duas vezes cria duas solicitações e, portanto, duas confirmações. O botão é desativado durante o envio, mas a API não tem chave de idempotência na criação.

### Tentativas e falhas

- No máximo 5 tentativas, com esperas de 1, 5, 30 e 120 minutos.
- Falha temporária (rede, 408, 429, 5xx, além de 403 do Google, que também indica limite de uso) é repetida. Falha definitiva (outros 4xx) vai direto para "Com falha".
- Cada tentativa fica em `integration_attempts`, só com o código do erro. Mensagens de provedores não são guardadas, porque podem repetir endereços ou conteúdo.
- Ao esgotar as tentativas, quem tem `integrations:manage` recebe uma notificação. Falha de e-mail nunca gera outro e-mail, para não criar um ciclo.
- **Reprocessar** é manual e exige `integrations:manage`. Fica na auditoria como `integrations.retry`, e é recusado se o serviço não estiver configurado.

### Sem serviço configurado

Cada comunicação fica registrada como "Não enviado: serviço não configurado", e o worker não as toca. **Ligar o serviço depois não dispara as mensagens acumuladas**: só as novas saem sozinhas. As antigas só saem por reprocessamento autorizado, item a item.

## Fluxos de e-mail

Modelos em `backend/src/integrations/catalog.ts`, consultáveis em **Integrações > Modelos**. Ficam no código, e não no banco, para garantir que nenhum modelo receba dados pessoais. A edição pela tela não foi implementada.

| Módulo | Acontecimento | Solicitante | Equipe | Responsável (só plataforma) |
|---|---|---|---|---|
| Manutenção, Frota, Passagens | Recebimento | Sim | Sim | |
| Manutenção, Frota | Agendamento | Sim | | Sim |
| Manutenção, Frota | Reagendamento, com data anterior e motivo | Sim | | Sim |
| Manutenção, Frota | Início | Sim | | |
| Manutenção, Frota | Conclusão | Sim | | |
| Manutenção, Frota, Passagens | Cancelamento, com motivo | Sim | Sim | Sim |
| Frota | Ocorrência ou atraso, sem a descrição | Sim | Sim | |
| Passagens | Aguardando aprovação | Sim | Sim | |
| Passagens | Em emissão | Sim | | |
| Passagens | Emitida (também é a conclusão) | Sim | | |
| Almoxarifado | Pedido recebido | Sim | Sim | |
| Almoxarifado | Pedido externo registrado | Não: a pessoa pode não ter conta | Sim | |
| Almoxarifado | Em análise, parcial, atendido, entrega | Sim, se o pedido for interno | | |
| Almoxarifado | Recusa ou cancelamento, com motivo | Sim, se o pedido for interno | | |
| Almoxarifado | Previsão de entrega informada ou alterada, sem a justificativa | Sim, pela conta no pedido interno ou pelo e-mail informado no pedido digitado | | |
| Todos | Pendências, conforme o prazo definido em Parâmetros (ou `NOTIFICATION_PENDING_DAYS`, sem valor na tela) | | Sim | |

"Equipe" significa: notificação a quem tem as permissões do módulo e e-mail aos endereços configurados em `EMAIL_INTERNAL_TO_*`.

**Decisões a validar:**

- **Rejeição em Passagens:** o fluxo institucional não tem status de rejeição. Hoje, recusar uma aprovação é cancelar com motivo. O e-mail diz "cancelada", e não "rejeitada".
- **"Disponível para retirada ou entrega":** o sistema não sabe onde o material será retirado. O e-mail diz que os itens foram atendidos e aguardam o registro da entrega.
- **Pendências:** só existem com o prazo definido em Parâmetros ou, sem valor na tela, em `NOTIFICATION_PENDING_DAYS`. O prazo é institucional, e nenhum valor foi presumido.

**O que nunca entra em um e-mail:** CPF, nome de passageiro, descrição do pedido, trecho de viagem, nome de quem recebeu. Motivos e assuntos são texto livre: qualquer sequência no formato de CPF é mascarada antes do envio.

## Notificações internas

Sino no menu superior e página `/notificacoes`, com contagem de não lidas, leitura, "marcar todas" e link para o registro.

- **Destinatários:** solicitante; responsável pelo atendimento; e, nos eventos de equipe, quem tem todas as permissões para abrir o registro (por exemplo, `maintenance:update`, `maintenance:read` e `requests:read_all`).
- **Quem agiu não é avisado** da própria ação.
- **Permissão conferida a cada leitura:** quem perde o acesso deixa de ver a notificação.
- **Texto mínimo:** módulo, protocolo e situação. Sem motivo, assunto, nome ou CPF.
- **Falhas e pendências administrativas** chegam a quem tem `integrations:manage`, e os lembretes, à equipe do módulo.

Solicitações e cadastros pendentes continuam nas telas próprias.

## Agenda interna

A agenda é uma consulta sobre `service_requests`. Não existe segunda fonte de agendamentos: `calendar_sync_items` só controla o que falta refletir no calendário externo.

Visualização por dia, semana e mês; filtros por módulo, período, situação e responsável; detalhes do compromisso, histórico, link para a solicitação, reagendamento e cancelamento na própria janela, usando as mesmas rotas e permissões dos módulos. Compromissos de vários dias aparecem em cada dia. Antes, um compromisso iniciado antes do período exibido não aparecia.

### Conflitos

Os requisitos não trazem regras de disponibilidade. Por isso, **o sistema avisa e não proíbe**: quem agenda vê os compromissos e pode confirmar, e a decisão fica no histórico (`conflitosConfirmados`).

| Verificação | Regra |
|---|---|
| Mesmo responsável, em Manutenção e Frota | Horários sobrepostos pedem confirmação |
| Mesmo veículo | Mesmo texto, sem diferenciar maiúsculas e espaços. O veículo é texto livre: grafias diferentes não são detectadas |
| Sem término previsto | Conta só o horário de início. Nenhuma duração é presumida |
| Terminar quando o outro começa | Não é conflito |
| Cancelados ou concluídos | Não ocupam o horário |
| Agendamentos simultâneos | Bloqueio por responsável e por veículo: os dois não escapam da conferência |
| Tela desatualizada | `versao` em `POST .../schedule` responde 409 se o registro mudou |

**Limites:** editar o veículo depois de agendar não repete a conferência. Não há verificação de disponibilidade da equipe como um todo. Saber se o conflito deve bloquear é uma decisão institucional.

## Google Calendar

Implementado sem bibliotecas novas (`backend/src/integrations/transports.ts`): conta de serviço, OAuth 2.0 para servidores, escopo `calendar.events`.

- **Reagendar:** atualiza o mesmo evento. **Cancelar:** remove o evento.
- **Início, conclusão e edição:** atualizam o evento, se já acompanhado.
- **Conteúdo:** módulo, protocolo, título, situação, setor e, com `APP_PUBLIC_URL`, o link. Sem solicitante, responsável, descrição ou passageiros.
- **Sem término previsto:** o Google exige um fim. É enviada 1 hora, com `endTimeUnspecified`, só para exibição. **Validar no ambiente real.**
- **Indisponibilidade:** a agenda interna não depende do Google em nenhum ponto.
- **Conteúdo externo:** o título vem de texto livre (por exemplo, o local do serviço). Ver `PRIVACIDADE_E_TRATAMENTO_DE_DADOS.md`.

Passagens e Almoxarifado não entram na agenda.

## Histórico e rastreabilidade

`request_history` e `material_request_history` têm o mesmo formato: quem, quando, ação, status anterior e novo, comentário e detalhes. As duas telas exibem o histórico no mesmo formato. Nenhuma tem rota de alteração, e os gatilhos da migração 005 recusam `UPDATE` e `DELETE`. `integration_events` e `integration_attempts` são igualmente imutáveis.

CPF válido digitado em comentário, motivo ou ocorrência é mascarado antes de gravar. Telefones são mantidos.

**Observação:** o gatilho da 005 recusa alterações em `request_history` e `material_request_history`, mas com a mensagem técnica "record new has no field action", e não com a mensagem prevista. A proteção funciona. Como a 005 não foi aplicada, vale corrigir o texto antes de aplicá-la. Não alterei a 005.

**Limite:** a conferência de inventário tem auditoria, mas não uma tabela de histórico própria.

## Relatórios

`GET /reports/operational` e a seção "Agendamentos e execução" em Relatórios, com exportação CSV.

| Indicador | Fonte | Limitação informada |
|---|---|---|
| Agendamentos, reagendamentos e cancelamentos | Histórico | Conta ações, não solicitações |
| Tempo de atendimento | Início e término reais | Mostra quantos registros entraram e quantos ficaram de fora |
| Execução de frota, ocorrências e atrasos | Registros da frota | |
| Pedidos por origem e parciais | Pedidos de material | |
| Conferência e divergências | Conferências, só com `warehouse:manage` | |

O período considera a data de abertura. Sem `requests:read_all`, cada pessoa vê só o próprio alcance. Não há estimativas nem valores fictícios. PDF não foi implementado.

## O que a TI precisa fornecer

| Item | Variável | Sem isso |
|---|---|---|
| Migração 006 aplicada | | Solicitações funcionam, mas sem comunicações. Telas de notificações e integrações respondem que falta a atualização |
| Ligar o worker, se não for produção | `INTEGRATIONS_WORKER_ENABLED=true` | Filas não são processadas |
| Domínio verificado e chave do Resend | `RESEND_API_KEY`, `RESEND_FROM` | Nenhum envio |
| Autorização expressa de envio | `NOTIFICATION_EMAILS_ENABLED=true` | Nenhum envio, mesmo com a chave do Resend |
| Endereço público | `APP_PUBLIC_URL`, com https | Mensagens sem link |
| Destinatários internos, se houver | `EMAIL_INTERNAL_TO_MAINTENANCE`, `_FLEET`, `_FLIGHTS`, `_WAREHOUSE`, `_SYSTEM` | Equipe avisada só pela plataforma |
| Cópias, se autorizadas | `EMAIL_CC_MAINTENANCE`, `_FLEET`, `_FLIGHTS`, `_WAREHOUSE` | Sem cópias |
| Prazo de lembrete, se desejado | Parâmetros, na tela, ou `NOTIFICATION_PENDING_DAYS` | Sem lembretes |

**Google Calendar:**

1. Projeto no Google Cloud institucional, com a Google Calendar API ativada.
2. Conta de serviço própria do sistema, nunca uma conta pessoal, e sua chave: `GOOGLE_CALENDAR_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_CALENDAR_PRIVATE_KEY`.
3. Calendários institucionais compartilhados com a conta de serviço, com permissão "Fazer alterações nos eventos": `GOOGLE_CALENDAR_ID_MAINTENANCE`, `GOOGLE_CALENDAR_ID_FLEET`.
4. `GOOGLE_CALENDAR_ENABLED=true`.

**Validação antes de declarar ativo:** em ambiente de homologação, com calendário e caixas de e-mail de teste, criar, reagendar e cancelar uma solicitação; conferir a entrega, o evento e o tempo de renovação do token; forçar uma falha e reprocessar.

O transporte simulado (`EMAIL_TRANSPORT=simulated`, `GOOGLE_CALENDAR_TRANSPORT=simulated`) é recusado em produção. A tela de Integrações mostra "Não configurado", "Simulado" ou "Configurado", e esta última só significa que os valores existem.

## Compatibilidade com o sistema antigo

**O código e as planilhas do sistema antigo não estão no repositório, em nenhum branch.** Os fluxos abaixo foram construídos a partir do supercomando e dos requisitos, e **a paridade com o antigo não foi verificada**.

| Rotina | Situação no novo | Validar com a área |
|---|---|---|
| Confirmação, agendamento, reagendamento, cancelamento | Modernizada: fila, tentativas e histórico | Textos, remetentes e destinatários |
| Histórico | Modernizado: imutável | Campos que o antigo registrava |
| Calendários | Conector pronto, sem validação | Quantos calendários existem e quem os usa |
| Dashboard | Dados reais do novo sistema | Indicadores do antigo |
| Execução de frota | Com ocorrências e atrasos | Campos, sobretudo veículos e motoristas |

O sistema antigo não foi alterado. Enquanto os dois funcionarem, uma solicitação registrada em um não aparece no outro. Se o antigo também criar eventos nos mesmos calendários, **haverá compromissos paralelos**, sem conflito técnico, mas sem deduplicação. Use calendários distintos ou decida antes qual dos dois escreve.

## Testes

| Comando | Cobre |
|---|---|
| `npm run test:backend` | Redação, modelos, modos de configuração, Resend e Google com clientes falsos |
| `npm run test:integration` | Fila, duplicidade, concorrência, falhas, reprocessamento, conflitos, notificações, relatórios, migração e reversão, em PostgreSQL descartável |
| `npm run test:e2e` | Avisos, conflitos, agenda, notificações e administração no navegador, com transportes simulados e bloqueio de rede |

Os resultados estão em `PLANO_DESENVOLVIMENTO_INTEGRAL.md`.
