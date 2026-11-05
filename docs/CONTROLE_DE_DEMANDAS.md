# Controle de Demandas

Gestão das atividades administrativas dos setores da Diretoria Administrativa. Tela em `/demandas`, API em `/api/demands`, tabelas nas migrações `014_demands.sql` e `015_organizational_structure.sql`.

**As migrações 014 e 015 não foram aplicadas no banco real, nem as anteriores: todas as anteriores estão pendentes, e a 014 depende delas.** Sem elas, em produção o módulo fica oculto no menu, `/demands/context` responde `migrated: false`, as demais rotas respondem 503 e o restante do sistema segue igual.

## Antes de usar

1. Aplicar as migrações pendentes. Veja `BACKUP_E_MIGRACOES_SUPABASE.md`.
2. Em **Configurações → Controle de Demandas**, cadastrar os setores. Nenhum setor vem pronto; as 10 categorias iniciais são editáveis.
3. Definir os vínculos de cada pessoa: em **Cadastros pendentes → Definir vínculos**, ao aprovar, ou em **Usuários**, depois. Os diretores também podem ser definidos em Configurações.
4. Definir `ATTACHMENTS_DIR`, se ainda não estiver definida. Sem ela, o envio de anexos responde 503, e o resto funciona.
5. Confirmar `DEMANDS_WORKER_ENABLED`: em produção o worker liga sozinho; fora dela, exige `true`.

## Estrutura organizacional

Os vínculos são independentes e cumulativos. Participar de um setor não muda a lotação.

| Vínculo | Onde fica | Como se define |
|---|---|---|
| Lotação original | `auth_users.sector` | Aprovação ou Dados cadastrais. Não dá acesso ao módulo |
| Setor de atuação | `demand_sector_members`, com papel e função | Aprovação, Usuários ou Configurações |
| Diretor da DA | `user_directorate_links`, papel `diretor`, ou permissão `demands:directorate` | Aprovação, Usuários ou Configurações, só por administrador |

Retirar um vínculo é lógico. As ações anteriores e o histórico das demandas não mudam. Cada alteração fica na auditoria, com quem fez, quando e o que mudou, e aparece no histórico da pessoa em Usuários.

## Matriz de permissões

As regras ficam em `backend/src/demands/demandPolicy.ts`. `visibleDemandSql` é o filtro das listas, do painel, dos relatórios e da agenda, e `resolveDemandAccess` decide em cada demanda. As duas precisam dizer o mesmo. Existem somente estes quatro perfis, e o que não está autorizado é negado.

| | Servidor do setor | Chefe do setor | Diretor da DA | Administrador do sistema |
|---|---|---|---|---|
| **Como se identifica** | Integra o setor, papel `colaborador` | Integra o setor, papel `responsavel` | Papel `diretor` ou permissão `demands:directorate` | Perfil da conta `administrator` |
| **Vê** | Demandas do próprio setor | Todas do próprio setor | Todas de todos os setores | Todas de todos os setores |
| **Histórico, anexos, prazos, responsáveis** | Consulta | Consulta | Consulta | Consulta |
| **Cadastra** | Para o próprio setor | Para o próprio setor | Para qualquer setor | Não |
| **Edita dados, prazo, responsável, status** | Do próprio setor | Do próprio setor | Todas | Não |
| **Comentários, etapas, anexos, vínculos** | Do próprio setor | Do próprio setor | Todas | Não |
| **Transfere para outro setor** | Não | Não | Sim | Não |
| **Compromissos na agenda** | Não | Do setor que chefia | Todos | Não |
| **Relatórios e indicadores** | Não | Do próprio setor | Todos | Todos |
| **Acompanhar (receber avisos)** | Sim | Sim | Sim | Não |
| **Configura setores, integrantes e categorias** | Não | Não | Sim | Sim (permissão `demands:configure`) |
| **Define diretores** | Não | Não | Não | Sim |

**Acúmulo:** Servidor + Chefe tem os poderes de Chefe no setor que chefia, e só nele. Servidor + Diretor e Administrador + Diretor valem como Diretor. **Administrador sem o perfil de Diretor fica somente com a consulta, mesmo que também integre ou chefie um setor.**

**Setor da demanda:** a demanda é do setor responsável, do setor solicitante e dos setores colaboradores. Quem integra qualquer um deles a vê e a edita, Servidor ou Chefe. Só o Diretor a transfere para outro setor. Assim, somente o Administrador sem perfil de Diretor vê sem poder alterar.

**Equipe SLM e lotação não dão acesso ao módulo.** Os papéis `integrante` e `consulta` da DA e as colunas `pode_cadastrar`, `ver_setor` e `e_slm` continuam no banco e não têm efeito. Nada disso dá poder sobre usuários ou configurações gerais, que seguem nas permissões `users:*` e `settings:*`. O administrador segue configurando setores, vínculos e categorias: isso é da plataforma, e não um registro operacional. O Diretor também configura setores, integrantes e categorias, mas definir diretores é só do administrador.

O acesso é conferido no banco a cada requisição. Por isso as rotas constam como `session` em `routeAccessMap.ts`, e sem nenhum vínculo respondem 403. Demanda fora do alcance responde 404, igual a uma inexistente; demanda visível sem a capacidade exigida responde 403.

Só pode ser indicado como colaborador, autorizado ou mencionado quem integra um setor da demanda ou é Diretor. Os avisos só chegam a quem consegue abrir a demanda.

**Demanda restrita:** Chefe do setor, Diretor e Administrador veem todas. O Servidor do setor só a vê se estiver nominalmente envolvido (criou, é solicitante, responsável, colaborador, responsável por etapa ou autorizado). Abrir uma restrita ou baixar seu anexo só pelo acesso de administrador fica na auditoria (`demand.admin_access`). A notificação de uma demanda restrita traz o número, e nunca o título.

**Rascunho:** é trabalho ainda não cadastrado, e só quem criou vê e altera, inclusive anexos. Exige apenas o título, e o restante é conferido ao publicar. Descartar é exclusão lógica; demandas publicadas são canceladas, nunca excluídas. 

**Auditoria:** toda alteração feita por uma pessoa entra em `demand_history` e em `auth_audit_events` (`demand.changed`), na mesma transação, com usuário, data, horário, número da demanda, o que mudou e, quando há, os valores de/para. Em campos de texto livre, como título e observações, a auditoria guarda o nome do campo, e não o conteúdo. Criar e cancelar compromissos da agenda também entra na auditoria. Se a auditoria falhar, a alteração é desfeita.

**Identificação na demanda:** setor solicitante (`setor_origem_id`), quem cadastrou (`criado_por`), responsável pela execução, setor responsável, diretor do acompanhamento (opcional) e histórico.

## Ver o módulo em desenvolvimento

```bash
npm run demo:demandas
```

Sobe API, tela e PostgreSQL descartáveis (portas 3910, 5910 e 55910), com setores, contas dos quatro perfis e demandas demonstrativas: atrasadas, recorrentes, pendentes, concluídas, restritas e compartilhadas. O comando mostra o endereço, as contas e a senha, nova a cada execução. Nada toca o banco real, e Ctrl+C apaga tudo.

Os dados demonstrativos existem só nesse script, fora do servidor e das migrações, e nunca chegam à produção.

Na tela de desenvolvimento comum (porta 5173), o item do menu aparece mesmo sem as migrações, com um aviso apontando para esse comando. No build de produção, o item continua dependendo de a pessoa ter um perfil no módulo.

## Atalho e pesquisa

Na aba Inicial, **Criar demanda** abre `/demandas/nova` em um clique, para quem pode cadastrar. O formulário oferece só os setores autorizados, também ao continuar um rascunho. O Administrador sem perfil de Diretor não cadastra e não vê o atalho. Em desenvolvimento, sem as migrações, o atalho aparece como o item do menu e leva ao aviso do módulo.

Nas listas, a pesquisa traz número/protocolo, título e descrição, setor e status à vista. **Mais filtros** abre solicitante, responsável, data de cadastro, prazo, recorrente, atrasadas e os demais, com um contador do que está valendo. **Limpar filtros** volta à lista original, inclusive a ordenação e os filtros vindos de um link do painel. No quadro, só as demandas que a pessoa pode editar têm controle de mover. A API combina os filtros (`number`, `text`, `requester`, `sectorId`, `responsibleId`, `status`, `from`, `to`, `dueFrom`, `dueTo`, `overdue`, `recurring`) sempre depois da visibilidade do perfil, então nenhum filtro alcança outro setor.

## Recorrência

Regras puras em `backend/src/demands/recurrence.ts`, geração em `database/demandSeriesRepository.ts` e `demands/worker.ts`.

- **Cada data gera uma demanda independente**, com número, prazo, responsável, status, comentários, anexos e histórico próprios.
- **Dia inexistente vira o último dia do mês:** dia 31 cai em 30/04 e em 28/02 ou 29/02. Dias 30 e 31 viram uma só data em fevereiro. Anual em 29/02 cai em 28/02 nos anos comuns.
- **"Quinzenalmente" é a cada 15 dias.** Para cada 2 semanas no mesmo dia da semana, use Personalizado. Para dias fixos, como 5 e 20, use Mensalmente com os dois dias.
- **Criação:** a primeira ocorrência é a primeira data da regra a partir de hoje, ou da data inicial. Datas passadas não são geradas ao criar.
- **Antecedência:** "gerar quantos dias antes" cria a demanda antes do prazo; sem isso, ela nasce no próprio dia do prazo.
- **Sem duplicidade:** `FOR UPDATE SKIP LOCKED` na série, chave única em `demand_series_occurrences (series_id, data_prevista)` e índice único em `demands (series_id, data_ocorrencia)`. Rodar de novo, em paralelo ou depois de reiniciar não duplica.
- **Depois de uma queda do servidor,** as datas perdidas são geradas em ordem, até 60 por série a cada ciclo.
- **Suspender e retomar:** retoma a partir de hoje, e as datas do período suspenso não são geradas depois.
- **Pular:** data futura nunca vira demanda; ocorrência já gerada fica cancelada, com o motivo. Datas puladas contam na quantidade pedida.
- **Cancelar:** nada é apagado. Opcionalmente, cancela também as futuras já geradas e não iniciadas.
- **Editar:** "somente esta" marca a ocorrência como editada; "esta e as futuras" altera as ocorrências abertas seguintes e o modelo das próximas, sem mudar o prazo individual de cada uma.
- **Responsável que saiu do setor:** as novas ocorrências nascem sem responsável, e os responsáveis pelo setor são avisados.
- **A agenda mostra as datas futuras como previsão,** calculada na leitura, e essas datas ainda não são demandas.

## Notificações

Usam `user_notifications`: aparecem no sino e em Notificações. A chave do acontecimento evita repetição: um aviso por prazo, e um por conversa a cada dez minutos para quem acompanha. Alterar o prazo gera novo aviso. A pessoa escolhe os lembretes e silencia tipos de aviso em **Preferências**, e o lembrete da demanda prevalece sobre o da pessoa.

**O envio por e-mail não está implementado.** A preferência fica gravada, e a tela informa isso. Para ligar, é preciso criar os modelos no catálogo de `integrations/catalog.ts`, aceitar o módulo `demands` nele e obter a liberação de `NOTIFICATION_EMAILS_ENABLED`. Os alertas de prazo são conferidos a cada hora; a geração de ocorrências, a cada 5 minutos.

## Anexos

Mesmas validações e mesmo armazenamento dos demais módulos: conteúdo real conferido, sem macros, sem PDF com script e sem endereço público. Tabela própria (`demand_attachments`), que entra na conta da capacidade total. **A validação não substitui um antivírus**, que depende da infraestrutura aprovada pela TI.

## Agenda

Prazos, inícios previstos, etapas, previsão das recorrências, reuniões, entregas e atividades programadas, em dia, semana e mês, nas visões individual, por setor e consolidada. Complementa as agendas de Manutenção e Frota, sem substituí-las. **Não há integração com o Google Calendar neste módulo:** a tabela de eventos é própria, e a integração pode ser acrescentada sem mudar a agenda interna.

## Integração com outros módulos

O vínculo guarda o módulo, o identificador e o protocolo. Nunca altera o registro de origem. Só vincula quem consegue abrir o registro, pelas regras daquele módulo, e quem não tem acesso ao módulo vê só o protocolo, sem link. Os vínculos aparecem na demanda, e não na tela da solicitação original: os fluxos existentes não foram modificados. Demandas também não entram na pesquisa global do topo; a pesquisa do módulo fica nas listas.

## Relatórios

Para Chefe, Diretor e Administrador, sempre dentro do que a pessoa pode ver. PDF pelo gerador já existente, e Excel `.xlsx` real, gerado em `reports/xlsxDocument.ts`, sem dependência nova. A exportação fica na auditoria. O relatório informa que os indicadores não são instrumento de avaliação individual.

## Testes

```bash
npm run test:backend       # Regras de recorrência, permissões e planilha
npm run test:integration   # Fluxos pela API real, em PostgreSQL descartável
E2E_ONLY=demands,demand-permissions npm run test:e2e   # Fluxos e matriz dos quatro perfis no navegador
```
