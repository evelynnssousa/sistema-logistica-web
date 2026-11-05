# Matriz de conformidade

Auditoria de 05/11/2026, revisão `cb1e4bd` mais as alterações não registradas no Git. Fontes: textos originais dos Supercomandos, recuperados do histórico das sessões, e correções posteriores da responsável.

## Como ler

- **Consolidação:** cada linha reúne itens do mesmo parágrafo quando a mesma evidência cobre todos. A matriz não tem uma linha por marcador. Regras de processo, como "não fazer commit", não entram como requisito de produto.
- **Comportamento esperado:** é o texto do requisito. **Resultado do teste:** ✔ quando o teste citado passou nesta auditoria; — quando não há teste que comprove.
- **Evidência:** I = teste de integração; E = teste de navegador; U = unitário; C = leitura de código; D = documento; V = captura de tela vista. Os títulos citados, às vezes abreviados, são os dos testes em `e2e/` e `backend/src/`.
- **IMPLEMENTADO E VALIDADO significa:** passou em banco descartável, com e-mail e calendário simulados. Não significa funcionando no banco real nem aceite da área usuária.
- **Autoria dos testes:** foram escritos junto com o código. Por isso são evidência forte de comportamento, mas não uma verificação independente.
- **Marcados com \*:** Supercomandos 10 (Estrutura organizacional), 11 e 12, incluídos por constarem do título "01 a 13" e da lista de módulos. Não entram na contagem principal. O Supercomando 13 não foi localizado.

## Totais

| Classificação | 01 a 09 | 10 a 12 |
|---|---:|---:|
| IMPLEMENTADO E VALIDADO | 141 | 17 |
| IMPLEMENTADO PARCIALMENTE | 19 | 2 |
| IMPLEMENTADO, MAS NÃO VALIDADO | 4 | 0 |
| NÃO IMPLEMENTADO | 1 | 0 |
| IMPLEMENTADO COM ERRO | 0 | 0 |
| DIVERGENTE DA ORIENTAÇÃO | 4 | 1 |
| BLOQUEADO POR DEPENDÊNCIA | 12 | 0 |
| **Total** | **181** | **20** |

## Módulos e arquivos

| Sigla | Módulo | Arquivos principais |
|---|---|---|
| ACE | Usuários e acesso | backend/src/auth/, routes/auth.ts, routes/adminUsers.ts, database/userRepository.ts, frontend/src/pages/UsersPage.tsx |
| AGE | Agenda | pages/CalendarPage.tsx, database/serviceRequestRepository.ts |
| ALM | Almoxarifado | pages/WarehousePortalPage.tsx, WarehouseStock.tsx, WarehouseControl.tsx, routes/warehouse.ts, requests/deliveryRules.ts |
| ANX | Anexos | backend/src/attachments/, routes/attachments.ts, components/AttachmentsPanel.tsx |
| AUD | Auditoria e histórico | pages/AuditPage.tsx, database/authAuditRepository.ts, migração 005 |
| BKP | Backup | scripts/backup-database.cjs, scripts/verify-backup.cjs |
| BUS | Pesquisa | pages/SearchPage.tsx, database/searchRepository.ts |
| CFG | Configurações, modelos e formulários | pages/SettingsPage.tsx, components/ParametersSection.tsx, EmailTemplatesManager.tsx, FormManager.tsx, database/configRepository.ts |
| COM | Central de comunicação | components/CommunicationsPanel.tsx, routes/communications.ts, database/communicationRepository.ts |
| DB | Banco de dados | backend/database/schema/, scripts/apply-migrations.cjs |
| DEM | Controle de Demandas | frontend/src/pages/demands/, routes/demands.ts, backend/src/demands/, database/demandRepository.ts |
| DOC | Documentação | docs/ |
| DSH | Início e Dashboard | frontend/src/pages/HomePage.tsx, DashboardPage.tsx, database/insightsRepository.ts |
| FRO | Frota | pages/FleetPage.tsx, VehiclesPage.tsx, routes/requests.ts, routes/moduleExtensions.ts |
| GER | Sistema como um todo | todo o repositório |
| INT | E-mails e Google Calendar | backend/src/integrations/, pages/IntegrationsPage.tsx, database/integrationRepository.ts |
| LEG | Sistema antigo | docs/INTEGRACOES_E_AUTOMACOES.md |
| LGP | LGPD | components/PrivacyNotice.tsx, integrations/privacyNotices.ts, docs/PRIVACIDADE_E_TRATAMENTO_DE_DADOS.md |
| MAN | Manutenção | pages/MaintenancePage.tsx, RequestDetailPage.tsx, routes/requests.ts, requests/workflow.ts |
| MON | Monitoramento | backend/src/monitoring/, pages/MonitoringPage.tsx |
| NOT | Notificações | components/NotificationBell.tsx, pages/NotificationsPage.tsx |
| ORG | Estrutura organizacional | demands/demandPolicy.ts, database/institutionalLinkRepository.ts |
| PAS | Passagens | pages/AirTravelPage.tsx, requests/cpfProtection.ts, database/flightPassengerRepository.ts |
| POR | Portal do Motorista | pages/DriverPortalPage.tsx, routes/driver.ts, database/driverRepository.ts, requests/driverPortalRules.ts |
| REL | Relatórios | pages/ReportsPage.tsx, backend/src/reports/ |
| REQ | Solicitações: regras comuns | requests/, components/RequestTimeline.tsx, ReturnPanel.tsx, DuplicateWarning.tsx, FormNotices.tsx |
| SLM | Central SLM | pages/SlmCentralPage.tsx, database/operationsRepository.ts |
| VIS | Identidade e usabilidade | frontend/src/styles/theme.css, App.css, components/ui/, components/layout/ |

## Supercomando 01

Resumo: 29 implementado e validado, 3 implementado parcialmente, 1 divergente da orientação, 3 bloqueado por dependência.

| § | Requisito | Mód. | Evidência e teste | Teste | Classificação | Pendência |
|---|---|---|---|:-:|---|---|
| 4 | SLM independente da lotação; só integrante autorizado abre em nome de outro setor | ACE | I "em nome de outro setor: dentro e fora da SLM"; I "quem é do CPC e não está na SLM" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 4 | Somente integrantes autorizados da SLM realizam agendamentos | ACE | I "agendar: administrador sem SLM pode" | ✔ | DIVERGENTE DA ORIENTAÇÃO | P-08: Administrador fora da SLM agenda pelo perfil |
| 4 | Administrador não recebe automaticamente permissões restritas | ACE | I "abrir em nome... mesmo para administrador"; E "a Central não aparece... nem por ser administrador" | ✔ | IMPLEMENTADO E VALIDADO | Exceção: agendamento (P-08) |
| 4 | Solicitante não integra a SLM | ACE | I "só Administrador e Operador SLM integram a equipe, na API e no banco" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 4 | CPF completo só para SLM elegível com concessão individual; admin fora da SLM não recebe; demais mascarado | PAS | I "CPF: com e sem concessão"; I "sem flights:cpf:read"; E "CPF mascarado para todos" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 4 | Consulta de CPF protegida no backend e auditada | PAS | I "com flights:cpf:read, consulta... com auditoria"; I "se a auditoria falhar, o CPF não é devolvido" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 4 | Saída da SLM, mudança de perfil ou desativação revogam; retorno não restaura | ACE | I "sair da SLM revoga"; I "rebaixar um administrador revoga"; I "desativar revoga" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 4 | Administrador não altera o próprio acesso | ACE | I "ninguém altera o próprio acesso"; E "a própria conta não oferece alteração" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 5 | Cadastro de usuários com aprovação administrativa | ACE | I "cadastro fica pendente"; E "cadastro fica pendente até a aprovação" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 5 | Cadastro com e-mail institucional | ACE | C institutionalEmail.ts: sem INSTITUTIONAL_EMAIL_DOMAINS aceita qualquer domínio | — | BLOQUEADO POR DEPENDÊNCIA | P-09: falta a lista oficial de domínios |
| 5 | Ativação, desativação, perfis e permissões individuais | ACE | I "permissões individuais somam e retiram"; I "um administrador pode desativar outro" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 5 | Recuperação de senha por link temporário | ACE | I "recuperação por link: uso único, prazo"; envio real não testado | ✔ | BLOQUEADO POR DEPENDÊNCIA | P-05: faltam RESEND_API_KEY, RESEND_FROM, PASSWORD_RESET_PEPPER, APP_PUBLIC_URL |
| 5 | Controle e encerramento de sessões | ACE | I "sessões: consultar, sair dos outros"; E "encerrar as outras sessões" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 5 | Proteção contra login abusivo | ACE | I "após o limite, nem a senha correta entra" | ✔ | IMPLEMENTADO PARCIALMENTE | Limitador em memória, vale para uma instância (P-22) |
| 5 | Auditoria de ações administrativas; último administrador protegido | ACE | I "o último administrador não pode ser removido"; I "dois administradores rebaixando" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 6.1 | Dashboard e início com dados reais, por período e permissão | DSH | E "Dashboard é separado... usa dados reais"; I "painel e relatórios: dados reais" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 6.2 | Manutenção: cadastro, solicitante, setor, andar, tipo padronizado | MAN | E "solicitante abre manutenção com seletores do servidor" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 6.2 | Manutenção: agendar, reagendar, cancelar, iniciar, concluir, histórico, responsáveis | MAN | E "operadora agenda, reagenda, inicia e conclui"; I "manutenção: fluxo completo" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 6.2 | Status institucionais preservados, sem transição indevida | MAN | C workflow.ts; I "registros de status antigo aparecem traduzidos" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 6.3 | Frota: solicitação, origem/destino, passageiros, agenda, execução real, ocorrências, histórico | FRO | E "frota: solicitação, execução e registro de atraso"; I "frota: solicitação, execução real" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 6.3 | Preservar fluxos e informações do sistema antigo | LEG | D INTEGRACOES: código e planilhas antigos não estão no repositório | — | BLOQUEADO POR DEPENDÊNCIA | P-06: paridade não verificável |
| 6.4 | Passagens: formulário, até 10 passageiros, ida e volta, somente volta, bagagem | PAS | I "limite de dez passageiros, somente volta" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 6.4 | Passagens: status preservados e dados pessoais protegidos | PAS | I "CPF cifrado no banco, mascarado na API"; I "sem a chave, nenhum passageiro é gravado" | ✔ | IMPLEMENTADO E VALIDADO | No banco real falta PASSENGER_DATA_KEY (P-04) |
| 6.5 | Configurações: setores, andares, tipos; incluir, editar, desativar, reativar, duplicidade, permissão | CFG | I "configurações: permissão, duplicidade..."; E "administradora cadastra as listas" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 6.5 | Desativação não altera histórico | CFG | I "desativar ou renomear uma opção não muda os registros antigos" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 6.6 | Almoxarifado: origens JUCESP e governamental em central única, referência externa | ALM | E "catálogo, pedido interno, pedido externo e entrega"; I "pedido interno, pedido externo, central" | ✔ | IMPLEMENTADO E VALIDADO | Conflito com SC04-07 (P-07) |
| 6.6 | Consulta, edição local, itens, quantidades, situação, entrega, histórico, responsável, filtros, relatórios | ALM | I "almoxarifado: pedido interno..."; I "relatórios: quilometragem e consumo"; edição de item só no código | ✔ | IMPLEMENTADO PARCIALMENTE | Edição de itens sem teste específico localizado |
| 6.6 | Editar pedido externo não altera o governamental; não afirmar integração | ALM | C não há integração; I "pedido externo não tem a quem avisar" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 6.6 | Catálogo, unidade, ativos e inativos | ALM | E "catálogo"; I "categoria desativada some" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 6.6 | Conferência de inventário: governamental, contada, diferença, situação, histórico | ALM | E "conferência de inventário calcula a diferença"; I "conferência de inventário: quantidades" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 6.7 | Agenda usa os mesmos registros de Manutenção e Frota | AGE | I "agenda: usa os agendamentos dos módulos" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 6.8 | Auditoria de login, cadastros, perfis, permissões, CPF, solicitações, agenda, config., Almoxarifado, status | AUD | I "histórico e auditoria não podem ser alterados"; C ações auditadas listadas | ✔ | IMPLEMENTADO E VALIDADO | — |
| 6.8 | Usuários comuns não alteram auditoria | AUD | I "histórico e auditoria..."; I "consulta de auditoria exige audit:read" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 7 | Migrações documentadas, testadas e com reversão | DB | Ensaio 16 aplicadas e revertidas, 0 diferença de estrutura; 002 e 004 sem arquivo de reversão (DROP documentado) | ✔ | IMPLEMENTADO E VALIDADO | — |
| 7 | Dados sensíveis protegidos, integridade referencial, transações | DB | I "CPF cifrado"; C FKs e withTransaction | ✔ | IMPLEMENTADO E VALIDADO | Sequências e privilégios (P-02, P-03) |
| 9 | Fluxo real, sem dados fictícios como reais | GER | C sem mock em produção; ensaio em banco descartável | — | IMPLEMENTADO PARCIALMENTE | Só validado em banco descartável; banco real sem migrações (P-01) |

## Supercomando 02

Resumo: 10 implementado e validado, 4 implementado parcialmente, 1 implementado, mas não validado.

| § | Requisito | Mód. | Evidência e teste | Teste | Classificação | Pendência |
|---|---|---|---|:-:|---|---|
| 3 | Paleta: preto, #FBB900, branco, grafite; azul sem dominar | VIS | V capturas revisadas; theme.css | — | IMPLEMENTADO PARCIALMENTE | --jucesp-blue vira #0862c9 em 40 usos; roxo legado (P-18) |
| 3 | Sidebar preta; item ativo amarelo com ícone preto; botões amarelos; nome claro | VIS | V computador-inicio; celular-menu | — | IMPLEMENTADO E VALIDADO | — |
| 4 | Ícones preenchidos e duotone, biblioteca única, sem emoji | VIS | C @phosphor-icons/react, ui/Icon; V capturas; busca sem emoji | — | IMPLEMENTADO E VALIDADO | — |
| 4 | Ilustrações para estados vazios, quando fizer sentido | VIS | Capturas sem ilustração; requisito era opcional | — | IMPLEMENTADO, MAS NÃO VALIDADO | Não avaliado em todas as telas |
| 5 | Navegação moderna, responsiva, sem títulos e avisos removidos | VIS | Busca sem "GESTÃO OPERACIONAL", "Versão inicial"; E "as telas não têm rolagem lateral" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 6 | Início limpa, sem aviso, acesso rápido útil | DSH | V computador-inicio; E "atalho da aba Inicial" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 6 | Aba Dashboard distinta, com gráficos e estado vazio reais | DSH | E "Dashboard é separado"; V computador-dashboard | ✔ | IMPLEMENTADO E VALIDADO | — |
| 7 | Filtros suspensos em Passagens, limpar e atualizar | PAS | E "os filtros suspensos atualizam a lista e podem ser limpos" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 8 | Almoxarifado com navegação consistente e todas as áreas modernizadas | ALM | V computador-almoxarifado; e2e visual | ✔ | IMPLEMENTADO E VALIDADO | — |
| 9 | Auditoria modernizada: filtros, detalhes, paginação, sem edição | AUD | I "auditoria: filtros por ação"; C Pagination; E "painel, relatórios e auditoria" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 10 | Configurações em grupos claros, refletindo o backend | CFG | V computador-configuracoes: página de 10.853 px | — | IMPLEMENTADO PARCIALMENTE | Tudo em uma rolagem só (P-19) |
| 11 | Padrões reutilizáveis de campos, tabelas, modais, alertas | VIS | C components/ui | — | IMPLEMENTADO PARCIALMENTE | App.css legado de 4.624 linhas convive com theme.css (P-18) |
| 12 | Desktop, tablet, celular sem rolagem lateral; contraste e alvos | VIS | E visual-review em 3 tamanhos | ✔ | IMPLEMENTADO E VALIDADO | Verificação automática |
| 12 | Teclado, foco, rótulos | VIS | E "acessibilidade: atalho... foco visível"; visual-review | ✔ | IMPLEMENTADO PARCIALMENTE | Sem teste com leitor de tela (P-21) |
| 13 | Preservação funcional | GER | Suíte completa | ✔ | IMPLEMENTADO E VALIDADO | — |

## Supercomando 03

Resumo: 13 implementado e validado, 5 bloqueado por dependência.

| § | Requisito | Mód. | Evidência e teste | Teste | Classificação | Pendência |
|---|---|---|---|:-:|---|---|
| 3 | Avisos de privacidade antes do envio, sem aceite | LGP | E "os formulários apresentam o aviso de privacidade" | ✔ | IMPLEMENTADO E VALIDADO | Texto pendente de validação institucional |
| 3 | Sem inventar base legal; retenção e descarte por política aprovada | LGP | D PRIVACIDADE | — | BLOQUEADO POR DEPENDÊNCIA | P-16: base legal e retenção dependem da instituição |
| 3 | CPF e dados pessoais fora de e-mails e notificações | LGP | I "passagens: fluxo, sem CPF, nomes ou trechos"; I "passagem: ... sem CPF" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 3 | Documentação dos dados coletados | LGP | D PRIVACIDADE_E_TRATAMENTO_DE_DADOS.md | — | IMPLEMENTADO E VALIDADO | — |
| 4.1-4 | E-mails por fluxo em Manutenção, Frota, Passagens e Almoxarifado | INT | I "manutenção: comunicações..."; I "passagens: fluxo"; I "almoxarifado: fluxo interno"; simulados | ✔ | BLOQUEADO POR DEPENDÊNCIA | P-05: envio real nunca testado |
| 4.5 | Modelos, destinatários, cópias, histórico, falhas, reenvio, duplicidade | INT | I "destinatários internos e cópias vêm só da configuração"; I "falha definitiva" | ✔ | IMPLEMENTADO E VALIDADO | Com transporte simulado |
| 4.5 | Situação de entrega do provedor | INT | I "situação de entrega: consultada só quando o provedor informa" | ✔ | BLOQUEADO POR DEPENDÊNCIA | P-05 |
| 5 | Falha de e-mail não impede registro; fila, idempotência, tentativas | INT | I "recebimento: uma falha..."; I "dois processos..."; I "as tentativas têm limite" | ✔ | IMPLEMENTADO E VALIDADO | Worker só liga em produção ou por variável (P-11) |
| 6 | Agenda diária, semanal, mensal; filtros; responsáveis; detalhes | AGE | E "agenda: filtros, detalhes, reagendamento"; I "agenda: filtros por status" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 6 | Conflitos e alterações simultâneas no backend | AGE | I "conflitos: mesmo responsável ou veículo"; I "alteração simultânea" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 7 | Google Calendar: criar, atualizar, cancelar, duplicidade, falhas, reprocesso | INT | I "google simulado"; I "calendário: falha definitiva" | ✔ | BLOQUEADO POR DEPENDÊNCIA | P-05: faltam conta de serviço e calendários; nada real testado |
| 7 | Agenda interna funciona sem o Google | AGE | I "a agenda segue sem o provedor" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 8 | Notificações internas com permissão, link, leitura, sem duplicar, celular | NOT | E "a equipe é notificada, e o sino leva"; I "notificações: permissões"; E "celular: notificações" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 9 | Histórico padronizado e imutável | AUD | I "registros históricos: eventos... não mudam" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 10 | Relatórios por módulo, período, setor, status, com limitação informada e exportação | REL | I "relatórios: indicadores reais, com a limitação"; E "relatórios mostram os indicadores" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 11 | Consistência entre módulos | GER | Suíte E2E e integração | ✔ | IMPLEMENTADO E VALIDADO | — |
| 12 | Sistema antigo preservado, sem sincronização | LEG | C não há acesso nem sincronização | — | IMPLEMENTADO E VALIDADO | — |
| 12 | Rotinas antigas documentadas e validadas | LEG | D INTEGRACOES: "a paridade não foi verificada" | — | BLOQUEADO POR DEPENDÊNCIA | P-06 |

## Supercomando 04

Resumo: 24 implementado e validado, 6 implementado parcialmente, 1 implementado, mas não validado, 1 divergente da orientação, 1 bloqueado por dependência.

| § | Requisito | Mód. | Evidência e teste | Teste | Classificação | Pendência |
|---|---|---|---|:-:|---|---|
| 2 | Central exclusiva da SLM por concessão validada no backend | SLM | E "a Central não aparece"; I "Central: só com concessão individual" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 2 | Filas: atendimento, agendamento, hoje, atrasadas, aprovações, sem responsável, andamento, concluídas, canceladas | SLM | C filas em SlmCentralPage; I "indicadores coincidem com as listas" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 2 | Pendências de e-mail, falhas de agenda, erros, por módulo e setor | SLM | C alertas de comunicação na Central | — | IMPLEMENTADO, MAS NÃO VALIDADO | Sem teste específico localizado para estes alertas |
| 2 | Filtros, atribuição, redistribuição, parada, prazos, histórico, carga da equipe | SLM | I "Central: atribuição, transferência"; I "atraso e parada"; E "a Central mostra as filas" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 3 | Central individual: lidas, todas, anteriores, link, pendentes | NOT | E "notificações: a atribuição..."; I "notificações: permissões, leitura" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 3 | Configurar notificações por perfil | NOT | I "parâmetros: categoria desativada some do perfil"; E "parâmetros" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 4 | Protocolo único, permanente, backend, concorrência, por ano e módulo | REQ | I "protocolo: simultâneo sem duplicar"; I "migração 007 em banco com dados" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 4 | Protocolo em e-mails, relatórios, notificações, agenda, histórico | REQ | I "e-mail e notificação usam o código"; I "relatório individual" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 5 | Linha do tempo com de-para, autor, justificativa, protegida | REQ | I "linha do tempo: edição guarda de→para"; E "atribuição, prioridade e observação" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 6 | Pesquisa global: protocolo, palavra, categorias, filtros, paginação, permissões | BUS | I "pesquisa: encontra por protocolo"; I "pesquisa: histórico só para quem"; E "a pesquisa global respeita" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 7 | Anexos: tipos, limite configurável, conteúdo real, acesso, histórico, sem URL pública | ANX | I "anexos: validação real"; E "conteúdo falso recusado"; U fileValidation | ✔ | IMPLEMENTADO E VALIDADO | No banco real falta ATTACHMENTS_DIR (P-04) |
| 7 | Proteção contra arquivos maliciosos | ANX | U fileValidation: conteúdo, macros, script em PDF | ✔ | IMPLEMENTADO PARCIALMENTE | Sem antivírus (P-20) |
| 7 | Controle de capacidade | ANX | C getAttachmentCapacity; I "anexos..." | ✔ | IMPLEMENTADO E VALIDADO | — |
| 8 | Indicadores reais com tempos separados, produtividade restrita | REL | I "indicadores: dados reais, tempos separados" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 8 | Exportação em PDF e Excel | REL | E "relatório individual baixa um PDF"; E demandas "PDF e Excel"; CSV em relatórios gerais | ✔ | IMPLEMENTADO PARCIALMENTE | Excel real confirmado em Demandas; relatórios gerais não conferidos por formato |
| 9 | Tarefas por integrante, prioridades com justificativa, alertas de paradas, complexidade | SLM | I "Central: atribuição"; E "parâmetros: administrados pela tela" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 10 | Justificativas obrigatórias e sem alteração silenciosa | REQ | I "dado relevante exige justificativa"; I "cancelamento: motivo obrigatório" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 11.1 | Monitoramento e registros técnicos sem dados sensíveis | MON | I "monitoramento: serviços, disponibilidade" | ✔ | IMPLEMENTADO PARCIALMENTE | MONITORING_ENABLED desligado por padrão (P-11) |
| 11.2 | Períodos de indisponibilidade e indicadores | MON | I "monitoramento..." | ✔ | IMPLEMENTADO PARCIALMENTE | Idem P-11 |
| 11.3 | Backup automatizado, retenção, alerta, restauração periódica | BKP | E2E test:backup com dados fictícios; D "rotina automática não está ativa" | ✔ | BLOQUEADO POR DEPENDÊNCIA | P-10: depende de infraestrutura da TI |
| 11.3 | Backup só confiável após restauração | BKP | test:backup; ensaio da cópia de 04/11: restaurada | ✔ | IMPLEMENTADO E VALIDADO | — |
| 11.4 | Sessões: inatividade, encerramento, revogação, ativas | ACE | I "sessão inativa termina"; I "revisão de acessos... identifica sessões" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 11.5 | Revisão periódica de permissões | ACE | I "revisão de acessos: lista quem precisa" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 11.6 | Plano de contingência | DOC | D PLANO_DE_CONTINGENCIA.md, com responsáveis "a definir" | — | IMPLEMENTADO PARCIALMENTE | SLM e TI definem contatos e prazos |
| 12.1 | Equipamentos opcionais, execução, pendências, fotos, anexos | MAN | E "registro da execução e equipamento opcional"; categorias de foto em 008 | ✔ | IMPLEMENTADO E VALIDADO | — |
| 12.2 | Veículos, km, uso, ocorrências, abastecimento, revisão, alertas, relatórios | FRO | E "frota: veículo cadastrado"; I "frota: cadastro de veículos" | ✔ | IMPLEMENTADO E VALIDADO | Viagem usa veículo em texto (P-23) |
| 12.3 | Cotações, comparação, valores, histórico, alterações de passageiros, bilhetes | PAS | I "passagens: cotações comparáveis"; I "solicitante corrige passageiros" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 12.4 | Almoxarifado só controle interno, sem receber solicitações | ALM | V telas "Nova solicitação", "Pedir material" | — | DIVERGENTE DA ORIENTAÇÃO | P-07: conflito com SC01 sem decisão |
| 12.4 | Mínimo, alertas, entradas e saídas, consumo, inventário, divergências | ALM | I "estoque interno"; E "saldo interno, mínimo" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 12.5 | Configurações avançadas pela interface | CFG | E "parâmetros: administrados pela tela"; V seções da tela | ✔ | IMPLEMENTADO E VALIDADO | — |
| 13 | Comunicação só "enviada" com confirmação | INT | I "envio: ... enviado só com o serviço"; I "repositório: o indicador nunca afirma" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 15 | Azul #034EA2 e identidade preservados | VIS | Tema correto; 40 usos com #0862c9 | — | IMPLEMENTADO PARCIALMENTE | P-18 |
| 16 | /api/health e sistema antigo preservados | GER | E "toda resposta da API veio do backend"; C rota health | ✔ | IMPLEMENTADO E VALIDADO | — |

## Supercomando 05

Resumo: 4 implementado e validado, 1 divergente da orientação, 1 bloqueado por dependência.

| § | Requisito | Mód. | Evidência e teste | Teste | Classificação | Pendência |
|---|---|---|---|:-:|---|---|
| 2 | Data prevista só com dia, alterável, autor e data no histórico, visível ao solicitante | ALM | I "previsão: permissões, validações, histórico" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 2 | Restrito a integrantes autorizados da SLM | ALM | D Plano, questão 12: regra atual é warehouse:manage, que o Administrador tem | — | DIVERGENTE DA ORIENTAÇÃO | P-08 |
| 3 | Comunicação com protocolo e sem duplicar | ALM | I "comunicação única"; envio real não feito | ✔ | BLOQUEADO POR DEPENDÊNCIA | P-05 |
| 4 | Alteração com justificativa, de-para, nova notificação | ALM | I "previsão..." | ✔ | IMPLEMENTADO E VALIDADO | — |
| 5 | Previsão separada da entrega efetiva; situações; observações | ALM | I "entrega efetiva: separada da previsão"; U deliveryRules | ✔ | IMPLEMENTADO E VALIDADO | — |
| 6 | Consulta do solicitante sem dados internos | ALM | I "pedido digitado: ... só o acompanhamento"; E "solicitante acompanha" | ✔ | IMPLEMENTADO E VALIDADO | — |

## Supercomando 06

Resumo: 11 implementado e validado, 1 implementado parcialmente, 1 implementado, mas não validado, 1 bloqueado por dependência.

| § | Requisito | Mód. | Evidência e teste | Teste | Classificação | Pendência |
|---|---|---|---|:-:|---|---|
| 2.1 | Motivo padronizado e texto, exigido fora do pedido | REQ | I "agendamento diferente do pedido exige motivo"; E "agendar fora do pedido pede motivo" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 2.2-3 | Alteração e reagendamento justificados, preservando anteriores | REQ | I "editar a data pedida"; I "agendamento diferente..." | ✔ | IMPLEMENTADO E VALIDADO | — |
| 2.4 | Cancelamento com motivo, registro completo | REQ | I "cancelamento: motivo obrigatório" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 2.5 | Justificativa nos e-mails, com pedido, agendado e motivo | INT | I "explica ao solicitante"; envio real não feito | ✔ | BLOQUEADO POR DEPENDÊNCIA | P-05 |
| 3 | Textos institucionais antes do envio | REQ | Comparação textual em serviceNotices.ts: confere; E "os quatro formulários mostram" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 4 | Solicitada, disponibilizada, não disponibilizada, motivos, sem obrigação de fornecer | ALM | I "atendimento parcial com motivo"; I "motivos: administráveis" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 4 | Físico, disponível e fornecido | ALM | C quantidade_reservada; I "saldo sem obrigação" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 5 | Devolução com motivo, campos, correção, mesmo protocolo, dados anteriores | REQ | I "devolução: mesmo protocolo"; E "devolução: o solicitante vê" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 6 | Biblioteca de modelos editáveis, dinâmicos, histórico | CFG | C catalog.ts: 11 tipos pedidos presentes; E "modelos de e-mail: edição" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 7 | Alerta de duplicidade sem bloquear | REQ | I "duplicidade: alerta"; E "possível duplicidade alerta" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 8 | Relatório individual em PDF e CSV | REL | I "relatório individual: PDF e CSV"; E "baixa um PDF de verdade" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 9 | Prazos por módulo, alertas, filtros, tempos separados, espera externa fora do atraso | SLM | I "prazos: por módulo e tipo de serviço" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 10 | Acessibilidade ampliada | VIS | E "acessibilidade"; visual-review | ✔ | IMPLEMENTADO PARCIALMENTE | Leitor de tela não testado (P-21) |
| 11 | Auditoria das novas operações | AUD | C request.returned, warehouse.forecast_changed, config.published | — | IMPLEMENTADO, MAS NÃO VALIDADO | Ações existem no código; nem todas têm teste próprio |

## Supercomando 07

Resumo: 14 implementado e validado, 2 implementado parcialmente, 1 implementado, mas não validado, 1 não implementado.

| § | Requisito | Mód. | Evidência e teste | Teste | Classificação | Pendência |
|---|---|---|---|:-:|---|---|
| 2.1 | Campos editáveis de modelo | CFG | C EmailTemplatesManager; E "modelos de e-mail" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 2.2 | Modelos mínimos | CFG | C catalog.ts: presentes | — | IMPLEMENTADO, MAS NÃO VALIDADO | Nem todo modelo foi disparado em teste |
| 2.3 | Variáveis compatíveis, valor real, sem identificador técnico | CFG | C templateVariables.ts; I "modelos: permissões, validação"; I "texto próprio... sem marcação" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 2.4 | Editor com negrito, variáveis, prévia, restaurar padrão | CFG | C editor em texto simples; E "edição, validação, prévia" | ✔ | IMPLEMENTADO E VALIDADO | Compatibilidade em clientes de e-mail reais não testada |
| 2.5 | Prévia, simulação, envio de teste sem efeitos | CFG | I "e-mail de teste: só para a própria conta" | ✔ | IMPLEMENTADO PARCIALMENTE | Envio real depende de P-05 |
| 2.6 | Histórico, versões, restauração, permissão | CFG | I "publicação e restauração" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 3.1 | Formulários de conta, Manutenção, Frota, Passagens, Almoxarifado | CFG | I "formulários: proteção"; E "formulários: rascunho" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 3.2 | Tipos de campo, inclusive Anexo quando permitido | CFG | C formDefinitions.ts: não há tipo Anexo | — | NÃO IMPLEMENTADO | P-12 |
| 3.3 | Propriedades: nome, ajuda, obrigatório, ordem, opções, limites, visibilidade, seções | CFG | C formDefinitions; I "formulários: proteção dos campos essenciais" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 3.3 | Obrigatoriedade vale de verdade nos campos fixos | CFG | D Plano: "marcar como obrigatório um campo fixo opcional só vale na tela" | — | IMPLEMENTADO PARCIALMENTE | P-13 |
| 3.4 | Opções respeitam cadastros centrais | CFG | E "solicitante abre manutenção com seletores do servidor" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 3.5 | Regras condicionais validadas | CFG | C visibleWhen; I "formulários: ... regras" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 4 | Formulário de conta sem afrouxar segurança | CFG | I "formulário de conta: campos próprios sem afrouxar" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 5 | Formulário interno do Almoxarifado sem novo fluxo | ALM | I "controle interno"; E "controle interno... sem criar pedido" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 6 | Prévia, rascunho, publicação, restauração | CFG | E "rascunho não muda nada" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 7 | Dados históricos e versão usada em cada cadastro | CFG | C formulario_versao; I "formulários personalizados" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 8 | Permissões separadas para consultar, editar, publicar, restaurar | CFG | C permissions.ts; I "permissões separadas" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 9 | Sem código arbitrário e avisos protegidos | CFG | C escape no servidor, iframe sandbox; I "modelos de e-mail: texto próprio... sem marcação" | ✔ | IMPLEMENTADO E VALIDADO | — |

## Supercomando 08

Resumo: 7 implementado e validado, 2 implementado parcialmente, 1 bloqueado por dependência.

| § | Requisito | Mód. | Evidência e teste | Teste | Classificação | Pendência |
|---|---|---|---|:-:|---|---|
| 1 | Envio pela solicitação: destinatários, assunto, modelo, anexos, conferência, confirmar ou cancelar | COM | E "e-mail com anexo: conferir, confirmar"; I "envio: permissão, confirmação" | ✔ | IMPLEMENTADO E VALIDADO | Com transporte simulado |
| 2 | "Enviar passagem por e-mail": dados, bilhete, modelo, conferência | COM | E "passagem: dados do voo preenchidos"; I "passagem: dados automáticos" | ✔ | IMPLEMENTADO E VALIDADO | Simulado |
| 3 | Anexos: vários, nome, tamanho, remover, limite, validação | COM | I "anexos: removido ou alterado"; E "e-mail com anexo" | ✔ | IMPLEMENTADO PARCIALMENTE | Substituir anexo sem teste específico |
| 4 | Envio nos demais módulos | COM | I "almoxarifado: só quem administra envia"; C CommunicationsPanel | ✔ | IMPLEMENTADO E VALIDADO | — |
| 5 | Histórico, detalhes, reenvio, situações distintas | COM | E "reenviar sem perder o anterior"; I "falhas" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 6 | Indicador de bilhete sem mudar status | COM | I "indicador... o status não muda" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 7 | Modelos próprios, limites e formatos pela tela | COM | I "modelos: a administração cria"; E "limites da comunicação" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 7 | Conta institucional e permissões de envio por perfil | COM | C remetente só por variável de ambiente; communications:send individual | — | IMPLEMENTADO PARCIALMENTE | P-14 |
| 8 | Segurança e LGPD | COM | I "sem CPF"; anexos sem link público | ✔ | IMPLEMENTADO E VALIDADO | — |
| 9 | Envio real por provedor autorizado | COM | C transports.ts | — | BLOQUEADO POR DEPENDÊNCIA | P-05 |

## Supercomando 09

Resumo: 29 implementado e validado, 1 implementado parcialmente, 1 divergente da orientação.

| § | Requisito | Mód. | Evidência e teste | Teste | Classificação | Pendência |
|---|---|---|---|:-:|---|---|
| 2 | Três setores cadastráveis | DEM | E "o administrador configura setores" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 2.1 | Visões: setor, individual, compartilhada, consolidada | DEM | V abas; E "painel com dados reais"; E "setor colaborador" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 2.2 | Perfis, conforme a Matriz Definitiva de 04/11 e o ajuste de edição | DEM | I "matriz definitiva"; E servidor, chefe, diretor, administrador | ✔ | IMPLEMENTADO E VALIDADO | Substitui Colaborador, Responsável e Gestor do texto original |
| 2.3 | Demandas restritas fora de lista, pesquisa, relatório e API | DEM | I "demanda restrita não aparece"; E "demanda restrita" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 3 | Áreas internas | DEM | V demandas-painel: 7 abas | — | IMPLEMENTADO E VALIDADO | — |
| 4 | Painel com indicadores, listas e filtros reais | DEM | I "painel e relatórios"; V demandas-painel | ✔ | IMPLEMENTADO E VALIDADO | — |
| 5 | Formulário completo, número único, rascunho, prioridades, status | DEM | I "cadastro individual e compartilhado"; I "rascunho"; E "cria uma demanda compartilhada" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 5.3 | Suspensão com justificativa e terceiros identificados | DEM | I "status, suspensão, terceiros" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 6.1 | Frequências e intervalo | DEM | U recurrence; I "frequências semanal e quinzenal" | ✔ | IMPLEMENTADO E VALIDADO | Mensal, bimestral, trimestral e anual via unidade e intervalo |
| 6.2 | Duas datas no mês e dias da semana | DEM | I "recorrência mensal com duas datas"; E "recorrência mensal com duas datas" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 6.3 | Encerramento sem data, quantidade, data | DEM | I "encerramento por data"; I "pular a última data de uma quantidade" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 6.4 | Ocorrências independentes, vínculo preservado | DEM | I "gera demandas independentes" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 6.5 | Editar uma ou futuras, suspender, retomar, cancelar, pular | DEM | I "suspender, retomar, pular, cancelar e editar" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 6.6 | Geração no backend sem duplicar; meses e bissextos | DEM | U recurrence; I "reprocessar não duplica" | ✔ | IMPLEMENTADO E VALIDADO | Worker exige produção ou variável (P-11) |
| 7 | Compartilhadas: setores, atividades e prazos por colaborador | DEM | E "quem é de setor colaborador também edita"; C atividade e prazo | ✔ | IMPLEMENTADO E VALIDADO | — |
| 8 | Subtarefas, percentual, conclusão não automática | DEM | E "cria etapas e impede a conclusão com etapa aberta" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 8 | Anexos nas subtarefas | DEM | C API aceita etapa; uploadDemandAttachment na tela não envia | — | IMPLEMENTADO PARCIALMENTE | P-15 |
| 9 | Comentários, providências, menções, histórico | DEM | I "comentários, menções"; I "histórico registra cada alteração" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 10 | Anexos: criação, depois, ver, baixar, validação | DEM | I "anexos: validação, acesso, download"; E "com colaborador e anexo" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 11 | Conclusão e reabertura | DEM | E "conclui, reabre com justificativa" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 12 | Agenda em dia, semana, mês, setor, individual, consolidada | DEM | I "agenda individual, por setor e consolidada"; E "agenda em mês, semana e dia" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 13 | Notificações e lembretes sem repetição | DEM | I "alertas de prazo chegam uma vez"; C 10 tipos | ✔ | IMPLEMENTADO E VALIDADO | E-mail só registrado como preferência; era "prever" |
| 14 | Categorias personalizáveis | DEM | I "categoria desativada sai dos formulários" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 15 | Pesquisa, filtros combinados, ordenação | DEM | I "filtros combinados e ordenação"; E "pesquisa: filtros combináveis" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 16 | Lista, Kanban, calendário, minhas, setor, Diretoria | DEM | E "quadro: mover pelo controle"; E "filtros e visualização em lista" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 17 | Relatórios com PDF e Excel | DEM | E "exportação em PDF e Excel"; U xlsxDocument | ✔ | IMPLEMENTADO E VALIDADO | — |
| 18 | Vínculo com módulos sem alterar origem | DEM | I "vínculo com outros módulos" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 19 | Azul nos elementos principais, amarelo em destaques | VIS | V demandas-painel: primário amarelo, azul pontual | — | DIVERGENTE DA ORIENTAÇÃO | P-18: conflito com SC02, questão 14 do Plano |
| 20 | Segurança, auditoria, LGPD | DEM | I "a sessão é a única identidade"; E "as alterações ficam na auditoria" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 21 | Persistência real, sem localStorage | DEM | E "o que foi gravado continua ao sair e entrar" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 22 | Critérios de aceite do módulo | DEM | Testes de demandas e permissões; acesso simultâneo: "alteração simultânea" | ✔ | IMPLEMENTADO E VALIDADO | — |

## Supercomando 10*

Resumo: 4 implementado e validado, 1 divergente da orientação.

| § | Requisito | Mód. | Evidência e teste | Teste | Classificação | Pendência |
|---|---|---|---|:-:|---|---|
| 3 | Aprovação define vínculos pela tela, editáveis, auditados | ORG | I "aprovação define lotação"; E "a aprovação pela tela define" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 4 | Acesso de integrantes da DA e da SLM | ORG | I "não há outros níveis de acesso" | ✔ | DIVERGENTE DA ORIENTAÇÃO | Substituído pela Matriz Definitiva: DA e SLM não dão acesso sem setor. Confirmar |
| 4 | Administrador sem setor consulta tudo | ORG | E "administrador: consulta tudo" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 5 | Configuração de setores, chefias, gestores | ORG | E "diretor: configura setores" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 7 | Histórico preservado ao retirar | ORG | I "retirar de um setor preserva" | ✔ | IMPLEMENTADO E VALIDADO | — |

## Supercomando 11*

Resumo: 8 implementado e validado, 1 implementado parcialmente.

| § | Requisito | Mód. | Evidência e teste | Teste | Classificação | Pendência |
|---|---|---|---|:-:|---|---|
| 2-3 | Perfil Motorista e portal próprio | POR | E "login: o motorista entra direto no portal"; V motorista-viagens | ✔ | IMPLEMENTADO E VALIDADO | — |
| 4 | Só as próprias viagens, por situação | POR | I "isolamento"; E "viagens: cada motorista" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 5-6 | Iniciar e finalizar com horário do servidor, sem duplicar | POR | I "iniciar"; I "dois inícios"; I "finalizar" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 7 | Ocorrências com anexo | POR | I "ocorrências: da viagem certa" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 8 | Histórico individual | POR | I "histórico individual" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 9 | Referência de jornada que identifica, sem impedir finalização | POR | I "a referência das 7h às 19h" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 10 | Integração com a Frota | POR | E "iniciar: ... reflete na Frota" | ✔ | IMPLEMENTADO PARCIALMENTE | Hodômetro não alimenta km do veículo (P-23) |
| 11 | Notificações ao motorista | POR | I "avisos"; E "avisos" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 12 | Bloqueios no backend | POR | I "o motorista não alcança nenhuma área"; E "rotas e APIs" | ✔ | IMPLEMENTADO E VALIDADO | — |

## Supercomando 12*

Resumo: 5 implementado e validado, 1 implementado parcialmente.

| § | Requisito | Mód. | Evidência e teste | Teste | Classificação | Pendência |
|---|---|---|---|:-:|---|---|
| 3 | Jornada editável sem efeito retroativo | POR | I "jornada: mudar não reescreve" | ✔ | IMPLEMENTADO PARCIALMENTE | Jornada noturna não é aceita (P-23) |
| 4-5 | Execução e tipos de ocorrência editáveis | POR | I "informações obrigatórias"; I "tipos de ocorrência" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 6 | Regras de notificação | POR | I "notificações ao motorista"; I "notificações à equipe" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 7 | Ativar e desativar sem enfraquecer segurança | POR | I "nenhuma configuração abre viagens de terceiros" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 8 | Configurações de visualização | POR | E "visualização: cartão, avisos" | ✔ | IMPLEMENTADO E VALIDADO | — |
| 9 | Persistência e histórico no banco | POR | I "persistência e histórico" | ✔ | IMPLEMENTADO E VALIDADO | Bloco editado por dois: vale o último |
