# Matriz de requisitos em 06/11/2026

Atualiza `MATRIZ_CONFORMIDADE.md` (auditoria de 05/11/2026), que fica preservada como registro histórico. Cada linha mantém o requisito, a evidência e a classificação de 05/11 e acrescenta a situação depois das correções de 06/11. Relatório: `RELATORIO_ESTABILIZACAO_2026-11-06.md`.

## Como ler

- **AGUARDANDO HOMOLOGAÇÃO REAL:** implementado e comprovado por teste automatizado em ambiente descartável (banco descartável, e-mail e agenda simulados). **Não está homologado:** falta funcionar no banco real, com as migrações aplicadas, e o aceite da área usuária. É a situação dos 141 requisitos validados em 05/11, como pedido no Supercomando, e dos corrigidos agora.
- **PARCIALMENTE RESOLVIDO:** há parte implementada, ou falta evidência suficiente.
- **NÃO RESOLVIDO:** não implementado.
- **BLOQUEADO POR DEPENDÊNCIA EXTERNA:** depende de credenciais, infraestrutura, acesso ao sistema antigo, decisão da responsável ou autorização institucional.
- **RESOLVIDO E COMPROVADO** não é usado para requisitos: nenhum requisito de produto foi comprovado no ambiente real. Essa classificação aparece no relatório só para problemas técnicos cuja correção não depende do ambiente real.
- Evidência: I = integração; E = navegador; U = unitário; C = código; D = documento.

## Totais

| Situação em 06/11 | 01 a 09 | 10 a 12 |
|---|---:|---:|
| AGUARDANDO HOMOLOGAÇÃO REAL | 147 | 17 |
| PARCIALMENTE RESOLVIDO | 16 | 2 |
| NÃO RESOLVIDO | 1 | 0 |
| BLOQUEADO POR DEPENDÊNCIA EXTERNA | 17 | 1 |
| **Total** | **181** | **20** |

## Supercomando 01


| § | Requisito | Mód. | Evidência (05/11) | Classificação em 05/11 | Situação em 06/11 | Observação em 06/11 |
|---|---|---|---|---|---|---|
| 4 | SLM independente da lotação; só integrante autorizado abre em nome de outro setor | ACE | I "em nome de outro setor: dentro e fora da SLM"; I "quem é do CPC e não está na SLM" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 4 | Somente integrantes autorizados da SLM realizam agendamentos | ACE | I "agendar: administrador sem SLM pode" | DIVERGENTE DA ORIENTAÇÃO | **AGUARDANDO HOMOLOGAÇÃO REAL** | P-08 corrigido: Administrador fora da SLM recebe 403 e a recusa é auditada. I "agendar: administrador sem SLM não pode"; I "agendar: ... Administrador só na equipe SLM"; U requestPolicy |
| 4 | Administrador não recebe automaticamente permissões restritas | ACE | I "abrir em nome... mesmo para administrador"; E "a Central não aparece... nem por ser administrador" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | A exceção do agendamento (P-08) foi eliminada. U "administrador fora da SLM não recebe atribuições operacionais da SLM pelo perfil" |
| 4 | Solicitante não integra a SLM | ACE | I "só Administrador e Operador SLM integram a equipe, na API e no banco" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 4 | CPF completo só para SLM elegível com concessão individual; admin fora da SLM não recebe; demais mascarado | PAS | I "CPF: com e sem concessão"; I "sem flights:cpf:read"; E "CPF mascarado para todos" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 4 | Consulta de CPF protegida no backend e auditada | PAS | I "com flights:cpf:read, consulta... com auditoria"; I "se a auditoria falhar, o CPF não é devolvido" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 4 | Saída da SLM, mudança de perfil ou desativação revogam; retorno não restaura | ACE | I "sair da SLM revoga"; I "rebaixar um administrador revoga"; I "desativar revoga" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 4 | Administrador não altera o próprio acesso | ACE | I "ninguém altera o próprio acesso"; E "a própria conta não oferece alteração" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 5 | Cadastro de usuários com aprovação administrativa | ACE | I "cadastro fica pendente"; E "cadastro fica pendente até a aprovação" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 5 | Cadastro com e-mail institucional | ACE | C institutionalEmail.ts: sem INSTITUTIONAL_EMAIL_DOMAINS aceita qualquer domínio | BLOQUEADO POR DEPENDÊNCIA | **BLOQUEADO POR DEPENDÊNCIA EXTERNA** | P-09: falta a lista oficial de domínios |
| 5 | Ativação, desativação, perfis e permissões individuais | ACE | I "permissões individuais somam e retiram"; I "um administrador pode desativar outro" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 5 | Recuperação de senha por link temporário | ACE | I "recuperação por link: uso único, prazo"; envio real não testado | BLOQUEADO POR DEPENDÊNCIA | **BLOQUEADO POR DEPENDÊNCIA EXTERNA** | P-05: faltam RESEND_API_KEY, RESEND_FROM, PASSWORD_RESET_PEPPER, APP_PUBLIC_URL |
| 5 | Controle e encerramento de sessões | ACE | I "sessões: consultar, sair dos outros"; E "encerrar as outras sessões" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 5 | Proteção contra login abusivo | ACE | I "após o limite, nem a senha correta entra" | IMPLEMENTADO PARCIALMENTE | **PARCIALMENTE RESOLVIDO** | Limitador em memória, vale para uma instância (P-22) |
| 5 | Auditoria de ações administrativas; último administrador protegido | ACE | I "o último administrador não pode ser removido"; I "dois administradores rebaixando" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 6.1 | Dashboard e início com dados reais, por período e permissão | DSH | E "Dashboard é separado... usa dados reais"; I "painel e relatórios: dados reais" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 6.2 | Manutenção: cadastro, solicitante, setor, andar, tipo padronizado | MAN | E "solicitante abre manutenção com seletores do servidor" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 6.2 | Manutenção: agendar, reagendar, cancelar, iniciar, concluir, histórico, responsáveis | MAN | E "operadora agenda, reagenda, inicia e conclui"; I "manutenção: fluxo completo" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 6.2 | Status institucionais preservados, sem transição indevida | MAN | C workflow.ts; I "registros de status antigo aparecem traduzidos" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 6.3 | Frota: solicitação, origem/destino, passageiros, agenda, execução real, ocorrências, histórico | FRO | E "frota: solicitação, execução e registro de atraso"; I "frota: solicitação, execução real" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 6.3 | Preservar fluxos e informações do sistema antigo | LEG | D INTEGRACOES: código e planilhas antigos não estão no repositório | BLOQUEADO POR DEPENDÊNCIA | **BLOQUEADO POR DEPENDÊNCIA EXTERNA** | P-06: paridade não verificável |
| 6.4 | Passagens: formulário, até 10 passageiros, ida e volta, somente volta, bagagem | PAS | I "limite de dez passageiros, somente volta" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 6.4 | Passagens: status preservados e dados pessoais protegidos | PAS | I "CPF cifrado no banco, mascarado na API"; I "sem a chave, nenhum passageiro é gravado" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | No banco real falta PASSENGER_DATA_KEY (P-04) |
| 6.5 | Configurações: setores, andares, tipos; incluir, editar, desativar, reativar, duplicidade, permissão | CFG | I "configurações: permissão, duplicidade..."; E "administradora cadastra as listas" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 6.5 | Desativação não altera histórico | CFG | I "desativar ou renomear uma opção não muda os registros antigos" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 6.6 | Almoxarifado: origens JUCESP e governamental em central única, referência externa | ALM | E "catálogo, pedido interno, pedido externo e entrega"; I "pedido interno, pedido externo, central" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | Conflito com SC04-07 (P-07) |
| 6.6 | Consulta, edição local, itens, quantidades, situação, entrega, histórico, responsável, filtros, relatórios | ALM | I "almoxarifado: pedido interno..."; I "relatórios: quilometragem e consumo"; edição de item só no código | IMPLEMENTADO PARCIALMENTE | **AGUARDANDO HOMOLOGAÇÃO REAL** | Evidência localizada: I integrações (PUT de itens, linhas 689-691); I "almoxarifado: atendimento parcial" |
| 6.6 | Editar pedido externo não altera o governamental; não afirmar integração | ALM | C não há integração; I "pedido externo não tem a quem avisar" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 6.6 | Catálogo, unidade, ativos e inativos | ALM | E "catálogo"; I "categoria desativada some" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 6.6 | Conferência de inventário: governamental, contada, diferença, situação, histórico | ALM | E "conferência de inventário calcula a diferença"; I "conferência de inventário: quantidades" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 6.7 | Agenda usa os mesmos registros de Manutenção e Frota | AGE | I "agenda: usa os agendamentos dos módulos" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 6.8 | Auditoria de login, cadastros, perfis, permissões, CPF, solicitações, agenda, config., Almoxarifado, status | AUD | I "histórico e auditoria não podem ser alterados"; C ações auditadas listadas | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 6.8 | Usuários comuns não alteram auditoria | AUD | I "histórico e auditoria..."; I "consulta de auditoria exige audit:read" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 7 | Migrações documentadas, testadas e com reversão | DB | Ensaio 16 aplicadas e revertidas, 0 diferença de estrutura; 002 e 004 sem arquivo de reversão (DROP documentado) | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 7 | Dados sensíveis protegidos, integridade referencial, transações | DB | I "CPF cifrado"; C FKs e withTransaction | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | Sequências e privilégios (P-02, P-03) |
| 9 | Fluxo real, sem dados fictícios como reais | GER | C sem mock em produção; ensaio em banco descartável | IMPLEMENTADO PARCIALMENTE | **BLOQUEADO POR DEPENDÊNCIA EXTERNA** | P-01: migrações 002 a 018 prontas e testadas em banco descartável; aplicação no banco real depende de autorização |

## Supercomando 02


| § | Requisito | Mód. | Evidência (05/11) | Classificação em 05/11 | Situação em 06/11 | Observação em 06/11 |
|---|---|---|---|---|---|---|
| 3 | Paleta: preto, #FBB900, branco, grafite; azul sem dominar | VIS | V capturas revisadas; theme.css | IMPLEMENTADO PARCIALMENTE | **PARCIALMENTE RESOLVIDO** | --jucesp-blue vira #0862c9 em 40 usos; roxo legado (P-18) |
| 3 | Sidebar preta; item ativo amarelo com ícone preto; botões amarelos; nome claro | VIS | V computador-inicio; celular-menu | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 4 | Ícones preenchidos e duotone, biblioteca única, sem emoji | VIS | C @phosphor-icons/react, ui/Icon; V capturas; busca sem emoji | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 4 | Ilustrações para estados vazios, quando fizer sentido | VIS | Capturas sem ilustração; requisito era opcional | IMPLEMENTADO, MAS NÃO VALIDADO | **PARCIALMENTE RESOLVIDO** | Não avaliado em todas as telas |
| 5 | Navegação moderna, responsiva, sem títulos e avisos removidos | VIS | Busca sem "GESTÃO OPERACIONAL", "Versão inicial"; E "as telas não têm rolagem lateral" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 6 | Início limpa, sem aviso, acesso rápido útil | DSH | V computador-inicio; E "atalho da aba Inicial" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 6 | Aba Dashboard distinta, com gráficos e estado vazio reais | DSH | E "Dashboard é separado"; V computador-dashboard | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 7 | Filtros suspensos em Passagens, limpar e atualizar | PAS | E "os filtros suspensos atualizam a lista e podem ser limpos" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 8 | Almoxarifado com navegação consistente e todas as áreas modernizadas | ALM | V computador-almoxarifado; e2e visual | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 9 | Auditoria modernizada: filtros, detalhes, paginação, sem edição | AUD | I "auditoria: filtros por ação"; C Pagination; E "painel, relatórios e auditoria" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 10 | Configurações em grupos claros, refletindo o backend | CFG | V computador-configuracoes: página de 10.853 px | IMPLEMENTADO PARCIALMENTE | **PARCIALMENTE RESOLVIDO** | Tudo em uma rolagem só (P-19) |
| 11 | Padrões reutilizáveis de campos, tabelas, modais, alertas | VIS | C components/ui | IMPLEMENTADO PARCIALMENTE | **PARCIALMENTE RESOLVIDO** | App.css legado de 4.624 linhas convive com theme.css (P-18) |
| 12 | Desktop, tablet, celular sem rolagem lateral; contraste e alvos | VIS | E visual-review em 3 tamanhos | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | Verificação automática |
| 12 | Teclado, foco, rótulos | VIS | E "acessibilidade: atalho... foco visível"; visual-review | IMPLEMENTADO PARCIALMENTE | **PARCIALMENTE RESOLVIDO** | Sem teste com leitor de tela (P-21) |
| 13 | Preservação funcional | GER | Suíte completa | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |

## Supercomando 03


| § | Requisito | Mód. | Evidência (05/11) | Classificação em 05/11 | Situação em 06/11 | Observação em 06/11 |
|---|---|---|---|---|---|---|
| 3 | Avisos de privacidade antes do envio, sem aceite | LGP | E "os formulários apresentam o aviso de privacidade" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | Texto pendente de validação institucional |
| 3 | Sem inventar base legal; retenção e descarte por política aprovada | LGP | D PRIVACIDADE | BLOQUEADO POR DEPENDÊNCIA | **BLOQUEADO POR DEPENDÊNCIA EXTERNA** | P-16: base legal e retenção dependem da instituição |
| 3 | CPF e dados pessoais fora de e-mails e notificações | LGP | I "passagens: fluxo, sem CPF, nomes ou trechos"; I "passagem: ... sem CPF" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 3 | Documentação dos dados coletados | LGP | D PRIVACIDADE_E_TRATAMENTO_DE_DADOS.md | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 4.1-4 | E-mails por fluxo em Manutenção, Frota, Passagens e Almoxarifado | INT | I "manutenção: comunicações..."; I "passagens: fluxo"; I "almoxarifado: fluxo interno"; simulados | BLOQUEADO POR DEPENDÊNCIA | **BLOQUEADO POR DEPENDÊNCIA EXTERNA** | P-05: envio real nunca testado |
| 4.5 | Modelos, destinatários, cópias, histórico, falhas, reenvio, duplicidade | INT | I "destinatários internos e cópias vêm só da configuração"; I "falha definitiva" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | Com transporte simulado |
| 4.5 | Situação de entrega do provedor | INT | I "situação de entrega: consultada só quando o provedor informa" | BLOQUEADO POR DEPENDÊNCIA | **BLOQUEADO POR DEPENDÊNCIA EXTERNA** | P-05 |
| 5 | Falha de e-mail não impede registro; fila, idempotência, tentativas | INT | I "recebimento: uma falha..."; I "dois processos..."; I "as tentativas têm limite" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | Worker só liga em produção ou por variável (P-11) |
| 6 | Agenda diária, semanal, mensal; filtros; responsáveis; detalhes | AGE | E "agenda: filtros, detalhes, reagendamento"; I "agenda: filtros por status" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 6 | Conflitos e alterações simultâneas no backend | AGE | I "conflitos: mesmo responsável ou veículo"; I "alteração simultânea" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 7 | Google Calendar: criar, atualizar, cancelar, duplicidade, falhas, reprocesso | INT | I "google simulado"; I "calendário: falha definitiva" | BLOQUEADO POR DEPENDÊNCIA | **BLOQUEADO POR DEPENDÊNCIA EXTERNA** | P-05: faltam conta de serviço e calendários; nada real testado |
| 7 | Agenda interna funciona sem o Google | AGE | I "a agenda segue sem o provedor" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 8 | Notificações internas com permissão, link, leitura, sem duplicar, celular | NOT | E "a equipe é notificada, e o sino leva"; I "notificações: permissões"; E "celular: notificações" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 9 | Histórico padronizado e imutável | AUD | I "registros históricos: eventos... não mudam" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 10 | Relatórios por módulo, período, setor, status, com limitação informada e exportação | REL | I "relatórios: indicadores reais, com a limitação"; E "relatórios mostram os indicadores" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 11 | Consistência entre módulos | GER | Suíte E2E e integração | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 12 | Sistema antigo preservado, sem sincronização | LEG | C não há acesso nem sincronização | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 12 | Rotinas antigas documentadas e validadas | LEG | D INTEGRACOES: "a paridade não foi verificada" | BLOQUEADO POR DEPENDÊNCIA | **BLOQUEADO POR DEPENDÊNCIA EXTERNA** | P-06 |

## Supercomando 04


| § | Requisito | Mód. | Evidência (05/11) | Classificação em 05/11 | Situação em 06/11 | Observação em 06/11 |
|---|---|---|---|---|---|---|
| 2 | Central exclusiva da SLM por concessão validada no backend | SLM | E "a Central não aparece"; I "Central: só com concessão individual" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 2 | Filas: atendimento, agendamento, hoje, atrasadas, aprovações, sem responsável, andamento, concluídas, canceladas | SLM | C filas em SlmCentralPage; I "indicadores coincidem com as listas" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 2 | Pendências de e-mail, falhas de agenda, erros, por módulo e setor | SLM | C alertas de comunicação na Central | IMPLEMENTADO, MAS NÃO VALIDADO | **PARCIALMENTE RESOLVIDO** | Sem teste específico localizado para estes alertas |
| 2 | Filtros, atribuição, redistribuição, parada, prazos, histórico, carga da equipe | SLM | I "Central: atribuição, transferência"; I "atraso e parada"; E "a Central mostra as filas" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 3 | Central individual: lidas, todas, anteriores, link, pendentes | NOT | E "notificações: a atribuição..."; I "notificações: permissões, leitura" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 3 | Configurar notificações por perfil | NOT | I "parâmetros: categoria desativada some do perfil"; E "parâmetros" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 4 | Protocolo único, permanente, backend, concorrência, por ano e módulo | REQ | I "protocolo: simultâneo sem duplicar"; I "migração 007 em banco com dados" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 4 | Protocolo em e-mails, relatórios, notificações, agenda, histórico | REQ | I "e-mail e notificação usam o código"; I "relatório individual" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 5 | Linha do tempo com de-para, autor, justificativa, protegida | REQ | I "linha do tempo: edição guarda de→para"; E "atribuição, prioridade e observação" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 6 | Pesquisa global: protocolo, palavra, categorias, filtros, paginação, permissões | BUS | I "pesquisa: encontra por protocolo"; I "pesquisa: histórico só para quem"; E "a pesquisa global respeita" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 7 | Anexos: tipos, limite configurável, conteúdo real, acesso, histórico, sem URL pública | ANX | I "anexos: validação real"; E "conteúdo falso recusado"; U fileValidation | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | No banco real falta ATTACHMENTS_DIR (P-04) |
| 7 | Proteção contra arquivos maliciosos | ANX | U fileValidation: conteúdo, macros, script em PDF | IMPLEMENTADO PARCIALMENTE | **PARCIALMENTE RESOLVIDO** | Sem antivírus (P-20) |
| 7 | Controle de capacidade | ANX | C getAttachmentCapacity; I "anexos..." | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 8 | Indicadores reais com tempos separados, produtividade restrita | REL | I "indicadores: dados reais, tempos separados" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 8 | Exportação em PDF e Excel | REL | E "relatório individual baixa um PDF"; E demandas "PDF e Excel"; CSV em relatórios gerais | IMPLEMENTADO PARCIALMENTE | **PARCIALMENTE RESOLVIDO** | Excel real confirmado em Demandas; relatórios gerais não conferidos por formato |
| 9 | Tarefas por integrante, prioridades com justificativa, alertas de paradas, complexidade | SLM | I "Central: atribuição"; E "parâmetros: administrados pela tela" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 10 | Justificativas obrigatórias e sem alteração silenciosa | REQ | I "dado relevante exige justificativa"; I "cancelamento: motivo obrigatório" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 11.1 | Monitoramento e registros técnicos sem dados sensíveis | MON | I "monitoramento: serviços, disponibilidade" | IMPLEMENTADO PARCIALMENTE | **BLOQUEADO POR DEPENDÊNCIA EXTERNA** | P-11: ligar MONITORING_ENABLED depende do ambiente de produção (docs/PRODUCAO.md); config:check aponta a ausência |
| 11.2 | Períodos de indisponibilidade e indicadores | MON | I "monitoramento..." | IMPLEMENTADO PARCIALMENTE | **BLOQUEADO POR DEPENDÊNCIA EXTERNA** | Idem P-11 |
| 11.3 | Backup automatizado, retenção, alerta, restauração periódica | BKP | E2E test:backup com dados fictícios; D "rotina automática não está ativa" | BLOQUEADO POR DEPENDÊNCIA | **BLOQUEADO POR DEPENDÊNCIA EXTERNA** | P-10: backup e verificação dos anexos criados e testados; procedimento de cópia externa, retenção e recuperação documentado. Agendador e destino externo dependem da TI |
| 11.3 | Backup só confiável após restauração | BKP | test:backup; ensaio da cópia de 04/11: restaurada | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 11.4 | Sessões: inatividade, encerramento, revogação, ativas | ACE | I "sessão inativa termina"; I "revisão de acessos... identifica sessões" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 11.5 | Revisão periódica de permissões | ACE | I "revisão de acessos: lista quem precisa" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 11.6 | Plano de contingência | DOC | D PLANO_DE_CONTINGENCIA.md, com responsáveis "a definir" | IMPLEMENTADO PARCIALMENTE | **PARCIALMENTE RESOLVIDO** | SLM e TI definem contatos e prazos |
| 12.1 | Equipamentos opcionais, execução, pendências, fotos, anexos | MAN | E "registro da execução e equipamento opcional"; categorias de foto em 008 | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 12.2 | Veículos, km, uso, ocorrências, abastecimento, revisão, alertas, relatórios | FRO | E "frota: veículo cadastrado"; I "frota: cadastro de veículos" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | Viagem usa veículo em texto (P-23) |
| 12.3 | Cotações, comparação, valores, histórico, alterações de passageiros, bilhetes | PAS | I "passagens: cotações comparáveis"; I "solicitante corrige passageiros" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 12.4 | Almoxarifado só controle interno, sem receber solicitações | ALM | V telas "Nova solicitação", "Pedir material" | DIVERGENTE DA ORIENTAÇÃO | **BLOQUEADO POR DEPENDÊNCIA EXTERNA** | P-07: decisão da responsável |
| 12.4 | Mínimo, alertas, entradas e saídas, consumo, inventário, divergências | ALM | I "estoque interno"; E "saldo interno, mínimo" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 12.5 | Configurações avançadas pela interface | CFG | E "parâmetros: administrados pela tela"; V seções da tela | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 13 | Comunicação só "enviada" com confirmação | INT | I "envio: ... enviado só com o serviço"; I "repositório: o indicador nunca afirma" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 15 | Azul #034EA2 e identidade preservados | VIS | Tema correto; 40 usos com #0862c9 | IMPLEMENTADO PARCIALMENTE | **PARCIALMENTE RESOLVIDO** | P-18 |
| 16 | /api/health e sistema antigo preservados | GER | E "toda resposta da API veio do backend"; C rota health | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |

## Supercomando 05


| § | Requisito | Mód. | Evidência (05/11) | Classificação em 05/11 | Situação em 06/11 | Observação em 06/11 |
|---|---|---|---|---|---|---|
| 2 | Data prevista só com dia, alterável, autor e data no histórico, visível ao solicitante | ALM | I "previsão: permissões, validações, histórico" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 2 | Restrito a integrantes autorizados da SLM | ALM | D Plano, questão 12: regra atual é warehouse:manage, que o Administrador tem | DIVERGENTE DA ORIENTAÇÃO | **AGUARDANDO HOMOLOGAÇÃO REAL** | P-08 corrigido: warehouse:manage exige equipe SLM. I "previsão: permissões..." com administrador externo recusado e auditado |
| 3 | Comunicação com protocolo e sem duplicar | ALM | I "comunicação única"; envio real não feito | BLOQUEADO POR DEPENDÊNCIA | **BLOQUEADO POR DEPENDÊNCIA EXTERNA** | P-05 |
| 4 | Alteração com justificativa, de-para, nova notificação | ALM | I "previsão..." | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 5 | Previsão separada da entrega efetiva; situações; observações | ALM | I "entrega efetiva: separada da previsão"; U deliveryRules | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 6 | Consulta do solicitante sem dados internos | ALM | I "pedido digitado: ... só o acompanhamento"; E "solicitante acompanha" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |

## Supercomando 06


| § | Requisito | Mód. | Evidência (05/11) | Classificação em 05/11 | Situação em 06/11 | Observação em 06/11 |
|---|---|---|---|---|---|---|
| 2.1 | Motivo padronizado e texto, exigido fora do pedido | REQ | I "agendamento diferente do pedido exige motivo"; E "agendar fora do pedido pede motivo" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 2.2-3 | Alteração e reagendamento justificados, preservando anteriores | REQ | I "editar a data pedida"; I "agendamento diferente..." | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 2.4 | Cancelamento com motivo, registro completo | REQ | I "cancelamento: motivo obrigatório" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 2.5 | Justificativa nos e-mails, com pedido, agendado e motivo | INT | I "explica ao solicitante"; envio real não feito | BLOQUEADO POR DEPENDÊNCIA | **BLOQUEADO POR DEPENDÊNCIA EXTERNA** | P-05 |
| 3 | Textos institucionais antes do envio | REQ | Comparação textual em serviceNotices.ts: confere; E "os quatro formulários mostram" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 4 | Solicitada, disponibilizada, não disponibilizada, motivos, sem obrigação de fornecer | ALM | I "atendimento parcial com motivo"; I "motivos: administráveis" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 4 | Físico, disponível e fornecido | ALM | C quantidade_reservada; I "saldo sem obrigação" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 5 | Devolução com motivo, campos, correção, mesmo protocolo, dados anteriores | REQ | I "devolução: mesmo protocolo"; E "devolução: o solicitante vê" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 6 | Biblioteca de modelos editáveis, dinâmicos, histórico | CFG | C catalog.ts: 11 tipos pedidos presentes; E "modelos de e-mail: edição" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 7 | Alerta de duplicidade sem bloquear | REQ | I "duplicidade: alerta"; E "possível duplicidade alerta" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 8 | Relatório individual em PDF e CSV | REL | I "relatório individual: PDF e CSV"; E "baixa um PDF de verdade" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 9 | Prazos por módulo, alertas, filtros, tempos separados, espera externa fora do atraso | SLM | I "prazos: por módulo e tipo de serviço" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 10 | Acessibilidade ampliada | VIS | E "acessibilidade"; visual-review | IMPLEMENTADO PARCIALMENTE | **PARCIALMENTE RESOLVIDO** | Leitor de tela não testado (P-21) |
| 11 | Auditoria das novas operações | AUD | C request.returned, warehouse.forecast_changed, config.published | IMPLEMENTADO, MAS NÃO VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | Evidência: I previsão (warehouse.forecast_set/changed); I formulários (config.*); I devolução (request.returned, novo); recusas de operação sensível (access.denied, novo) |

## Supercomando 07


| § | Requisito | Mód. | Evidência (05/11) | Classificação em 05/11 | Situação em 06/11 | Observação em 06/11 |
|---|---|---|---|---|---|---|
| 2.1 | Campos editáveis de modelo | CFG | C EmailTemplatesManager; E "modelos de e-mail" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 2.2 | Modelos mínimos | CFG | C catalog.ts: presentes | IMPLEMENTADO, MAS NÃO VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | Evidência localizada: U "os fluxos pedidos têm modelo em cada módulo"; I modelos de e-mail (lista de eventos exigidos) |
| 2.3 | Variáveis compatíveis, valor real, sem identificador técnico | CFG | C templateVariables.ts; I "modelos: permissões, validação"; I "texto próprio... sem marcação" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 2.4 | Editor com negrito, variáveis, prévia, restaurar padrão | CFG | C editor em texto simples; E "edição, validação, prévia" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | Compatibilidade em clientes de e-mail reais não testada |
| 2.5 | Prévia, simulação, envio de teste sem efeitos | CFG | I "e-mail de teste: só para a própria conta" | IMPLEMENTADO PARCIALMENTE | **PARCIALMENTE RESOLVIDO** | Envio real depende de P-05 |
| 2.6 | Histórico, versões, restauração, permissão | CFG | I "publicação e restauração" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 3.1 | Formulários de conta, Manutenção, Frota, Passagens, Almoxarifado | CFG | I "formulários: proteção"; E "formulários: rascunho" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 3.2 | Tipos de campo, inclusive Anexo quando permitido | CFG | C formDefinitions.ts: não há tipo Anexo | NÃO IMPLEMENTADO | **NÃO RESOLVIDO** | P-12 |
| 3.3 | Propriedades: nome, ajuda, obrigatório, ordem, opções, limites, visibilidade, seções | CFG | C formDefinitions; I "formulários: proteção dos campos essenciais" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 3.3 | Obrigatoriedade vale de verdade nos campos fixos | CFG | D Plano: "marcar como obrigatório um campo fixo opcional só vale na tela" | IMPLEMENTADO PARCIALMENTE | **PARCIALMENTE RESOLVIDO** | P-13: já conferido no servidor (I "formulários: ... sala ficou obrigatória"); o documento estava desatualizado. Exceção: campo fixo com regra condicional de exibição |
| 3.4 | Opções respeitam cadastros centrais | CFG | E "solicitante abre manutenção com seletores do servidor" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 3.5 | Regras condicionais validadas | CFG | C visibleWhen; I "formulários: ... regras" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 4 | Formulário de conta sem afrouxar segurança | CFG | I "formulário de conta: campos próprios sem afrouxar" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 5 | Formulário interno do Almoxarifado sem novo fluxo | ALM | I "controle interno"; E "controle interno... sem criar pedido" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 6 | Prévia, rascunho, publicação, restauração | CFG | E "rascunho não muda nada" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 7 | Dados históricos e versão usada em cada cadastro | CFG | C formulario_versao; I "formulários personalizados" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 8 | Permissões separadas para consultar, editar, publicar, restaurar | CFG | C permissions.ts; I "permissões separadas" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 9 | Sem código arbitrário e avisos protegidos | CFG | C escape no servidor, iframe sandbox; I "modelos de e-mail: texto próprio... sem marcação" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |

## Supercomando 08


| § | Requisito | Mód. | Evidência (05/11) | Classificação em 05/11 | Situação em 06/11 | Observação em 06/11 |
|---|---|---|---|---|---|---|
| 1 | Envio pela solicitação: destinatários, assunto, modelo, anexos, conferência, confirmar ou cancelar | COM | E "e-mail com anexo: conferir, confirmar"; I "envio: permissão, confirmação" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | Com transporte simulado |
| 2 | "Enviar passagem por e-mail": dados, bilhete, modelo, conferência | COM | E "passagem: dados do voo preenchidos"; I "passagem: dados automáticos" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | Simulado |
| 3 | Anexos: vários, nome, tamanho, remover, limite, validação | COM | I "anexos: removido ou alterado"; E "e-mail com anexo" | IMPLEMENTADO PARCIALMENTE | **PARCIALMENTE RESOLVIDO** | Substituir anexo sem teste específico |
| 4 | Envio nos demais módulos | COM | I "almoxarifado: só quem administra envia"; C CommunicationsPanel | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 5 | Histórico, detalhes, reenvio, situações distintas | COM | E "reenviar sem perder o anterior"; I "falhas" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 6 | Indicador de bilhete sem mudar status | COM | I "indicador... o status não muda" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 7 | Modelos próprios, limites e formatos pela tela | COM | I "modelos: a administração cria"; E "limites da comunicação" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 7 | Conta institucional e permissões de envio por perfil | COM | C remetente só por variável de ambiente; communications:send individual | IMPLEMENTADO PARCIALMENTE | **PARCIALMENTE RESOLVIDO** | P-14 |
| 8 | Segurança e LGPD | COM | I "sem CPF"; anexos sem link público | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 9 | Envio real por provedor autorizado | COM | C transports.ts | BLOQUEADO POR DEPENDÊNCIA | **BLOQUEADO POR DEPENDÊNCIA EXTERNA** | P-05 |

## Supercomando 09


| § | Requisito | Mód. | Evidência (05/11) | Classificação em 05/11 | Situação em 06/11 | Observação em 06/11 |
|---|---|---|---|---|---|---|
| 2 | Três setores cadastráveis | DEM | E "o administrador configura setores" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 2.1 | Visões: setor, individual, compartilhada, consolidada | DEM | V abas; E "painel com dados reais"; E "setor colaborador" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 2.2 | Perfis, conforme a Matriz Definitiva de 04/11 e o ajuste de edição | DEM | I "matriz definitiva"; E servidor, chefe, diretor, administrador | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | Substitui Colaborador, Responsável e Gestor do texto original |
| 2.3 | Demandas restritas fora de lista, pesquisa, relatório e API | DEM | I "demanda restrita não aparece"; E "demanda restrita" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 3 | Áreas internas | DEM | V demandas-painel: 7 abas | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 4 | Painel com indicadores, listas e filtros reais | DEM | I "painel e relatórios"; V demandas-painel | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 5 | Formulário completo, número único, rascunho, prioridades, status | DEM | I "cadastro individual e compartilhado"; I "rascunho"; E "cria uma demanda compartilhada" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 5.3 | Suspensão com justificativa e terceiros identificados | DEM | I "status, suspensão, terceiros" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 6.1 | Frequências e intervalo | DEM | U recurrence; I "frequências semanal e quinzenal" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | Mensal, bimestral, trimestral e anual via unidade e intervalo |
| 6.2 | Duas datas no mês e dias da semana | DEM | I "recorrência mensal com duas datas"; E "recorrência mensal com duas datas" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 6.3 | Encerramento sem data, quantidade, data | DEM | I "encerramento por data"; I "pular a última data de uma quantidade" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 6.4 | Ocorrências independentes, vínculo preservado | DEM | I "gera demandas independentes" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 6.5 | Editar uma ou futuras, suspender, retomar, cancelar, pular | DEM | I "suspender, retomar, pular, cancelar e editar" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 6.6 | Geração no backend sem duplicar; meses e bissextos | DEM | U recurrence; I "reprocessar não duplica" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | Worker exige produção ou variável (P-11) |
| 7 | Compartilhadas: setores, atividades e prazos por colaborador | DEM | E "quem é de setor colaborador também edita"; C atividade e prazo | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 8 | Subtarefas, percentual, conclusão não automática | DEM | E "cria etapas e impede a conclusão com etapa aberta" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 8 | Anexos nas subtarefas | DEM | C API aceita etapa; uploadDemandAttachment na tela não envia | IMPLEMENTADO PARCIALMENTE | **AGUARDANDO HOMOLOGAÇÃO REAL** | P-15 corrigido: a tela envia a etapa. I "anexos: validação..." (etapa válida, inválida e de outra demanda); E demandas "cria etapas" anexa pela tela |
| 9 | Comentários, providências, menções, histórico | DEM | I "comentários, menções"; I "histórico registra cada alteração" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 10 | Anexos: criação, depois, ver, baixar, validação | DEM | I "anexos: validação, acesso, download"; E "com colaborador e anexo" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 11 | Conclusão e reabertura | DEM | E "conclui, reabre com justificativa" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 12 | Agenda em dia, semana, mês, setor, individual, consolidada | DEM | I "agenda individual, por setor e consolidada"; E "agenda em mês, semana e dia" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 13 | Notificações e lembretes sem repetição | DEM | I "alertas de prazo chegam uma vez"; C 10 tipos | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | E-mail só registrado como preferência; era "prever" |
| 14 | Categorias personalizáveis | DEM | I "categoria desativada sai dos formulários" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 15 | Pesquisa, filtros combinados, ordenação | DEM | I "filtros combinados e ordenação"; E "pesquisa: filtros combináveis" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 16 | Lista, Kanban, calendário, minhas, setor, Diretoria | DEM | E "quadro: mover pelo controle"; E "filtros e visualização em lista" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 17 | Relatórios com PDF e Excel | DEM | E "exportação em PDF e Excel"; U xlsxDocument | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 18 | Vínculo com módulos sem alterar origem | DEM | I "vínculo com outros módulos" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 19 | Azul nos elementos principais, amarelo em destaques | VIS | V demandas-painel: primário amarelo, azul pontual | DIVERGENTE DA ORIENTAÇÃO | **BLOQUEADO POR DEPENDÊNCIA EXTERNA** | P-18: decisão da responsável sobre o azul |
| 20 | Segurança, auditoria, LGPD | DEM | I "a sessão é a única identidade"; E "as alterações ficam na auditoria" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 21 | Persistência real, sem localStorage | DEM | E "o que foi gravado continua ao sair e entrar" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 22 | Critérios de aceite do módulo | DEM | Testes de demandas e permissões; acesso simultâneo: "alteração simultânea" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |

## Supercomando 10*


| § | Requisito | Mód. | Evidência (05/11) | Classificação em 05/11 | Situação em 06/11 | Observação em 06/11 |
|---|---|---|---|---|---|---|
| 3 | Aprovação define vínculos pela tela, editáveis, auditados | ORG | I "aprovação define lotação"; E "a aprovação pela tela define" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 4 | Acesso de integrantes da DA e da SLM | ORG | I "não há outros níveis de acesso" | DIVERGENTE DA ORIENTAÇÃO | **BLOQUEADO POR DEPENDÊNCIA EXTERNA** | Confirmar que a Matriz Definitiva substitui o item |
| 4 | Administrador sem setor consulta tudo | ORG | E "administrador: consulta tudo" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 5 | Configuração de setores, chefias, gestores | ORG | E "diretor: configura setores" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 7 | Histórico preservado ao retirar | ORG | I "retirar de um setor preserva" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |

## Supercomando 11*


| § | Requisito | Mód. | Evidência (05/11) | Classificação em 05/11 | Situação em 06/11 | Observação em 06/11 |
|---|---|---|---|---|---|---|
| 2-3 | Perfil Motorista e portal próprio | POR | E "login: o motorista entra direto no portal"; V motorista-viagens | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 4 | Só as próprias viagens, por situação | POR | I "isolamento"; E "viagens: cada motorista" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 5-6 | Iniciar e finalizar com horário do servidor, sem duplicar | POR | I "iniciar"; I "dois inícios"; I "finalizar" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 7 | Ocorrências com anexo | POR | I "ocorrências: da viagem certa" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 8 | Histórico individual | POR | I "histórico individual" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 9 | Referência de jornada que identifica, sem impedir finalização | POR | I "a referência das 7h às 19h" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 10 | Integração com a Frota | POR | E "iniciar: ... reflete na Frota" | IMPLEMENTADO PARCIALMENTE | **PARCIALMENTE RESOLVIDO** | Hodômetro não alimenta km do veículo (P-23) |
| 11 | Notificações ao motorista | POR | I "avisos"; E "avisos" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 12 | Bloqueios no backend | POR | I "o motorista não alcança nenhuma área"; E "rotas e APIs" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |

## Supercomando 12*


| § | Requisito | Mód. | Evidência (05/11) | Classificação em 05/11 | Situação em 06/11 | Observação em 06/11 |
|---|---|---|---|---|---|---|
| 3 | Jornada editável sem efeito retroativo | POR | I "jornada: mudar não reescreve" | IMPLEMENTADO PARCIALMENTE | **PARCIALMENTE RESOLVIDO** | Jornada noturna não é aceita (P-23) |
| 4-5 | Execução e tipos de ocorrência editáveis | POR | I "informações obrigatórias"; I "tipos de ocorrência" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 6 | Regras de notificação | POR | I "notificações ao motorista"; I "notificações à equipe" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 7 | Ativar e desativar sem enfraquecer segurança | POR | I "nenhuma configuração abre viagens de terceiros" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 8 | Configurações de visualização | POR | E "visualização: cartão, avisos" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | — |
| 9 | Persistência e histórico no banco | POR | I "persistência e histórico" | IMPLEMENTADO E VALIDADO | **AGUARDANDO HOMOLOGAÇÃO REAL** | Bloco editado por dois: vale o último |
