# Plano de desenvolvimento integral

Referência central dos supercomandos. Os requisitos ficam em `REQUISITOS_FUNCIONAIS.md`; o funcionamento de cada área, em `INTEGRACAO_MODULOS.md`.

## Estado inicial (03/11/2026, antes do Supercomando 01)

- **Branch:** `integracao/cadastro-e-permissoes`, último commit `cb1e4bd`.
- **Alterações não commitadas preservadas:** 20 arquivos de permissões, migração 003 e testes, além de `003_user_access.rollback.sql` e `tmp-backup-perfis/`, não rastreados. São o trabalho da correção da D4 e não foram revertidos.
- **Linha de base dos testes, antes de qualquer alteração:** `npm run verify` passou; `npm run test:integration` teve 81 de 81; `npm run test:e2e` passou.
- **Servidores:** nada escutava nas portas 3000 e 5173 durante a análise.
- **Banco real:** não consultado. Migrações 002, 003 e 004 seguem não aplicadas segundo a documentação existente.
- **Módulo de execução de frota:** não existe em nenhum branch do repositório. Foi desenvolvido neste supercomando.
- **Sistema antigo (Google Sheets e Apps Script):** não está no repositório. Seus fluxos não puderam ser conferidos.

## Arquitetura

- **Frontend:** React, TypeScript e Vite. Chamadas em `frontend/src/api/modulesApi.ts`; listas compartilhadas em `app/useCatalog.ts`.
- **Backend:** Express e `pg`, sem as APIs do Supabase.
- **Camadas:** rotas (`routes/`), regras puras (`requests/workflow.ts`, `requests/validation.ts`, `auth/requestPolicy.ts`) e persistência (`database/*Repository.ts`).
- **Gravação:** cada operação é uma transação com bloqueio da linha, histórico e auditoria. Se a auditoria falhar, nada é gravado.
- **Acesso:** toda rota é classificada em `routeAccessMap.ts`, e os testes percorrem o mapa contra a API real.

## Situação das funcionalidades

**Concluída** significa: fluxo pela tela, API, persistência, permissões, validação, erros, histórico e testes em banco descartável. Nada foi executado no banco real.

| Área | Situação | Observação |
|---|---|---|
| Manutenção | Concluída | |
| Frota, com execução, ocorrências e atrasos | Concluída | Veículo é texto livre; ver questão 5 |
| Passagens aéreas | Concluída | Exige `PASSENGER_DATA_KEY` |
| Configurações: listas | Concluída | |
| Configurações: editor de campos | Concluída | No servidor desde a revisão dos supercomandos; exige a migração 007 para gravar |
| Almoxarifado: pedidos, catálogo, entrega e conferência | Concluída | Não movimenta estoque; ver questão 3 |
| Agenda interna | Concluída | Filtros, detalhes e conflitos no Supercomando 03 |
| Notificações internas | Concluída | Depende da migração 006 |
| Fila, modelos e histórico de e-mails | Concluída | Depende da migração 006. Testada com provedor simulado |
| Envio real de e-mails | **Não ativo** | Conector pronto, nunca usado com o Resend real |
| Google Calendar | **Não ativo** | Conector pronto, nunca usado com o Google real |
| Avisos de privacidade | **Parcial** | Prontos. Falta validação institucional do texto |
| Início, Dashboard e relatórios | Concluída | |
| Auditoria | Concluída | Recusas por permissão nas rotas dos módulos não são auditadas; só as de CPF |
| Sessões, encerramento administrativo e limites de login | Concluída | Limites guardados em memória, por processo |
| Recuperação de senha por link | **Parcial** | Código pronto e testado sem envio real; ver pendências |
| Cadastro com e-mail institucional | **Parcial** | Regra pronta; falta a lista de domínios |

## Decisões técnicas do Supercomando 01

1. **Status antigos:** a migração 005 acrescenta os status institucionais sem reescrever registros. Valores antigos são traduzidos na leitura.
2. **CPF:** cifrado pela aplicação com AES-256-GCM, com a chave fora do banco. Sem chave, a API responde 503 e nada é gravado. A migração 004 guardaria texto puro e nunca foi aplicada; ela não foi alterada, e a 005 ajusta a tabela.
3. **Agenda:** é uma consulta sobre `service_requests`. Não existe cópia a sincronizar.
4. **Nomes copiados:** setor, andar, tipo e material são gravados por identificador e por nome, para que renomear ou desativar não mude o histórico.
5. **Histórico e auditoria:** um gatilho de banco recusa alteração e exclusão, além de a API não oferecer essas rotas.
6. **Almoxarifado:** reutiliza `materials`, `material_requests` e `material_request_items`. Foram acrescentados os status "Atendido parcialmente" e "Entregue", porque o módulo exige quantidades atendidas e registro de entrega.
7. **Link de recuperação:** com `APP_PUBLIC_URL`, o e-mail leva um link de uso único com o prazo já aprovado de 10 minutos. Sem ela, continua o código de seis dígitos.
8. **Cancelamento em Passagens:** mantém "Cancelada", que já existia na tela do projeto, além das quatro etapas.
9. **Tipo de viagem:** "Somente volta" foi acrescentado, e "Somente ida", que já existia, foi mantido.

## Questões em aberto

Dependem de decisão da instituição. O sistema segue o comportamento indicado até lá.

1. **Administrador pode agendar sem ser da SLM?** O requisito diz que só integrantes autorizados da SLM agendam. A implementação corrigida da D4, preservada aqui, permite ao Administrador agendar pelo perfil, mesmo fora da equipe. Não há registro escrito da D4 no repositório para confirmar.
2. **Solicitante pode cancelar a própria solicitação?** Hoje não: o perfil não tem `requests:cancel`.
3. **Quem controla o estoque oficial?** A entrega não altera `estoque_atual`. Se o JUCESP tiver de controlar saldo, será preciso ativar `stock_movements` e definir o saldo inicial.
4. **Cancelar um atendimento em andamento é permitido?** Hoje é, com motivo obrigatório, para o atendimento não ficar sem desfecho.
5. **Fluxos do sistema antigo:** falta acesso às planilhas para conferir campos, sobretudo cadastro de veículos e de motoristas, criados sem essa conferência.
6. **Solicitante acompanha pedidos do próprio setor?** Hoje só os dele. Solicitação aberta pela SLM em nome de um setor não aparece para as pessoas desse setor.
7. **Quem deve operar o Almoxarifado?** `warehouse:manage` é do Administrador e, para os demais, só por concessão individual.
8. **Conflito de agenda deve bloquear?** Hoje avisa e permite confirmar, porque não há regra de disponibilidade nos requisitos.
9. **Como registrar uma rejeição em Passagens?** O fluxo não tem esse status. Hoje, é um cancelamento com motivo.
10. **Prazo do lembrete de pendências:** sem valor definido, não há lembretes.
11. **Quem escreve nos calendários durante a transição?** Se o sistema antigo e o novo usarem os mesmos, haverá compromissos paralelos.

## Pendências de infraestrutura e institucionais

| Item | Necessário | Efeito até lá |
|---|---|---|
| Migrações 002 a 005 no banco real | Autorização, backup e aplicação em ordem | Módulos respondem 503 e não gravam |
| `PASSENGER_DATA_KEY` | Gerar e guardar fora do banco | Passagens não aceita passageiros |
| Procedimento de troca da chave | Desenvolver | Trocar a chave tornaria CPFs ilegíveis |
| Serviço de e-mail e `PASSWORD_RESET_PEPPER` | Credenciais autorizadas | Recuperação de senha não envia nada |
| `APP_PUBLIC_URL` | Endereço público definitivo | Recuperação segue por código |
| `INSTITUTIONAL_EMAIL_DOMAINS` | Lista oficial de domínios | Qualquer domínio pode pedir cadastro, sempre com aprovação |
| Setores do cadastro público | Decidir se a tela pública pode listar setores | O setor segue digitado no cadastro de usuário |
| Retenção da auditoria | Definir prazo e procedimento | Nada é apagado |
| Revisão de segurança institucional e LGPD | Área responsável | Não realizada. Lista em `PRIVACIDADE_E_TRATAMENTO_DE_DADOS.md` |
| Migração 006 no banco real | Autorização e backup | Solicitações funcionam, sem comunicações |
| Worker, Resend e autorização de envio | Ver `INTEGRACOES_E_AUTOMACOES.md` | Comunicações ficam registradas, sem envio |
| Conta de serviço e calendários do Google | Ver `INTEGRACOES_E_AUTOMACOES.md` | Sem sincronização. Agenda interna funciona |
| Acesso ao sistema antigo | Planilhas e Apps Script | Paridade dos fluxos não verificada |
| Migrações 007 a 010 no banco real | Autorização e backup | Funções novas respondem 503; protocolo segue o número antigo |
| Armazenamento de anexos (`ATTACHMENTS_DIR` ou serviço aprovado) e antivírus | Decisão da TI | Anexos indisponíveis |
| Agendador, local e retenção das cópias | Decisão da TI | Backup só manual |
| Teste de restauração de uma cópia real | Autorização | Só comprovado com dados fictícios |
| Alerta externo de indisponibilidade | Decisão da TI | Queda total só é vista depois |
| Múltiplas instâncias da API | Limites de login compartilhados | Com mais de uma instância, o limite vale por processo |

## Riscos

- **Depois da 005, a tela de desenvolvimento grava no banco real.** Veja `AMBIENTES.md`.
- **Perda da chave** torna os CPFs irrecuperáveis.
- **Índices únicos da 005** podem interromper a migração se já houver nomes duplicados em `setores` ou `materials`. O banco real não foi consultado, e a interrupção não altera dados.
- **Gatilho de auditoria:** rotinas externas que apaguem eventos passarão a falhar.

## Testes

| Comando | Resultado ao fim do Supercomando 01 |
|---|---|
| `npm run test:backend` | 174 de 174 |
| `npm run test:integration` | 102 de 102, em PostgreSQL descartável |
| `npm run test:e2e` | Todos os cenários, em portas e banco próprios, sem conexão para fora da máquina |
| TypeScript, ESLint e builds | Sem erros |

Os números acima são do fim do Supercomando 01; os do Supercomando 02 estão no relatório dele. `npm run test:e2e` agora inclui `e2e/visual-review.e2e.cjs`. Para guardar capturas de tela, defina `E2E_SCREENSHOT_DIR`.

Testes existentes alterados, por necessidade: `routeInventory.test.ts`, porque módulos antes sem API agora exigem sessão, e `userManagementIntegration.test.ts`, que passa a aplicar a 005 e a atribuir perfil elegível às permissões restritas.

## Supercomando 02: modernização visual

**Estado inicial:** interface com `App.css` de 4.624 linhas em camadas, ícones feitos de caracteres de texto, sem biblioteca de ícones, azul como destaque e Almoxarifado aberto em página separada. Os testes da etapa anterior passavam.

**O que mudou:** identidade preto e amarelo, ícones Phosphor, componentes compartilhados, Início e Dashboard separados, Almoxarifado dentro do layout com abas e endereços próprios, filtros suspensos, Auditoria e Configurações reorganizadas, gaveta de navegação em tablets e celulares. Padrões em `IDENTIDADE_VISUAL.md`.

**Decisões:**

- O card "Precisa de ajuda?" foi retirado: não tinha ação nem contato.
- `/portal/almoxarifado` redireciona para `/almoxarifado/nova`, para não quebrar endereços salvos.
- Confirmações do navegador viraram janela do sistema (`useConfirm`).
- O único ajuste no backend é o acréscimo de `byPeriod` em `GET /dashboard/summary`, com teste. Banco, permissões e regras não mudaram.

**Pendências:**

- `App.css`, `modules.css` e `WarehousePortalPage.css` têm regras sem uso; `styles/theme.css` as sobrepõe. Foram mantidos porque remover exige revisão tela a tela, e o último nem é mais importado.
- ~~O filtro por tipo de viagem em Passagens depende de um filtro novo na API.~~ Criado na revisão dos supercomandos.
- A revisão automática cobre contraste de texto, nomes acessíveis, alvos, foco e rolagem lateral. Falta teste com leitor de tela e por pessoas usuárias.
- A fonte Inter vem do Google Fonts; sem acesso externo, o navegador usa Arial.

## Supercomando 03: integrações e rotinas institucionais

**Estado inicial (04/11/2026):** branch `integracao/cadastro-e-permissoes`, último commit `cb1e4bd`, 105 arquivos alterados sem commit, preservados. Nada escutava nas portas 3000 e 5173. Linha de base: `npm run verify` passou; integração, 102 de 102; `npm run test:e2e` passou. O Resend só era usado na recuperação de senha. Não havia fila, notificações, avisos de privacidade nem conector de calendário. A agenda tinha visualização por dia, semana e mês e filtro por módulo.

**O que foi feito:** migração 006; eventos publicados na mesma transação das mudanças; fila de e-mails com tentativas, idempotência e reprocessamento; conectores do Resend e do Google Calendar; notificações internas; avisos de privacidade; filtros, detalhes e conflitos na agenda; relatórios operacionais; tela de Integrações. Detalhes em `INTEGRACOES_E_AUTOMACOES.md` e `PRIVACIDADE_E_TRATAMENTO_DE_DADOS.md`.

**Decisões:**

- **Aviso não é consentimento:** deixou de bloquear o envio em Passagens, e o Almoxarifado deixou de gravar um aceite que nunca foi pedido.
- **Ligar o envio exige autorização própria** (`NOTIFICATION_EMAILS_ENABLED`), porque a chave do Resend pode existir só para a recuperação de senha.
- **Comunicações acumuladas não são disparadas** quando o serviço é ligado.
- **Modelos no código,** sem edição pela tela.
- **Google sem biblioteca nova,** com `fetch` e `node:crypto`.
- **Novas permissões:** `integrations:read` e `integrations:manage`. O Administrador as recebe pelo perfil.

**Defeito anterior corrigido:** um pedido em "Atendido parcialmente" nunca chegava a "Atendido", porque as quantidades totais eram recusadas nesse status. `replaceItems` agora aceita completar o atendimento.

**Testes existentes alterados, por necessidade:**

- `operationalRules.test.ts` e `operationalModulesIntegration.test.ts`: enviar sem `lgpdAceite` agora é aceito.
- `userManagementIntegration.test.ts`: aplica a 006, para o mapa de rotas alcançar as rotas novas.
- `e2e/operational-modules.e2e.cjs`: clicar em um compromisso abre os detalhes, com o link para a solicitação.
- `e2e/visual-review.e2e.cjs`: inclui as duas telas novas.

**Resultados ao fim do Supercomando 03:**

| Comando | Resultado |
|---|---|
| `npm run test:backend` | 206 de 206 |
| `npm run test:integration` | 129 de 129, em PostgreSQL descartável |
| `npm run test:e2e` | Todos os cenários, com 24 telas revisadas em cada um dos 3 tamanhos, sem conexão para fora da máquina |
| TypeScript, ESLint e builds | Sem erros |
| `npm run audit:all` | Nenhuma vulnerabilidade |

Nada foi executado no banco real, e nenhum provedor real foi chamado.

**Riscos:**

- **Provedores reais nunca foram exercitados.** O conector do Google foi escrito pela documentação pública da API e testado contra um servidor falso. Espere ajustes na homologação.
- **Falha ao publicar um evento é só registrada em log:** a solicitação é preservada, e aquela comunicação não existe.
- **Depois da 006, cada ação no ambiente de desenvolvimento registra comunicações no banco real.**
- **O título no calendário externo vem de texto livre.**
- **Gatilho da 005:** recusa alterações, mas com mensagem técnica. Ver `INTEGRACOES_E_AUTOMACOES.md`.

## Supercomando 04: Central de Operações e inteligência administrativa

**Estado inicial (04/11/2026):** branch `integracao/cadastro-e-permissoes`, último commit `cb1e4bd`, 121 arquivos alterados sem commit, preservados. Nada escutava nas portas 3000 e 5173. Linha de base: `npm run test:backend`, 206 de 206; `npm run test:integration`, 129 de 129.

| Fase | Entrega | Situação |
|---|---|---|
| 1 | Protocolo único, Central da SLM, linha do tempo, notificações pendentes | Concluída; falta aplicar a 007 |
| 2 | Pesquisa global, responsáveis, justificativas, anexos | Concluída; anexos dependem de `ATTACHMENTS_DIR` |
| 3 | Indicadores, produtividade, alerta de prazo, veículos, equipamentos, cotações, estoque interno | Concluída; falta aplicar a 009 |
| 4 | Monitoramento, disponibilidade, verificação de backup, contingência, revisão de acessos, sessões | Código pronto; rotina de backup depende da TI |
| 5 | Parâmetros de prazos, notificações, anexos e expediente; modelos de e-mail | Concluída; ver limites abaixo |

**Decisões:**

- **Protocolo no banco:** um gatilho gera o código na inserção, com contador por módulo e ano. Assim nenhum caminho de gravação fica sem código. O número antigo continua no banco e na pesquisa.
- **Compatibilidade:** `protocolSql` lê o código novo ou, sem a 007, o número antigo. Código e migração podem ser publicados em qualquer ordem.
- **Central independente:** nem o Administrador a recebe pelo perfil. Exige equipe SLM e concessão individual, além de `requests:read_all`.
- **Justificativa:** sempre para prioridade, responsável já definido, prazo já definido, cancelamento e reagendamento. Para dados de atendimento, só depois de agendado ou em andamento, porque antes disso é correção de rotina.
- **Produtividade:** volume, complexidade e tempo aparecem lado a lado, sem nota nem classificação. A complexidade é informada pela equipe, e o que não foi classificado aparece como tal.
- **Disponibilidade:** intervalo sem verificação conta como "sem verificação", e não como disponível.
- **Prazo padrão:** começa vazio, para nenhuma data ser presumida. O período "sem movimentação" começa em 5 dias, valor de trabalho, ajustável pela tela.
- **Estoque interno:** usa `stock_movements`, que já existia. A entrega de pedidos continua sem alterar o saldo, como na questão 3.
- **Exportação sem biblioteca nova:** CSV que o Excel abre, e PDF pela impressão do navegador.

**Defeito anterior corrigido:** a mensagem técnica do gatilho `reject_history_change` (risco do Supercomando 03), na 007.

**Conflitos entre os supercomandos, para decisão:**

1. **Cor institucional.** O Supercomando 04 pede preservar o azul `#034EA2`; o 02 definiu preto e amarelo como identidade, com o azul só em links, foco e avisos. Foi mantida a identidade do 02, para não contradizê-lo, e as telas novas seguem `IDENTIDADE_VISUAL.md`.
2. **Pedidos de materiais.** O item 12.4 diz que o sistema não recebe solicitações de materiais, mas as abas "Nova solicitação" e "Solicitações" do Almoxarifado existem desde o Supercomando 01. Não foram removidas, porque o item 16 proíbe retirar funcionalidades. O estoque novo traz o aviso de que é controle interno.

**Limites conhecidos:**

- **Antivírus:** a validação confere o conteúdo real, recusa macros e PDFs com script, mas não substitui um antivírus. PDF com script dentro de objeto comprimido pode passar pela conferência de texto.
- **Upload em memória:** o arquivo é lido inteiro antes de gravar, até 100 MB. Com muitos envios simultâneos, o limite por arquivo deve ficar baixo. O padrão é 10 MB.
- **Editor de campos personalizados:** resolvido na revisão dos supercomandos. Ver abaixo.
- **Modelos de e-mail:** personalizam título e abertura. O corpo institucional, o protocolo e as proteções continuam no código. O assunto gravado na fila antes de uma mudança mostra o texto anterior na tela de Integrações, embora o envio use o atual.
- **Aviso de parada por notificação:** agora ajustável em Parâmetros; `NOTIFICATION_PENDING_DAYS` vale só sem valor na tela. Continua sem valor definido (questão 10). A Central mostra as paradas de qualquer forma.
- **Cotações, equipamentos e estoque** não têm ligação com companhias aéreas nem com o sistema governamental.
- **Monitoramento:** verifica só de dentro da API. Com o servidor inteiro fora do ar, ninguém avisa: o período aparece depois, como "sem verificação". Um alerta externo depende da TI.
- **Cálculos de prazo e tempo** usam horas corridas, sem calendário de expediente nem feriados.

**Testes existentes alterados, por necessidade:**

- `userManagementIntegration.test.ts`: aplica as novas migrações, para o mapa de rotas alcançar as rotas novas.
- `e2e/operational-modules.e2e.cjs`: o histórico agora fica na linha do tempo.
- `e2e/visual-review.e2e.cjs`: inclui as telas novas e exporta a verificação.

## Supercomando 05: previsão e controle de entrega

**O que foi feito:** migração 011; data prevista só com o dia, alteração com justificativa, histórico interno em `material_delivery_history`, comunicação única por mudança real, data efetiva e situação da entrega. Detalhes em `INTEGRACAO_MODULOS.md`.

**Decisões:**

- **Pedido digitado:** a pessoa pode não ter conta, então a equipe informa o e-mail institucional, opcional. A conta aprovada com esse e-mail vê só o acompanhamento. Sem conta, recebe só o e-mail. Muda o que o Supercomando 03 registrava ("não tem a quem avisar"), e o aviso de privacidade foi ajustado.
- **Situação da entrega:** calculada na leitura, para não divergir do pedido. Só o registro da entrega conclui.
- **Assunto da alteração:** o modelo só previa a primeira comunicação. A alteração usa "Alteração da previsão de entrega de materiais — [Protocolo]", sem a justificativa.

**Pendente:** as questões 12 e 13 abaixo e o envio real de e-mails.

## Revisão dos supercomandos 01 a 05

Conferência dos critérios contra o código, feita em 04/11/2026 a pedido da responsável pelo projeto. Lacunas fechadas sem depender de decisão:

| Origem | Entrega |
|---|---|
| 01 e 04, item 12.5 | Editor de campos no servidor, para todas as pessoas, com validação e campo obrigatório conferidos na API. A cópia antiga do navegador pode ser enviada ao servidor e não é apagada |
| 02, item 7 | Filtro por tipo de viagem em Passagens, pela API |
| 04, item 9 | Aviso de solicitações paradas ajustável em Parâmetros |
| 04, item 12.2 | Relatório de utilização e quilometragem por veículo |
| 04, item 12.4 | Relatório de entradas e saídas do estoque interno |
| 04, item 5 | Comunicações na tela do pedido de materiais, só para a equipe |
| 05, item 7 | Categoria da previsão de entrega nos parâmetros de notificação por perfil |
| 05, item 6 | Teste de navegador da visão restrita do pedido digitado |

**Decisão técnica:** os formulários usam a seção `forms` de `system_settings`, e não `request_forms`. Essa seção já tem permissão, validação e auditoria, grava o formulário de uma vez e não exige migração nova. `request_forms` não guarda descrição nem campo protegido, e seus tipos não correspondem um a um aos do editor. A tabela continua sem uso.

**Teste existente alterado, por necessidade:** o passo de entrega em `e2e/operational-modules.e2e.cjs`, porque o formulário ganhou campos.

**Limite:** os campos próprios de cada formulário continuam definidos no código da tela. A API confere os obrigatórios criados no editor, os fixos de cada módulo e, desde a publicação do formulário, também o campo fixo opcional marcado como obrigatório (`missingStandardField`, em `backend/src/requests/formRules.ts`; teste "sala ficou obrigatória" em `transparencyIntegration.test.ts`). A exceção é o campo fixo com regra condicional de exibição, que continua conferido só na tela. *(Atualizado em 06/11/2026: a frase anterior dizia que essa obrigatoriedade "só vale na tela", o que deixou de ser verdade e gerou o achado P-13.)*

**Questões novas, além das 11 acima, a alinhar com a responsável:**

12. **Quem edita a previsão de entrega?** O Supercomando 05 diz "integrantes autorizados da SLM", mas a regra atual é `warehouse:manage`, que o Administrador tem pelo perfil, mesmo fora da SLM.
13. **O que o solicitante vê no pedido interno?** O Supercomando 05 restringe dados internos, mas a tela antiga mostra quem registrou, atendeu e entregou, além dos comentários do histórico.
14. **Azul institucional.** Ver o conflito 1 do Supercomando 04: hoje `#034EA2` fica em links, foco e avisos.
15. **Contas fictícias do incidente de 03/11/2026 no banco real.** Falta autorização para conferir, somente com leitura, se continuam lá. A questão 1, sobre o Administrador agendar, também segue aberta.

## Próximos blocos

- **Aplicação das migrações 002 a 018 no banco real**, com autorização e backup, seguindo `BACKUP_E_MIGRACOES_SUPABASE.md`.
- **Validação das integrações:** homologação com credenciais institucionais, conforme `INTEGRACOES_E_AUTOMACOES.md`.
- **Fora dos supercomandos, sem data:** resolver as questões em aberto.
