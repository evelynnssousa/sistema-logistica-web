# Integrações e automações

Situação ao fim do Supercomando 03 (04/11/2026).

**Nenhuma integração externa está ativa.** Nenhum e-mail real foi enviado. O conector do Resend existe e foi testado só contra provedor simulado. A migração 006 não foi aplicada no banco real.

**Google Calendar removido em 11/11/2026**, a pedido da responsável: a agenda é só interna e passou a incluir Passagens aéreas. A tabela `calendar_sync_items` (migração 006) continua no banco apenas como histórico; nada novo é gravado nela, e não há tela, rota, variável ou processo que a use.

| Item | Situação |
|---|---|
| Notificações internas | Prontas, dependem da migração 006 |
| Fila, modelos e histórico de e-mails | Prontos, dependem da migração 006 |
| Envio pelo Resend | Conector pronto, **nunca usado com o provedor real**. Falta configuração e validação |
| Sincronização com Google Calendar | **Removida em 11/11/2026.** A agenda é só interna |
| Agenda interna, conflitos, filtros e detalhes | Prontos. Filtros e detalhes não dependem da 006 |
| Relatórios operacionais | Prontos |
| Sistema antigo | Não alterado, e sem sincronização com as planilhas |
| E-mails de conta, segurança, responsável e Demandas (07/11/2026) | Implementados na mesma fila, testados só com provedor falso. **Nenhum ativo**: dependem das migrações listadas em "Dependências no banco", de `NOTIFICATION_EMAILS_ENABLED=true` e de validação real |
| Cota diária, reserva da recuperação, agrupamento, revalidação no envio e validade (08/11/2026) | Implementados e testados só com provedor falso. O controle da cota depende da migração **019**, ainda não aplicada em nenhum banco remoto |

## Dependências no banco

Conferidas nos cabeçalhos de cada arquivo em `backend/database/schema/`. Aplique sempre na ordem numérica.

| Migração | Para os e-mails | Depende de | Sem ela |
|---|---|---|---|
| 003 `user_access` | Perfil, equipe SLM e permissões efetivas: decide quem é destinatário (aprovação, administração, responsável) e é conferida de novo no envio | — | O código lê as colunas antigas, e ninguém integra a equipe SLM |
| 006 `integrations` | Fila (`email_deliveries`), eventos, tentativas e notificações | 005 | Nenhuma comunicação é gravada; a ação principal segue normal |
| 007 `operations_center` | `system_settings`: liga e desliga os e-mails de segurança (Parâmetros > Notificações) | 005, 006 | Valem os padrões do código |
| 014 `demands` | Controle de Demandas e o valor `demands` em `integration_events.module` | 005, 006, 007 | Avisos de Demandas não são gerados |
| 015 `organizational_structure` | `user_directorate_links`: diretoria da DA, que define quem recebe os avisos de Demandas | 014 | Os avisos de Demandas falham e ficam só no log |
| 019 `email_quota` | Contador diário (`email_daily_usage`), agrupamento (`email_deliveries.grouped_count` e índice `idx_email_deliveries_grouping`) e **selagem** da fila anterior à proteção | 006, 013 | Com limite configurado, a fila não envia; a recuperação de senha segue sem contagem; os avisos administrativos saem um a um |

**Comentário desatualizado na 014 (B6):** o comentário de `demand_notification_preferences` em `014_demands.sql` ainda diz que a preferência de e-mail "ainda não dispara envio". Desde 07/11/2026 ela dispara, pela fila central. O arquivo **não foi alterado**, de propósito: a 014 já está aplicada na homologação, e mudar o arquivo criaria divergência com o que foi aplicado. Esta nota é a correção.

## Como funciona

```
Ação na solicitação ── mesma transação ──> evento, fila de e-mails, notificações, agenda
                                                    │
                       worker, fora da requisição <─┘
                          └─ Resend (ou simulado)
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

Cada comunicação fica registrada como "Não enviado: serviço não configurado", e o worker não as toca. **Ligar o serviço depois não dispara as mensagens acumuladas**: só as novas saem sozinhas. As antigas só saem por reprocessamento autorizado, item a item, e só enquanto estiverem na validade (abaixo).

### Cota diária, reserva da recuperação e agrupamento (A1)

A recuperação de senha e a fila de notificações usam a mesma conta do Resend. Sem controle, avisos em massa (cadastros em série, bloqueios de acesso) poderiam esgotar o dia e impedir a entrega dos códigos de recuperação.

| Variável | Valor | Efeito |
|---|---|---|
| `EMAIL_DAILY_LIMIT` | Inteiro. **O limite contratado no Resend, ou menor**, conferido no painel do Resend. O sistema não presume nenhum valor | Total de mensagens por dia (UTC), somando todos os canais |
| `EMAIL_RECOVERY_DAILY_RESERVE` | Inteiro. Padrão: 20% do limite, no mínimo 1 | Parte que a fila de notificações nunca usa |
| `EMAIL_ADMIN_GROUP_MINUTES` | Inteiro. Padrão: 30. `0` desliga | Janela de agrupamento dos avisos administrativos |

- **Quem consome:** a fila de notificações, as mensagens manuais da Central de comunicação e o envio de teste de modelo usam a parte das notificações (limite menos a reserva). A recuperação de senha usa a reserva e o que as notificações deixaram livre, até o total.
- **Contagem:** cada destinatário conta como uma mensagem (destinatário, outros destinatários e cópias). Uma mensagem reservada conta mesmo que o envio falhe depois, porque o provedor pode tê-la registrado.
- **Persistência e concorrência:** o consumo fica em `public.email_daily_usage` (migração 019), uma linha por dia em UTC. A data é calculada uma única vez por reserva e enviada às duas instruções, para que a virada da meia-noite não recuse uma reserva por engano. Cada reserva é um `UPDATE` condicional sobre a linha do dia: o PostgreSQL trava a linha e reavalia o limite, então reinícios do Render e workers simultâneos não zeram nem ultrapassam a contagem.
- **Cota esgotada:** a mensagem volta à fila como "Na fila", com o código `DAILY_LIMIT_REACHED`, **sem gastar tentativa**, e espera o início do dia seguinte (UTC). As demais reservadas no mesmo ciclo voltam junto, exceto as que têm algum endereço fora da lista de destinatários permitidos: essas recebem o bloqueio definitivo, como receberiam se a cota não tivesse acabado (o resultado não depende da ordem do lote nem de quantos workers rodam ao mesmo tempo). Se ela passar da validade enquanto espera, expira. Na recuperação, o código não é enviado, é invalidado, e a falha fica na auditoria (`auth.password_recovery_email_failed`, código `DAILY_LIMIT_REACHED`). O teste de modelo responde 429.
- **Cota indeterminada:** com o provedor real e sem `EMAIL_DAILY_LIMIT`, a fila não envia (`QUOTA_NOT_CONFIGURED`). Com limite, mas sem a migração 019 ou sem leitura do contador, a fila também não envia (`QUOTA_UNAVAILABLE`), e tenta de novo em uma hora. A recuperação de senha envia nesses dois casos, sem contagem: com a fila parada, nada disputa a cota com ela, e ela é a função que esta regra protege.
- **Provedores falsos** (testes, modo simulado) não consomem cota, a menos que `EMAIL_DAILY_LIMIT` esteja definido.
- **Agrupamento:** "Novo cadastro aguardando análise" e "Alerta de bloqueio de acesso" (avisos à administração, que não identificam ninguém) somam na mensagem ainda não enviada da mesma pessoa, dentro da janela. Se a anterior acabou de sair, a próxima espera o fim da janela e reúne o que vier até lá. O texto passa a dizer quantos foram ("Foram recebidos 3 novos pedidos de cadastro..."). Uma trava consultiva (`pg_advisory_xact_lock`) impede que dois acontecimentos simultâneos criem duas mensagens. O aviso no sino continua um por acontecimento.
- A tela **Integrações > Situação** mostra o limite, a reserva e o consumo do dia.

### Lista de destinatários permitidos (testes reais na homologação)

| Variável | Valor | Efeito |
|---|---|---|
| `EMAIL_RECIPIENT_ALLOWLIST` | Endereços **exatos**, separados por vírgula | Só eles recebem e-mail real. `@dominio`, `*@dominio` e entradas sem parte local são recusadas e ignoradas (a tela e o `config:check` mostram quantas) |
| `EMAIL_RECIPIENT_RESTRICTION` | `test` (padrão; também quando ausente ou com valor desconhecido) ou `off` | Só `off` desliga a restrição |

- **Sem a lista, nada real sai** (fila, mensagens manuais, teste de modelo e recuperação de senha), enquanto a restrição estiver em `test`. É o estado seguro padrão, inclusive em produção, até a remoção controlada.
- **Toda a mensagem:** destinatário, outros destinatários e cópias. Qualquer endereço fora da lista bloqueia a mensagem inteira; nada sai pela metade.
- **Antes da cota:** a conferência acontece antes da reserva, então mensagem bloqueada não consome cota. O transporte do Resend e o envio da recuperação conferem de novo, como última barreira.
- **Registro:** a mensagem da fila (ou manual) fica como falha definitiva `RECIPIENT_OUTSIDE_TEST_LIST`, sem alerta à equipe. A auditoria (`email.recipient_blocked`) leva só o canal (`fila`, `mensagem_manual`, `teste_modelo`, `recuperacao_senha`), o modelo e os **domínios**, nunca o endereço. A recuperação bloqueada invalida o código, registra `auth.password_recovery_email_failed` com o mesmo código, e a resposta à pessoa continua igual.
- **Bloqueio definitivo:** `RECIPIENT_OUTSIDE_TEST_LIST` nunca é reprocessável, nem depois de mudar ou remover a lista. Os cadastros e destinatários definitivos não mudam: a conferência é só no envio.
- **Provedores falsos** e o modo simulado só são conferidos quando a lista está definida (para os testes automatizados).
- **Remoção controlada**, ao fim da homologação e com autorização: (1) conferir em Integrações > Situação que não há nada pendente indevido; (2) definir `EMAIL_RECIPIENT_RESTRICTION=off`; (3) remover `EMAIL_RECIPIENT_ALLOWLIST`; (4) conferir com `npm run config:check`. O que foi bloqueado durante os testes continua bloqueado.

### Selagem da fila anterior (migração 019)

Ao aplicar a 019, toda mensagem ainda "pendente" ou "não configurada" (fila e mensagens manuais) vira falha definitiva `BLOCKED_BEFORE_ACTIVATION`, com registro em `integration_attempts`. Ela foi gerada antes da cota, da validade e da lista de testes. Nada é apagado, e o reprocessamento desse código é sempre recusado, inclusive depois de remover a lista. Desfazer a 019 não desfaz a selagem. Na homologação, em 08/11/2026, eram 4 mensagens para `jucesp.sp.gov.br`.

### Revalidação no envio (M1)

Antes de enviar, o worker confere de novo se o aviso ainda faz sentido para aquele destinatário. A regra depende do evento, e não é "conta aprovada" para todos:

| Avisos | O que é conferido no envio |
|---|---|
| Cadastro recebido | A conta continua **pendente** e o endereço é o mesmo. Pendente recebe a confirmação, legitimamente |
| Cadastro aprovado, Conta ativada, Perfil alterado, Senha alterada, Novo acesso, Bloqueio, Sessões encerradas | A conta continua **aprovada** e com o mesmo endereço |
| Cadastro não aprovado | A conta continua **rejeitada** e com o mesmo endereço |
| Conta desativada | A conta continua **desativada** e com o mesmo endereço |
| Novo cadastro aguardando análise | O destinatário é conta aprovada com `users:approve`, e ainda há cadastro pendente |
| Alerta de bloqueio a administradores | O destinatário é conta aprovada com `users:manage` |
| Solicitação atribuída | O destinatário ainda é o responsável, com conta aprovada, `<módulo>:read` e `<módulo>:update` |
| Retirada de responsável | O destinatário **não** voltou a ser o responsável, e ainda atende o módulo |
| Prazo vencido | O destinatário ainda é o responsável, a solicitação está aberta e o prazo continua vencido |
| Controle de Demandas | Como antes: a demanda existe, e a pessoa ainda tem acesso, preferência de e-mail e o tipo não silenciado |

Quem não passa fica como falha definitiva, sem alerta à equipe e sem e-mail de falha, com um código para cada motivo:

| Código | Motivo |
|---|---|
| `NOTICE_OBSOLETE` | A situação mudou depois do aviso (conta decidida, responsável trocado, prazo reaberto, demanda rascunho excluída) |
| `RECIPIENT_ACCESS_REVOKED` | O destinatário perdeu o acesso: conta não aprovada, sem a permissão, fora do setor ou sem visibilidade da demanda |
| `RECIPIENT_ADDRESS_CHANGED` | O e-mail da conta mudou: o endereço antigo não recebe nada sobre ela |
| `RECIPIENT_PREFERENCE_DISABLED` | Demandas: a pessoa desligou o aviso por e-mail ou silenciou o tipo |
| `EXPIRED` | Passou da validade |
| `RECIPIENT_OUTSIDE_TEST_LIST` | Fora da lista de testes (definitivo) |
| `BLOCKED_BEFORE_ACTIVATION` | Selada pela 019 (definitivo) |

A tela de Integrações mostra o motivo em texto. Os demais avisos das solicitações (recebimento, agendamento etc.) seguem como antes.

O nome da pessoa (`{{nome_usuario}}`) é lido nessa conferência e entra **só** nos avisos à própria conta. Não fica gravado no evento.

### Validade e itens antigos

Cada mensagem tem validade, contada de quando entrou na fila. Vale para "Na fila" e para "Não enviado: serviço não configurado".

| Categoria | Validade |
|---|---|
| Segurança: novo acesso, bloqueio, alerta a administradores, sessões encerradas, senha alterada | 24 horas |
| Conta: cadastro, decisão, ativação, desativação, perfil | 7 dias |
| Responsável: atribuição, retirada, prazo vencido | 3 dias |
| Controle de Demandas | 3 dias |
| Demais avisos das solicitações | 30 dias |

- A cada ciclo, com ou sem serviço ativo, o worker marca como **expirado** o que passou do prazo: situação "Com falha", código `EXPIRED`, com registro em `integration_attempts`. Nada é apagado e nada é reenviado. O que chega ao envio já vencido também expira, sem alerta.
- Item expirado **não pode ser reprocessado** (409), nem o "não configurado" que já passou do prazo.
- **Antes de ativar o envio**, a tela Integrações > Situação mostra quantos estão "não configurados", quantos expiraram e a data do mais antigo. A lista de envios filtra por situação e por módulo, inclusive Controle de Demandas.
- `NOTIFICATION_PENDING_DAYS` não tem relação com a validade: define só os dias sem andamento para o lembrete à equipe.

## Fluxos de e-mail

Modelos padrão em `backend/src/integrations/catalog.ts`. Podem ser editados, pré-visualizados, testados e publicados em **Configurações > Modelos de e-mail**, com as permissões `email_templates:read`, `email_templates:edit` e `email_templates:publish`, com histórico de versões. As variáveis de cada evento são fechadas: nenhuma alcança CPF, passageiros ou, em Demandas, título e conteúdo.

| Módulo | Acontecimento | Solicitante | Equipe | Responsável |
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
| Manutenção, Frota, Passagens | Atribuição de responsável (também ao agendar com outro responsável) | | | Sim, com e-mail |
| Manutenção, Frota, Passagens | Retirada ou transferência: quem deixou de ser responsável | | | Sim, com e-mail |
| Manutenção, Frota, Passagens | Prazo vencido (worker, a cada hora) | | | Sim, com e-mail |

"Equipe" significa: notificação a quem tem as permissões do módulo e e-mail aos endereços configurados em `EMAIL_INTERNAL_TO_*`.

"Responsável": aviso na plataforma em todos os casos marcados. O **e-mail** ao responsável só sai na atribuição, na retirada e no prazo vencido, e só para conta **aprovada** que ainda tem `<módulo>:read` e `<módulo>:update`, conferidas na mesma transação. Quem agiu não recebe.

### Conta de acesso

Vão à pessoa dona da conta, no endereço lido pela própria transação (`accountEmail`). Assim a rejeição usa o endereço informado no pedido, sem passar pela busca de contas aprovadas. Não há notificação na plataforma, porque a conta pode estar pendente, rejeitada ou desativada. Nenhuma mensagem traz motivo interno, lista de permissões, senha, código ou link de recuperação.

| Acontecimento | Disparo | Destinatário | Link |
|---|---|---|---|
| Cadastro recebido | `createPendingUser`, cadastro novo ou reenviado após rejeição. O duplicado não gera nada | Quem pediu | Nenhum |
| Novo cadastro aguardando análise | O mesmo | Contas aprovadas com `users:approve` (e-mail e sino). Sem nome nem e-mail de quem pediu | `/cadastros-pendentes` |
| Cadastro aprovado, com o perfil | `decidePendingRegistration` | Quem pediu | `/` |
| Cadastro não aprovado | `decidePendingRegistration` | Endereço informado no pedido | Nenhum |
| Conta ativada / desativada | `setUserActive`, só quando a situação muda | Titular | `/` / nenhum |
| Perfil ou permissões alterados | `applyUserAccess`, se perfil, equipe SLM ou permissões mudarem | Titular, com o novo perfil se ele mudou | `/minha-conta` |
| Senha alterada | Fim da recuperação de senha (código ou link) | Titular | Nenhum |

### Segurança

Ligados ou desligados em **Parâmetros > Notificações > E-mails de segurança** (`notifications.securityEmails`). Sem IP, senha, código ou link.

| Acontecimento | Padrão | Destinatário |
|---|---|---|
| Novo acesso à conta | **Desligado**, para não virar ruído | Titular |
| Acesso bloqueado após tentativas sem sucesso | Ligado | Titular. Publicado sem a resposta do login esperar, para que o tempo não revele se a conta existe. Um por conta a cada janela de 15 minutos |
| Alerta aos administradores sobre conta bloqueada | Ligado | Contas aprovadas com `users:manage`. A conta não é identificada no e-mail; o registro fica na auditoria |
| Sessões encerradas pela administração | Ligado | Titular |

Falhas do próprio serviço de e-mail **não geram e-mail** (só o aviso na plataforma a quem tem `integrations:manage`), para não entrar em ciclo. Destinatário de Demandas que perdeu o acesso também não vira alerta de falha.

### Controle de Demandas

Os avisos (atribuição, responsável alterado, menção, comentário, prazo alterado, prazo próximo, atraso, situação, recorrência e providência) seguem no sino, como antes, e agora entram na mesma fila de e-mails, com o modelo `demand_<tipo>`. Recebe por e-mail só quem cumpre **todas** as condições (`demandEmailRecipients`, em `backend/src/demands/demandNotifications.ts`):

1. É destinatário do aviso e passa por `keepThoseWithAccess` (setor da demanda ou diretoria).
2. Tem conta aprovada com e-mail.
3. Marcou "receber também por e-mail" (`demand_notification_preferences.email`).
4. Não silenciou aquele tipo de aviso.
5. Enxerga a demanda pela mesma regra das listas (`visibleDemandSql`; `demandVisibleRecipients` e `withEmailPreference`). Em demanda **restrita**, só o chefe do setor, a diretoria e quem está nominalmente envolvido. O administrador que só consulta não recebe por ser administrador.

Em demanda restrita, o e-mail leva só o número, sem título, conteúdo ou anexos, e o evento na fila nem guarda o título. **No envio, o worker confere tudo de novo:** a demanda que ficou restrita perde o título; quem perdeu o acesso ou saiu do setor fica `RECIPIENT_ACCESS_REVOKED`; quem desligou o e-mail ou silenciou o tipo, `RECIPIENT_PREFERENCE_DISABLED`; demanda (rascunho) excluída, `NOTICE_OBSOLETE`. Nenhum vira alerta à equipe.

**Isolamento (M2):** o aviso no sino e o e-mail ficam em `SAVEPOINT`s separados (`notifyDemand` e `publishDemandEmails`). Se a preparação do e-mail falhar, só a fila daquele aviso é desfeita: o sino e a alteração da demanda permanecem. A falha vai para o log como `demand_notification_email_failed`, só com o tipo e o código do erro, sem título nem conteúdo. A chave única de evento e destinatário impede duplicidade se o aviso for publicado de novo.

### Recuperação de senha

Continua fora da fila, de propósito: o código e o link não podem ficar gravados no banco. O que mudou:

- E-mail do link com versão em HTML (link escapado), além do texto.
- Uma tentativa a mais em falha temporária (rede, 408, 429, 5xx), com a mesma chave de idempotência, para não entregar duas vezes. Recusa definitiva não é repetida.
- Sucesso e falha ficam na auditoria (`auth.password_recovery_email_sent` e `auth.password_recovery_email_failed`), só com canal, tentativas e código do erro. Na falha, o código enviado é invalidado.
- Continuam valendo o HMAC com `PASSWORD_RESET_PEPPER`, a validade de 10 minutos, o limite de tentativas e a mesma resposta para contas existentes e inexistentes.
- **Reserva diária:** a recuperação usa `EMAIL_RECOVERY_DAILY_RESERVE` e o que sobrou das notificações, nunca a fila. Sem capacidade no dia, nada é pedido ao provedor (veja "Cota diária").
- **Diferença em relação à fila:** a recuperação é enviada na hora, depois da resposta à pessoa, sem passar por `email_deliveries`, sem revalidação nem validade (o código vale 10 minutos), e não depende de `NOTIFICATION_EMAILS_ENABLED`: bastam `RESEND_API_KEY`, `RESEND_FROM` e `PASSWORD_RESET_PEPPER`.
- **Modelo editável: não.** Avaliado e recusado: um modelo editado poderia omitir o código, o link ou o prazo, ou levar o código a outro lugar do texto. O texto segue fixo no código.

### Teste de modelo

O envio de teste vai só ao e-mail da própria conta. Agora uma falha do provedor responde 502 com o código do erro e fica na auditoria (`config.email_test_failed`), sem o conteúdo. O teste consome a cota das notificações; sem capacidade, responde 429 e nada é enviado.

### Bloqueio de acesso (B1)

O aviso à pessoa titular distingue o limite atingido, sem revelar nada a quem tenta entrar (a resposta do login continua a mesma, exista a conta ou não):

- **Limite da conta** (tentativas de qualquer origem): "novas tentativas foram bloqueadas por alguns minutos".
- **Limite da conta a partir de um mesmo endereço de rede:** "novas tentativas desse endereço foram bloqueadas".
- **Só o limite do endereço** (compartilhado por toda a instituição): não diz nada sobre uma conta, e não gera aviso nem alerta.

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

A agenda é uma consulta sobre `service_requests`. Não existe segunda fonte de agendamentos nem calendário externo. Manutenção e Frota entram pelo agendamento da SLM. **Passagens aéreas** (desde 11/11/2026) entram pela viagem pedida: um compromisso na ida e outro na volta, na data e no horário do formulário (horário de Brasília), sem dados de passageiros. O filtro de situação usa os status de Manutenção e Frota; em Passagens, só "Cancelado" tem equivalente. Uma data impossível gravada por engano não aparece e não impede a agenda de carregar.

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

## Brevo, alternativa ao Resend (14/11/2026)

Para a homologação sem domínio próprio. O Brevo aceita um **remetente confirmado por link**, sem registros de DNS. Tudo o mais é igual ao Resend: fila, lista de destinatários permitidos, cota diária, recuperação de senha e mensagens manuais.

| Variável | Valor |
|---|---|
| `EMAIL_PROVIDER` | `brevo` (sem ela, vale o Resend) |
| `BREVO_API_KEY` | chave de API do Brevo (`xkeysib-...`) |
| `EMAIL_FROM` | `Nome <endereco@dominio>`, com o endereço confirmado no Brevo em **Senders** |

As demais (`NOTIFICATION_EMAILS_ENABLED`, `EMAIL_RECIPIENT_ALLOWLIST`, `EMAIL_DAILY_LIMIT`...) seguem as mesmas regras. Os códigos de falha passam a começar por `BREVO_` (por exemplo `BREVO_401`, chave recusada). Limite: como o domínio do remetente não é verificado, parte das mensagens pode cair no spam ou ser recusada pelo destino, conforme a política do domínio do remetente. Para produção, prefira o Resend com domínio verificado (ou o subdomínio institucional).

## Microsoft 365, envio pela caixa institucional (14/11/2026)

O e-mail sai da própria caixa do SLM (`EMAIL_FROM`, por exemplo `slm@jucesp.sp.gov.br`), pelo Microsoft Graph (`sendMail`), e fica em **Itens Enviados**. Não depende de serviço externo nem de DNS, e as mensagens não caem no lixo eletrônico da JUCESP por remetente não autenticado.

| Variável | Valor |
|---|---|
| `EMAIL_PROVIDER` | `microsoft` |
| `EMAIL_FROM` | `SLM JUCESP <slm@jucesp.sp.gov.br>`, a caixa liberada para o aplicativo |
| `GRAPH_TENANT_ID` | ID do locatário (ou o domínio) |
| `GRAPH_CLIENT_ID` | ID do aplicativo |
| `GRAPH_CLIENT_SECRET` | segredo do aplicativo, **ou** `GRAPH_CERTIFICATE_PRIVATE_KEY` e `GRAPH_CERTIFICATE_THUMBPRINT` |

O que a TI faz no Microsoft 365: (1) registra um aplicativo no Entra ID; (2) concede a permissão de aplicativo **Mail.Send** do Microsoft Graph, com consentimento do administrador; (3) restringe o aplicativo à caixa do SLM no Exchange Online (política de acesso de aplicativo ou RBAC para aplicativos), para que ele não envie em nome de outras caixas; (4) entrega os três valores, que vão direto no Render. O mesmo aplicativo pode servir também aos anexos no SharePoint (`docs/ARMAZENAMENTO_SHAREPOINT.md`), com as permissões de cada um.

Mesmas regras dos demais provedores: lista de destinatários permitidos, cota diária e recuperação de senha. Códigos de falha começam por `MICROSOFT_` (`MICROSOFT_401`: aplicativo recusado; `MICROSOFT_403`: caixa não liberada para o aplicativo; `MICROSOFT_413`: anexos acima do limite do pedido, cerca de 3 MB no total). O Exchange Online também tem limites próprios de envio por caixa e por minuto.

## O que a TI precisa fornecer

| Item | Variável | Sem isso |
|---|---|---|
| Migração 006 aplicada | | Solicitações funcionam, mas sem comunicações. Telas de notificações e integrações respondem que falta a atualização |
| Ligar o worker, se não for produção | `INTEGRATIONS_WORKER_ENABLED=true` | Filas não são processadas |
| Domínio verificado e chave do Resend | `RESEND_API_KEY`, `RESEND_FROM` | Nenhum envio |
| Autorização expressa de envio | `NOTIFICATION_EMAILS_ENABLED=true` | Nenhum envio, mesmo com a chave do Resend |
| Endereço público | `APP_PUBLIC_URL`, com https | Mensagens sem link |
| Destinatários internos, se houver | `EMAIL_INTERNAL_TO_MAINTENANCE`, `_FLEET`, `_FLIGHTS`, `_WAREHOUSE`, `_SYSTEM` | Equipe avisada só pela plataforma. Conta, segurança, responsável e Demandas não usam essas listas: vão às contas |
| Migrações 003, 006, 007, 014 e 015 aplicadas, na ordem | | Veja "Dependências no banco" |
| Migração 019 aplicada | | Com limite configurado, a fila não envia |
| Limite diário de e-mails | `EMAIL_DAILY_LIMIT`, conferido no painel do Resend | A fila não envia pelo Resend |
| Reserva da recuperação, se diferente de 20% | `EMAIL_RECOVERY_DAILY_RESERVE` | 20% do limite |
| Janela de agrupamento, se diferente de 30 minutos | `EMAIL_ADMIN_GROUP_MINUTES` | 30 minutos |
| Lista de destinatários de teste (homologação) | `EMAIL_RECIPIENT_ALLOWLIST`, endereços exatos | Nenhum e-mail real sai, nem a recuperação |
| Remoção da restrição, só depois da homologação | `EMAIL_RECIPIENT_RESTRICTION=off`, com autorização | A restrição continua valendo |
| Cópias, se autorizadas | `EMAIL_CC_MAINTENANCE`, `_FLEET`, `_FLIGHTS`, `_WAREHOUSE` | Sem cópias |
| Prazo de lembrete, se desejado | Parâmetros, na tela, ou `NOTIFICATION_PENDING_DAYS` | Sem lembretes |

**Validação antes de declarar ativo:** em ambiente de homologação, com caixas de e-mail de teste, criar, reagendar e cancelar uma solicitação; conferir a entrega; forçar uma falha e reprocessar.

O transporte simulado (`EMAIL_TRANSPORT=simulated`) é recusado em produção. Variáveis `GOOGLE_CALENDAR_*` que sobrarem no painel são ignoradas, e o `npm run config:check` avisa que podem ser apagadas. A tela de Integrações mostra "Não configurado", "Simulado" ou "Configurado", e esta última só significa que os valores existem.

## Compatibilidade com o sistema antigo

**O código e as planilhas do sistema antigo não estão no repositório, em nenhum branch.** Os fluxos abaixo foram construídos a partir do supercomando e dos requisitos, e **a paridade com o antigo não foi verificada**.

| Rotina | Situação no novo | Validar com a área |
|---|---|---|
| Confirmação, agendamento, reagendamento, cancelamento | Modernizada: fila, tentativas e histórico | Textos, remetentes e destinatários |
| Histórico | Modernizado: imutável | Campos que o antigo registrava |
| Calendários | Só agenda interna (Google Calendar removido em 11/11/2026) | Se o antigo usa calendários do Google, eles deixam de receber os agendamentos do novo |
| Dashboard | Dados reais do novo sistema | Indicadores do antigo |
| Execução de frota | Com ocorrências e atrasos | Campos, sobretudo veículos e motoristas |

O sistema antigo não foi alterado. Enquanto os dois funcionarem, uma solicitação registrada em um não aparece no outro.

## Testes

| Comando | Cobre |
|---|---|
| `npm run test:backend` | Redação, modelos, modos de configuração e Resend com cliente falso |
| `npm run test:integration` | Fila, duplicidade, concorrência, falhas, reprocessamento, conflitos, notificações, relatórios, migração e reversão, em PostgreSQL descartável |
| `npm run test:e2e` | Avisos, conflitos, agenda, notificações e administração no navegador, com transportes simulados e bloqueio de rede |

Os resultados estão em `PLANO_DESENVOLVIMENTO_INTEGRAL.md`.
