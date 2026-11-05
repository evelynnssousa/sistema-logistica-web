# Portal do Motorista

Interface própria para os motoristas consultarem as viagens atribuídas e registrarem a execução. Tela em `/motorista`, API em `/api/driver`, cadastro em **Frota → Motoristas**, tabelas na migração `016_driver_portal.sql`.

**As migrações 016 e 017 não foram aplicadas no banco real.** Sem elas, a Frota segue igual, o perfil Motorista não pode ser definido e o cadastro de motoristas responde 503.

## Antes de usar

1. Aplicar as migrações pendentes. Veja `BACKUP_E_MIGRACOES_SUPABASE.md`.
2. Definir o perfil **Motorista** da conta: ao aprovar o cadastro ou em **Usuários**, só por administrador.
3. Em **Frota → Motoristas**, cadastrar o motorista e vincular a conta. Sem conta vinculada, ele não recebe viagens.
4. Definir `ATTACHMENTS_DIR`, se quiser anexos nas ocorrências. Sem ela, o campo de anexo não aparece.

## Como funciona

A viagem **é a solicitação de Frota** (`service_requests`, tipo `frota`). Não há cadastro paralelo: o portal lê e grava os mesmos status, `execucao_inicio`, `execucao_fim`, `request_history` e `request_occurrences` que a administração usa.

1. A solicitação é criada e agendada na Frota, como sempre.
2. Na solicitação agendada, quem agenda atribui o motorista, no painel **Execução da viagem**, com observações que ele verá.
3. O motorista inicia, registra ocorrências e finaliza pelo portal.
4. A equipe acompanha pelo painel, pela linha do tempo e pela coluna **Motorista** da lista.

O **responsável** da solicitação continua sendo quem coordena o atendimento; o **motorista** é quem executa.

## Viagens no portal

| Grupo | O que entra |
|---|---|
| Próximas | Agendadas ou reagendadas até 7 dias à frente, inclusive as atrasadas |
| Agendadas | Agendadas ou reagendadas para depois disso |
| Em andamento | Iniciadas e não finalizadas |
| Concluídas | Finalizadas |
| Canceladas | Canceladas, sem o motivo, que é interno |

O portal mostra data, horário, saída, destino, serviço, solicitante e setor, veículo, passageiros, observações escritas para o motorista e situação. Observações internas, e-mails, campos personalizados e motivo de cancelamento não saem da API.

## Início, término e correção

- Os horários são os do **servidor**. O que o navegador enviar é ignorado.
- Iniciar duas vezes, inclusive ao mesmo tempo, registra uma vez só: a segunda resposta é 409.
- O tempo efetivo sai do início e do fim registrados.
- O motorista não altera horários. Quem tem a permissão `fleet:execution_correct` corrige pelo painel, com motivo obrigatório. A correção guarda os valores anteriores em `fleet_execution_corrections`, que não aceita alteração nem exclusão, nem por SQL. O início original continua também na linha do tempo.

**Procedimento excepcional:** viagem sem motorista válido não inicia pelo portal. O registro excepcional é o já existente da Frota: a equipe com `requests:update` e `fleet:update` inicia e conclui na solicitação, com histórico e auditoria.

## Configurações do portal

Em **Configurações → Configurações do Portal do Motorista**, com a permissão `settings:manage`. Quem tem só `settings:read` consulta. Cada bloco tem Salvar e Cancelar, e a API valida tudo de novo. Padrões, validação e o que o motorista recebe ficam em `backend/src/requests/driverPortalRules.ts`.

Sem nada cadastrado, valem os padrões abaixo, que reproduzem o portal como ele já funcionava.

| Bloco | O que muda no portal | Padrão |
|---|---|---|
| Jornada: início e término | Identificação de viagem fora da jornada | 07:00 às 19:00 |
| Jornada: dias de funcionamento | Dia fora da lista conta como fora da jornada | Todos os dias, porque a regra anterior não distinguia dias |
| Jornada: intervalo e duração prevista | Viagem mais longa que a duração prevista somada ao intervalo fica identificada. Sem duração, não há esse limite | Sem intervalo e sem duração |
| Jornada: início ou término fora dela | Só identificar, ou exigir justificativa | Só identificar |
| Jornada: registros excepcionais | Desligado, o motorista não inicia fora da jornada | Ligado |
| Execução: obrigatórios ao iniciar e ao finalizar | Veículo (só se a viagem não tiver e só ao iniciar), hodômetro e observação | Nenhum |
| Execução: situações exibidas | Grupos do portal. **Próximas** e **Em andamento** ficam sempre. Cancelada oculta sai também do histórico | Todas |
| Execução: dias em Próximas | Separa Próximas de Agendadas | 7 |
| Tipos de ocorrência | Lista, justificativa, anexos e minutos de atraso | Os seis abaixo |
| Notificações | Quem recebe cada evento | Veja Notificações |
| Acesso | Portal, ocorrências, anexos, documentos e fotografias | Tudo ligado |
| Visualização: campos | No cartão, nos detalhes ou não exibir. O destino não pode ser ocultado | Saída, destino e observações no cartão, e o resto nos detalhes |
| Visualização: mensagens | Avisos, orientação e contato, se ativos | Nenhum |

**Histórico.** Toda alteração fica em `settings_change_history`, que não aceita alteração nem exclusão, com autor, data, valor anterior e novo, e aparece na própria tela. Fica também na auditoria (`settings_updated`).

**Limites que nenhuma configuração alcança.** A lista fechada de rotas, o filtro de viagens pelo motorista da sessão e a falta de permissões do perfil são código, e não parâmetros. Os campos configuráveis saem de uma lista fixa de dados já liberados ao motorista: nota interna, e-mail e motivo de cancelamento não têm entrada nela, e campo desconhecido enviado à API é descartado. Os limites gerais de anexos, em Parâmetros, continuam valendo. Finalizar nunca é impedido pela jornada, e registrar ocorrência também não.

**Portal desativado.** A API recusa viagens, início, término, ocorrências e histórico, sem novo login. O motorista vê o aviso, o contato e os avisos recebidos. A equipe continua iniciando e finalizando pela solicitação.

## Jornada

No horário de São Paulo, seja qual for o do servidor ou do aparelho. Viagem que começa ou termina fora da faixa ou dos dias, atravessa a noite, segue em andamento depois do fim da faixa ou passa da duração prevista fica identificada no portal, no painel e no histórico (`foraDaReferencia`). É diferente do expediente em Parâmetros, que vale para outras regras.

**Mudar a jornada não altera o passado.** Ao iniciar, a viagem guarda a jornada vigente em `service_requests.execucao_registro`, inclusive quando a equipe inicia pela solicitação. A identificação e o texto mostrado usam sempre essa cópia. Viagem sem cópia é anterior à migração 017 e usa as 07h às 19h, a regra da época. A regra de justificativa é a vigente no momento da ação, mas a faixa que define "fora" continua a do início.

## Ocorrências

Os tipos vêm do cadastro em `driver_occurrence_types`. Os iniciais são Atraso (com os minutos), Problema mecânico, Alteração de percurso, Impedimento de realização da viagem, Problema no local de destino e Outros. Data, horário e motorista são automáticos. Valem para viagem agendada, em andamento ou concluída.

Não há exclusão: desativar tira o tipo das próximas escolhas, e a chave estrangeira impede apagar um tipo usado, mesmo por SQL. Cada ocorrência guarda o nome do tipo na data do registro (`categoria_nome`), então editar a descrição não reescreve o que já foi registrado. Pelo menos um tipo fica ativo: para impedir novos registros, desligue as ocorrências em Acesso.

Vão para a equipe da Frota, com notificação, e não para o solicitante: nem a lista, nem a linha do tempo, nem o anexo, que é restrito. O motorista vê os nomes dos próprios anexos e não os baixa de novo pelo portal.

## Perfil e permissões

Perfil `driver`, com uma única permissão, `driver_portal:access`, e sem equipe SLM, concessões ou retiradas, o que o banco também impõe.

| Camada | O que impede |
|---|---|
| Tela | A conta entra direto no portal, e qualquer outro endereço volta para `/motorista` |
| Lista fechada na API (`requireAuthentication`, `driverPolicy.ts`) | Fora de `/driver`, `/auth` e `/notifications`, toda rota responde 403, inclusive as que só pedem sessão. Rota nova nasce bloqueada |
| Permissões | O perfil não tem nenhuma permissão de módulo. O cálculo ignora concessões gravadas no banco |
| Consultas | O motorista sai sempre da sessão, e toda consulta filtra por ele. Viagem de outro responde 404, igual a uma inexistente |
| Banco | `auth_user_access_driver_exclusive` recusa equipe SLM e concessões nessa conta |

| Ação | Exige |
|---|---|
| Usar o portal | Perfil Motorista, conta ativa e cadastro ativo vinculado |
| Cadastrar motorista e vincular conta | `fleet:manage` |
| Atribuir motorista | `requests:schedule` e `fleet:schedule`, os mesmos de agendar |
| Consultar a execução | `fleet:read` e `requests:read_all` |
| Corrigir horários | `fleet:execution_correct` |
| Definir o perfil Motorista | Administrador |

Mudar o perfil, desativar a conta ou desativar o cadastro vale na hora, sem novo login. Motorista com viagem em aberto não pode ser desativado nem desvinculado: é preciso reatribuir ou encerrar antes. Depois de iniciada, a viagem não muda de motorista.

## Auditoria

Na mesma transação da alteração: cadastro de motorista (`fleet.driver_changed`), atribuição (`fleet.trip_driver_assigned`), início, término e ocorrência (`request.*`, com `via: portal_motorista`) e correção (`fleet.execution_corrected`). Rota recusada à conta de motorista fica no log de segurança (`driver_route_denied`).

## Notificações

Pelos canais existentes: sino, tabela `user_notifications` e fila de e-mails, nas mesmas regras de envio. Eventos `trip_assigned`, `trip_rescheduled`, `trip_updated`, `trip_cancelled` e `trip_unassigned`, além de `trip_portal_notice` para a equipe, com os modelos editáveis no catálogo. O motorista lê na aba **Avisos** do portal.

| Regra em Configurações | Motorista (padrão) | Equipe (padrão) |
|---|---|---|
| Nova viagem atribuída | Sim | Não |
| Alteração de horário | Sim | Não |
| Alteração de destino | Sim | Não |
| Outras alterações na viagem | Sim | Não |
| Reagendamento | Sim | Não |
| Cancelamento | Sim | Não |
| Viagem retirada do motorista | Sim | Não |
| Registro de ocorrência | Não se aplica | Sim |
| Viagem iniciada | Não se aplica | Não |
| Viagem finalizada | Não se aplica | Não |

"Equipe" é quem tem `fleet:read`, `fleet:update` e `requests:read_all`, mais os e-mails internos configurados para a Frota, sem quem fez a ação. Desligar um aviso não apaga o registro na linha do tempo. Estas regras não mudam o que o solicitante recebe nem os avisos gerais da Frota, como o de cancelamento à equipe. Onde o motorista é quem registra, a célula dele não existe. Por isso, início ou término registrados pela equipe também não o avisam.

## Limitações

- **Sistema anterior:** o repositório não tem acesso a ele. A regra das 07h às 19h veio do pedido, e os demais fluxos não puderam ser comparados.
- **Jornada noturna:** o término precisa ser depois do início, no mesmo dia. Uma jornada como 22h às 6h não é aceita.
- **Duração prevista:** é conferida por viagem, e não pela soma do dia do motorista.
- **Edição simultânea:** duas pessoas no mesmo bloco: vale a última a salvar, e o histórico mostra as duas.
- **Cadastro mínimo:** nome, matrícula e conta. Sem CNH, CPF ou contato, por minimização. Se a Frota precisar controlar validade da CNH, é uma etapa à parte.
- **Vínculo com veículo:** a viagem segue com o veículo em texto, como já era. O hodômetro, se exigido, fica no registro da execução e não alimenta controle de quilometragem.
- **Sem funcionamento offline:** iniciar e finalizar exigem conexão no momento. O horário registrado é o da chegada ao servidor.
- **Reagendar não confere conflito do motorista:** a conferência acontece ao atribuir.
- **Senha:** a troca é pela recuperação de senha da tela de entrada, ou pelo administrador, como para as demais contas.

## Testes

```bash
npm run test:backend       # Regras do perfil e da jornada
npm run test:integration   # API real em PostgreSQL descartável (driverPortalIntegration.test.ts e driverPortalSettingsIntegration.test.ts)
E2E_ONLY=driver-portal,driver-portal-settings npm run test:e2e   # Navegador, inclusive celular
```

Com `E2E_ONLY` só nesses cenários, os passos rodam, mas a conferência final do banco descartável termina em erro, porque exige um cadastro feito por outro cenário. O resultado que vale é o de `npm run test:e2e` completo.
