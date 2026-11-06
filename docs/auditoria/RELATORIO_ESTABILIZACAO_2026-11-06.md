# Relatório de estabilização e preparação para homologação

> **Atualização (06/11, tarde):** a pré-migração do banco real, com leitura, backup, ensaio sobre a cópia e o ponto de autorização, está em `PRE_MIGRACAO_2026-11-06.md`. O roteiro da SLM está em `docs/ROTEIRO_HOMOLOGACAO_SLM.md`. O restante deste relatório descreve o estado da manhã de 06/11.

| | |
|---|---|
| **Data** | 06/11/2026 |
| **Referência** | Auditoria geral de 05/11/2026 (`RELATORIO_AUDITORIA_GERAL.md`, parecer REPROVADO), preservada sem alteração |
| **Branch** | `integracao/cadastro-e-permissoes`, a partir do commit `476af8d` |
| **Matriz** | `MATRIZ_REQUISITOS_2026-11-06.md` (181 requisitos, mais 20 complementares) |
| **Documentos novos** | `docs/PRODUCAO.md`, `docs/COMPARACAO_SISTEMA_ANTIGO.md`; seção "Cópia externa e recuperação" em `docs/BACKUP_E_MIGRACOES_SUPABASE.md` |

## Parecer final: APROVADO COM RESTRIÇÕES DOCUMENTADAS

**Para iniciar a homologação. Não está aprovado para produção.**

O único problema crítico (P-00) está resolvido, e os problemas altos que dependiam só de código foram corrigidos e comprovados por teste (P-08) ou preparados e testados em banco descartável (P-02). Todos os testes automatizados passam. Os itens que restam dependem de autorização, credenciais, infraestrutura ou decisão da responsável, e estão listados com o que falta em cada um.

**O que impede a produção:** as migrações 002 a 018 não estão no banco real (P-01), e por isso a correção de privilégios (P-02) também não; e-mail e Google Calendar nunca funcionaram de verdade (P-05); não há ambiente de produção (P-11); não há cópia externa nem rotina automática de backup (P-10); a paridade com o sistema antigo não foi comprovada (P-06); e nenhuma pessoa da SLM testou os fluxos.

**Restrições da homologação:** ela precisa de um banco com as migrações aplicadas (o real, com autorização, ou um de homologação providenciado pela TI); e-mails e calendário seguem simulados até a homologação própria de cada integração; a comparação com o sistema antigo é feita durante a homologação, com o roteiro de `COMPARACAO_SISTEMA_ANTIGO.md`.

## Limites desta etapa

- **Banco real:** não foi consultado nem alterado. Nenhuma migração foi aplicada. O que se diz dele vem da auditoria de 05/11.
- **Integrações:** nenhum e-mail foi enviado e nenhum evento foi criado no Google Calendar. Tudo foi testado com clientes falsos ou transporte simulado.
- **Publicação:** nada foi publicado nem contratado.
- **Arquivos apagados:** nenhum. `backups/`, `tmp-backup-perfis/` e `backend/.env` foram preservados.
- **Alteração fora do Git:** a permissão de `backend/.env` passou de `rw-rw-rw-` para `rw-------` (só o dono lê). O conteúdo não mudou.
- **Rede:** `npm audit` e a instalação de `@fontsource/inter` consultaram o registro do npm, enviando só nomes de pacotes.
- **Testes escritos pelo mesmo autor do código:** continuam sendo evidência de comportamento, não verificação independente nem aceite.
- **A API de desenvolvimento da responsável (porta 3000), se estiver ligada ao `tsx watch`,** reiniciou a cada arquivo salvo no backend. Ela já recebe as regras novas, inclusive a do P-08.

## 1. Auditoria inicial (antes de qualquer alteração)

| Verificação | Resultado |
|---|---|
| Branch | `integracao/cadastro-e-permissoes` |
| Alterações não registradas | Nenhuma. `git status` limpo |
| Local e remoto | `476af8d` nos dois (`git fetch` e `git rev-parse` conferidos) |
| Arquivos fora do Git | Só os ignorados: `backend/.env`, `backups/`, `tmp-backup-perfis/`, `backend/dist/`, `frontend/dist/`, `node_modules/` |
| Commits depois da auditoria | `6f76efc` (os 157 arquivos e as 88 alterações do P-00), `7efc2ff`, `fdc87dd`, `65b8d66` (P-24, P-03, pausa do P-10), `23b6569`, `476af8d` (documentos) |
| Suíte de base | `npm run verify` passou (299 unitários); `npm run test:integration` passou (283) |

### Rastreabilidade: problemas da auditoria de 05/11

| ID | Problema | Situação em 05/11 | Situação encontrada em 06/11, antes das correções | Evidência |
|---|---|---|---|---|
| P-00 | Sistema fora do Git | Crítico | **Resolvido** pelo commit `6f76efc`, já enviado | `git status` limpo; local igual ao remoto; `apply-migrations.cjs` e migrações 005 a 017 rastreados |
| P-01 | 16 migrações pendentes no banco real | Alto | Permanece (não pode ser aplicado sem autorização) | Memória da etapa anterior; nada aplicado desde então |
| P-02 | Privilégios públicos em 8 tabelas | Alto | Permanece | Nenhuma migração tratava as tabelas antigas |
| P-03 | Sequências novas abertas | Médio | **Resolvido** em `fdc87dd` | `test:migrations` reprova sequência nova aberta |
| P-04 | `PASSENGER_DATA_KEY` e `ATTACHMENTS_DIR` ausentes | Alto | Permanece; sem validação de formato nem conferência de ambiente | `npm run config:check` (criado nesta etapa) confirma a ausência |
| P-05 | Integrações só simuladas | Alto | Permanece; o e-mail de recuperação de senha não tinha teste e não bloqueava endereços de teste | Leitura de `auth/email.ts` |
| P-06 | Paridade com o antigo | Alto | Permanece; não há material do antigo em lugar nenhum | Busca no repositório e no histórico das sessões |
| P-07 | Almoxarifado recebe pedidos? | Médio | Permanece, decisão da responsável | — |
| P-08 | Administrador fora da SLM agenda e edita previsão | Alto | Permanece | `isEligibleForRestrictedPermission` liberava `requests:schedule` a qualquer administrador; `warehouse:manage` vinha do perfil |
| P-09 | Sem lista de domínios | Médio | Permanece, depende da lista oficial | — |
| P-10 | Backup só no Codespace | Alto | Parcial: a pausa já existia (`65b8d66`). Faltavam cópia externa, procedimento de recuperação e **qualquer backup dos anexos** | `scripts/` não tinha cópia de `ATTACHMENTS_DIR` |
| P-11 | Sem ambiente de produção | Alto | Permanece | — |
| P-12 | Sem campo do tipo Anexo | Médio | Permanece | `formRules.ts` |
| P-13 | Obrigatoriedade de campo fixo só na tela | Médio | **Já resolvido no código** (`missingStandardField`) e testado; o Plano estava desatualizado | Teste "sala ficou obrigatória" |
| P-14 | Remetente e envio por perfil | Médio | Permanece, depende da TI | — |
| P-15 | Anexo em etapa não enviado pela tela | Médio | Permanece | `uploadDemandAttachment` sem etapa |
| P-16 | Base legal e retenção | Médio | Permanece, área competente | — |
| P-17 | Cabeçalhos globais e fonte do Google | Médio | **Parcialmente incorreto na auditoria:** a API já aplica helmet a todas as respostas. A fonte do Google permanecia | `app.ts` usa `securityHeaders()` desde `cb1e4bd` |
| P-18 | Cores e CSS legado | Baixo | Permanece, decisão sobre o azul | — |
| P-19 | Configurações em página única | Baixo | Permanece | — |
| P-20 | Sem antivírus | Médio | Permanece, TI | — |
| P-21 | Sem teste com leitor de tela | Baixo | Permanece | — |
| P-22 | `strict` no frontend, limitador em memória, pacote grande, itens sem uso | Médio/Baixo | Frontend já compilava com `strict` (padrão do TypeScript 6), sem declaração explícita; o resto permanece | `tsc --strict` sem erros |
| P-23 | Limites da Frota e do portal | Baixo | Permanece, decisões | — |
| P-24 | Saída 1 ambígua | Médio | **Resolvido** em `7efc2ff` | Códigos 0 a 5 documentados e testados |
| P-25 | Contas fictícias no banco real | Médio | Permanece, decisão e banco real | — |
| P-26 | Documentos desatualizados | Baixo | Permanece | Plano falava em "002 a 011" |

### Problemas novos encontrados nesta etapa

| ID | Problema | Gravidade | Situação |
|---|---|---|---|
| N-01 | `backend/.env` legível por qualquer usuário da máquina (`rw-rw-rw-`) | Média | Corrigido: `chmod 600` |
| N-02 | Migrações 002 e 004 sem script de reversão | Média | Corrigido: `002_password_recovery.rollback.sql` e `004_flight_passengers.rollback.sql`, que recusam quando perderiam dados, testados |
| N-03 | Anexos sem nenhum backup (ficam fora do `pg_dump`) | Alta | Corrigido: `backup:attachments` e `backup:attachments:verify`, testados |
| N-04 | Tentativa negada de agendar, atribuir motorista ou alterar previsão não ficava registrada | Média | Corrigido: recusa auditada como `access.denied` |
| N-05 | `ATTACHMENTS_DIR` dentro da pasta do projeto era aceita (risco de ir ao Git ou a pasta publicada) | Média | Corrigido: a API recusa, e `config:check` aponta |
| N-06 | E-mail de recuperação de senha sem teste, sem bloqueio de domínio de teste e repassando qualquer link | Média | Corrigido: cliente injetável, bloqueio, link só https (ou http local), 5 testes |
| N-07 | Status "Rejeitada" da versão anterior aparece como "Cancelado" | Baixa | Documentado em `COMPARACAO_SISTEMA_ANTIGO.md`, decisão da área |

## 2. Arquivos

**Preservados sem alteração:** `backups/` (cópias de 03/11 e 04/11, com dados reais), `tmp-backup-perfis/`, `backend/.env` (só a permissão mudou), os relatórios e a matriz de 05/11, os Supercomandos (fora do repositório) e todas as migrações 001 a 017, exceto um comentário na 004.

**Novos:**

| Arquivo | Para quê |
|---|---|
| `backend/database/schema/018_public_api_privileges.sql` e `.rollback.sql` | P-02 |
| `backend/database/schema/002_password_recovery.rollback.sql`, `004_flight_passengers.rollback.sql` | N-02 |
| `backend/src/config/environmentCheck.ts` e `.test.ts`; `backend/src/cli/check-environment.ts` | P-04: `npm run config:check` |
| `backend/src/middleware/requireAuditedPermission.ts` | N-04 |
| `backend/src/auth/email.test.ts` | P-05, N-06 |
| `scripts/backup-attachments.cjs`, `verify-attachments-backup.cjs`, `test-attachments-backup.cjs` | P-10, N-03 |
| `docs/PRODUCAO.md`, `docs/COMPARACAO_SISTEMA_ANTIGO.md` | P-11, P-06 |
| `docs/auditoria/MATRIZ_REQUISITOS_2026-11-06.md`, este relatório | Fase 5 |

**Modificados:** `backend/src/auth/permissions.ts` (P-08), `backend/src/attachments/storage.ts` (N-05), `backend/src/auth/email.ts` (N-06), `backend/src/database/authAuditRepository.ts`, `backend/src/routes/requests.ts`, `driver.ts`, `warehouse.ts` (N-04), `backend/src/server.ts` (conferência do ambiente ao iniciar), `backend/database/schema/004_flight_passengers.sql` (só comentário), `scripts/apply-migrations.cjs` (018 e conferência geral de exposição), `scripts/test-apply-migrations.cjs`, `test-backup-restore.cjs`, `run-browser-tests.cjs`, testes de integração (cenários do P-08 e negativos), `e2e/demands.e2e.cjs` (P-15), `frontend/src/main.tsx`, `App.css`, `vite.config.ts`, `package.json` (P-17), `frontend/src/api/demandsApi.ts`, `pages/demands/DemandDetail.tsx` (P-15), `frontend/tsconfig.app.json`, `tsconfig.node.json` (P-22), `package.json` (scripts), `backend/.env.example`, `docs/BACKUP_E_MIGRACOES_SUPABASE.md`, `REQUISITOS_FUNCIONAIS.md`, `PLANO_DESENVOLVIMENTO_INTEGRAL.md`.

**Versionamento:** todos os arquivos acima foram registrados em commits separados por assunto, na mesma branch, e enviados ao GitHub. Nenhum arquivo com dados reais ou segredo foi incluído.

**Varredura de segredos e dados pessoais** nos arquivos versionados: nenhuma chave do Resend, chave privada, token, JWT ou URL de banco com senha real. Endereços de e-mail e CPFs encontrados são fictícios (domínios reservados, `123.456.789-09`). Os endereços `*.pooler.supabase.com` que aparecem são fictícios (`aws-0-exemplo`) e usados para provar que os testes recusam banco remoto.

## 3. Correções realizadas

| ID | Correção | Arquivos | Testes | Situação |
|---|---|---|---|---|
| P-02 | Migração 018: retira de `anon`, `authenticated`, `service_role` e `PUBLIC` todo privilégio em tabelas, sequências e funções de `public`; fixa `search_path` das 2 funções antigas. Reversão devolve exatamente o estado anterior. O script passa a reprovar qualquer objeto de `public` aberto, e não só os novos | `018_*.sql`, `apply-migrations.cjs` | `test:migrations`: antes, `anon` tem `TRUNCATE` em `materials`; depois, os três papéis recebem "permission denied" ao ler, inserir, apagar, esvaziar e numerar, executando como cada papel; reversão e reaplicação; reabertura detectada | **AGUARDANDO HOMOLOGAÇÃO REAL** (aplicar exige autorização) |
| P-04 | Conferência das variáveis sem mostrar valores: chave de 32 bytes em base64, pasta absoluta fora do projeto, gravável e `700`, Resend, pepper, Google, https em produção. Comando `npm run config:check` e registro no log ao iniciar a API. Exemplo de configuração atualizado | `config/environmentCheck.ts`, `cli/check-environment.ts`, `server.ts`, `storage.ts`, `.env.example` | 7 testes unitários, inclusive "nunca devolve valores" | **BLOQUEADO POR DEPENDÊNCIA EXTERNA** (gerar e guardar a chave e definir a pasta no ambiente real) |
| P-05 | Recuperação de senha com cliente injetável, bloqueio de domínios de teste, link só https, erro do provedor sem repasse. O envio automático já tinha testes com cliente falso do Resend e do Google | `auth/email.ts` | 5 testes novos; 32 já existentes em `integrations.test.ts` | **BLOQUEADO POR DEPENDÊNCIA EXTERNA** (credenciais e autorização para envio real) |
| P-06 | Comparação do que é verificável (versão web anterior), registro do que o histórico diz do antigo e roteiro para a área | `docs/COMPARACAO_SISTEMA_ANTIGO.md` | — | **BLOQUEADO POR DEPENDÊNCIA EXTERNA** |
| P-08 | `requests:schedule` e `warehouse:manage` exigem equipe SLM também para o Administrador, nem com concessão gravada no banco. Recusas auditadas. Administração do sistema mantida | `permissions.ts`, `requireAuditedPermission.ts`, rotas | U: 2 testes reescritos e 1 novo; I: administrador externo recusado em agendar (2 tentativas, nada muda, 2 registros `access.denied`), previsão, cadastro de material e mudança de status; concessão fora da equipe recusada (400); ao entrar na equipe, passa a poder | **RESOLVIDO E COMPROVADO** (vale no ambiente real quando esta versão for implantada) |
| P-10 | Backup e verificação dos anexos; procedimento de cópia externa cifrada, retenção, integridade e recuperação de banco e documentos | `scripts/*attachments*`, `BACKUP_E_MIGRACOES_SUPABASE.md` | `test:backup`: 7 cenários novos, inclusive adulteração e ligação simbólica | **PARCIALMENTE RESOLVIDO** (destino externo e agendador dependem da TI) |
| P-11 | Requisitos de hospedagem, banco, anexos, variáveis, HTTPS (com configuração de exemplo), monitoramento, atualização e checklist | `docs/PRODUCAO.md` | `config:check` em modo produção | **BLOQUEADO POR DEPENDÊNCIA EXTERNA** |
| P-13 | Nada a corrigir no código; Plano corrigido | `PLANO_DESENVOLVIMENTO_INTEGRAL.md` | Teste existente | **PARCIALMENTE RESOLVIDO** (exceção: campo fixo com regra condicional) |
| P-15 | A tela permite escolher a etapa do anexo e mostra a etapa na lista | `demandsApi.ts`, `DemandDetail.tsx` | I: etapa válida, inválida (400) e de outra demanda (404); E: anexa pela tela e confere a etapa | **RESOLVIDO E COMPROVADO** |
| P-17 | Fonte Inter servida pelo sistema (`@fontsource/inter` 5.2.8), CSP sem origem do Google; cabeçalhos do servidor de arquivos estáticos documentados | `main.tsx`, `App.css`, `vite.config.ts`, `PRODUCAO.md` | E2E com origens externas bloqueadas, 90 telas | **PARCIALMENTE RESOLVIDO** (cabeçalhos dos estáticos dependem do servidor de produção) |
| P-22 | `strict` declarado no frontend | `tsconfig.app.json`, `tsconfig.node.json` | `typecheck:frontend` | **PARCIALMENTE RESOLVIDO** (limitador compartilhado só se houver mais de uma instância; pacote e remoções aguardam decisão) |
| P-26 | Plano atualizado para 002 a 018 | `PLANO_DESENVOLVIMENTO_INTEGRAL.md` | — | **PARCIALMENTE RESOLVIDO** |
| N-01 a N-06 | Ver seção 1 | — | — | **RESOLVIDO E COMPROVADO** |

**Efeito do P-08 no ambiente real:** a migração 003 coloca todos os administradores fora da equipe SLM. Depois de migrar, marque "Equipe SLM" para cada administrador que opera pela SLM; sem isso, ele não agenda nem gerencia o Almoxarifado. Registrado em `BACKUP_E_MIGRACOES_SUPABASE.md`.

## 4. Migrações analisadas

Todas aplicadas em sequência e testadas em banco descartável com os papéis e privilégios automáticos do Supabase (`npm run test:migrations`) e no início de cada arquivo de integração.

| Migração | Depende de | Altera tabelas existentes | Operação destrutiva | Reversão | Observação |
|---|---|---|---|---|---|
| 002 recuperação de senha | 001 | Não | Não | **Nova** (recusa com código válido) | Só cria tabela |
| 003 acesso | 002 | Não (cria `auth_user_access`) | Não | Sim | Para com erro se houver operador ativo com escrita; todos os administradores ficam fora da SLM |
| 004 passageiros | 003 | Não | Não | **Nova** (recusa com passageiros ou com a 005) | CPF em texto se usada sozinha; a 005 cifra e para se houver passageiros |
| 005 módulos operacionais | 003, 004 | Sim (status de solicitações e pedidos) | Troca de `CHECK` de status, sem apagar dados | Sim | Valores antigos traduzidos na leitura |
| 006 integrações | 005 | Não | Não | Sim | — |
| 007 Central | 005, 006 | Sim (protocolo) | Não; `UPDATE` preenche o protocolo novo com gatilhos desligados | Sim (recusa com dados) | Numeração por ano e módulo |
| 008 anexos | 007 | Não | Não | Sim (recusa com dados) | — |
| 009 extensões | 007 | Não | Não | Sim (recusa com dados) | — |
| 010 monitoramento | — | Não | Não | Sim | — |
| 011 previsão | 005 | Sim (colunas novas) | Não | Sim (recusa com registros) | — |
| 012 transparência | 005, 006, 007 | Sim (colunas novas) | Não | Sim | — |
| 013 comunicações | — | Não | Não | Sim (recusa se interrompida) | — |
| 014 demandas | 005, 006, 007 | Sim (amplia `CHECK`) | Troca de `CHECK`, sem apagar dados | Sim | — |
| 015 estrutura | 014 | Não | Não | Sim | — |
| 016 portal | 015 | Sim (colunas e perfil `driver`) | Troca de `CHECK` | Sim (recusa com dados) | — |
| 017 configurações do portal | 016 | Sim | `UPDATE` grava o nome do tipo nas ocorrências; troca de `CHECK` por chave estrangeira | Sim (recusa com dados) | — |
| **018 privilégios** | 017 | Não | Não (só privilégios) | Sim (devolve o estado anterior) | Idempotente; nova nesta etapa |

**Conclusão:** nenhuma migração apaga dados. As alterações permanentes são as trocas de `CHECK` e os preenchimentos de 007 e 017, que só acrescentam valores. Cada uma roda em transação própria. Recuperação: reversão na ordem inversa, enquanto não houver dados que dependam dela; depois disso, só a restauração do backup feito na primeira etapa do script. **Nenhuma foi aplicada no banco real.**

## 5. Falhas encontradas durante o trabalho e corrigidas

| Falha | Causa | Correção |
|---|---|---|
| 16 testes de integração quebraram com o P-08 | Os cenários usavam a administradora fora da SLM para operar Almoxarifado e agenda, exatamente o que o P-08 proíbe | A administradora dos cenários passou a integrar a SLM; o administrador externo ganhou testes próprios, que esperam recusa |
| Ajuste anterior não teve efeito | A conta de teste é inserida direto no banco depois da 003, que só cria linha de acesso para as contas que já existiam; a atualização não alcançava nenhuma linha | Inserção com atualização (`ON CONFLICT`) |
| Teste novo das reversões 002 e 004 interrompeu a suíte completa | Depois de uma reversão recusada, a conexão de teste ficava com a transação do script aberta e abortada | O teste encerra a transação após cada recusa esperada; repetido, passou |
| Teste negativo de leitura como `anon` recebia outro erro | O banco descartável usa `row_security = off`, e o PostgreSQL recusa por RLS antes de checar o privilégio | O teste liga `row_security`, como a API do Supabase |
| Verificação dos anexos falhava ao extrair | Opção `--no-absolute-names` não existe no GNU tar | Conferência prévia da lista do pacote (sem caminho absoluto, `..`, ligação ou dispositivo) |
| Passo novo do E2E de Demandas (P-15) não achava o campo de arquivo | Seletor errado no teste: o elemento pai do título é o cabeçalho, não a seção de anexos | Seletor pela seção; o cenário de Demandas passou e o E2E completo foi repetido |
| Um teste unitário de portas falhou uma vez | Rodou ao mesmo tempo que o E2E, que ocupava a porta 3901 | Repetido sozinho depois: passou. Não é falha do sistema |

## 6. Testes executados

Execução final, depois de todas as alterações: `npm run test:all` até `test:backup`; `test:migrations` e `test:e2e` repetidos depois das duas correções de teste da seção 5.

| Comando | Resultado |
|---|---|
| `npm run typecheck:backend`, `typecheck:frontend` (agora com `strict` declarado), `lint:frontend` | Passou, sem erros |
| `npm run test:backend` (unitários, inclusive autenticação, autorização, API, anexos, e-mail) | Passou, 312 de 312 (eram 299; 13 novos) |
| `npm run build:backend`, `build:frontend` | Passou (aviso conhecido de pacote acima de 500 kB, P-22) |
| `npm run test:integration` (PostgreSQL descartável) | Passou, 283 de 283, com asserções novas de P-08, P-15 e auditoria |
| `npm run test:backup` (banco e anexos, dados fictícios) | Passou: banco (1 cenário) e anexos (7 cenários) |
| `npm run test:migrations` (002 a 018, papéis do Supabase) | Passou, 21 cenários (eram 8 na auditoria; 3 novos nesta etapa sobre a 018 e as reversões) |
| `npm run test:e2e` (navegador, portas isoladas, revisão visual em 3 tamanhos) | Passou, 139 cenários, nenhuma conexão para fora da máquina; 90 telas na revisão visual |
| `npm audit` e `npm --prefix frontend audit`, com e sem dependências de desenvolvimento | 0 vulnerabilidades |
| `npm run config:check` no `backend/.env` atual | Sem erros; 4 avisos: `PASSENGER_DATA_KEY`, `ATTACHMENTS_DIR`, Resend e `PASSWORD_RESET_PEPPER` ausentes |

**Nenhum teste foi desativado, pulado ou afrouxado.** Os testes alterados foram os que afirmavam o comportamento que o P-08 proíbe ("administrador sem SLM pode"); eles agora afirmam o contrário.

**Não realizados:** envio real de e-mail, Google Calendar real, migração no banco real, restauração sobre o Supabase, cópia em destino externo, aceite humano, leitor de tela, carga, navegadores além do Chromium, comparação com o sistema antigo.

## 7. Situação dos 181 requisitos

| Situação em 06/11 | 01 a 09 | 10 a 12 |
|---|---:|---:|
| AGUARDANDO HOMOLOGAÇÃO REAL | 147 | 17 |
| PARCIALMENTE RESOLVIDO | 16 | 2 |
| NÃO RESOLVIDO | 1 | 0 |
| BLOQUEADO POR DEPENDÊNCIA EXTERNA | 17 | 1 |
| **Total** | **181** | **20** |

Os 141 validados em 05/11 não foram tratados como homologados: passaram para AGUARDANDO HOMOLOGAÇÃO REAL. Seis subiram para essa situação nesta etapa, com evidência nova ou localizada: agendamento só pela SLM e Almoxarifado restrito à SLM (P-08), anexos em etapas (P-15), edição de itens do Almoxarifado, auditoria das novas operações e modelos mínimos de e-mail. O único NÃO RESOLVIDO é o campo do tipo Anexo nos formulários (P-12). Pontos verificados em especial:

| Tema | Situação |
|---|---|
| Central de notificações, linha do tempo, pesquisa global | Aguardando homologação real |
| Documentos e anexos | Aguardando homologação real; agora com etapa, backup próprio e pasta conferida. Antivírus bloqueado (P-20) |
| Motivos de reagendamento e cancelamento | Aguardando homologação real |
| Modelos de e-mail configuráveis e envio de anexos | Implementados e testados com transporte simulado; envio real bloqueado (P-05) |
| Agenda interna e Google Calendar | Agenda interna aguardando homologação; Google bloqueado (P-05) |
| Setores, andares e tipos de serviço | Aguardando homologação real |
| Controle de Demandas e recorrências | Aguardando homologação real; o processo de recorrência só liga sozinho em produção (P-11) |
| Permissões por setor e perfil | Aguardando homologação real; P-08 corrigido |
| Dados pessoais | CPF cifrado e mascarado, aguardando a chave real (P-04); base legal e retenção bloqueadas (P-16) |
| Manutenção, Frota, Passagens e Almoxarifado | Aguardando homologação real; P-07 e P-23 aguardam decisão |

## 8. Dependências externas

| # | Dependência | De quem | Destrava |
|---|---|---|---|
| 1 | Autorização para aplicar 002 a 018 no banco real, depois do backup em duas etapas | Responsável | P-01, P-02, todos os módulos no ambiente real |
| 2 | Local da cópia externa cifrada e rotina automática de backup | Responsável e TI | P-10 |
| 3 | Ambiente de produção: servidor, domínio, HTTPS, proxy, monitor externo | TI | P-11, P-17 (estáticos) |
| 4 | `PASSENGER_DATA_KEY` gerada no servidor, com cópia em cofre; pasta de anexos | TI e responsável | P-04 |
| 5 | Conta Resend com domínio verificado, `PASSWORD_RESET_PEPPER`, autorização para envio | TI e responsável | P-05 (e-mail, recuperação de senha) |
| 6 | Conta de serviço e calendários Google, e decisão sobre convivência com o antigo | TI e responsável | P-05 (agenda) |
| 7 | Acesso de leitura ao sistema antigo ou sessão com a área usuária | Responsável e SLM | P-06 |
| 8 | Lista oficial de domínios de e-mail | Instituição | P-09 |
| 9 | Base legal, retenção e responsáveis pelos dados | Área competente | P-16 |
| 10 | Antivírus para anexos | TI | P-20 |
| 11 | Decisões: Almoxarifado recebe pedidos (P-07), azul (P-18), limites da Frota (P-23), contas fictícias (P-25), "Rejeitada" (N-07), Matriz Definitiva no item 4 do SC10 | Responsável | Itens correspondentes |
| 12 | Marcar "Equipe SLM" nos administradores que operam pela SLM, depois da migração | Responsável | P-08 no ambiente real |

## 9. Checklist de homologação

| # | Item | Situação |
|---|---|---|
| 1 | Código no Git, local igual ao remoto | Pronto |
| 2 | Suíte completa aprovada no commit a homologar | Pronto (seção 6) |
| 3 | Backup do banco real em duas etapas, com cópia externa e SHA-256 conferido no destino | Pendente (dep. 1 e 2) |
| 4 | Migrações 002 a 018 aplicadas, com autorização; `migrations:check` sem pendências | Pendente (dep. 1) |
| 5 | `config:check` sem erros no ambiente de homologação | Pendente (dep. 4) |
| 6 | Equipe SLM e concessões definidas (agendar, Almoxarifado, Central, CPF, em nome de outro setor) | Pendente (dep. 12) |
| 7 | Roteiro por perfil (Administrador fora e dentro da SLM, Operador SLM, Solicitante, Motorista, Diretoria) executado por pessoas da SLM | Pendente |
| 8 | Fluxos completos de Manutenção, Frota, Passagens, Almoxarifado e Demandas nas contas reais | Pendente |
| 9 | Comparação com o sistema antigo (`COMPARACAO_SISTEMA_ANTIGO.md`, seção 5) | Pendente (dep. 7) |
| 10 | Homologação do e-mail e da recuperação de senha (`INTEGRACOES_E_AUTOMACOES.md`) | Pendente (dep. 5) |
| 11 | Decisões da dependência 11 registradas | Pendente |
| 12 | Aceite formal da área usuária | Pendente |

## 10. Checklist de produção

Em `docs/PRODUCAO.md`, seção 10 (15 itens). Resumo: hospedagem, domínio e HTTPS, proxy com cabeçalhos, processo gerenciado, pasta de anexos, segredos em cofre, conta Resend, `config:check` sem erros, backup e cópia externa, migrações, suíte aprovada, homologação do e-mail, agendamento de backups e monitor, aceite da SLM, decisão sobre a convivência com o sistema antigo. **Nenhum item de infraestrutura está pronto.**

## 11. Resumo para a responsável

**O que foi corrigido:**
- O código está todo no GitHub, e as correções desta etapa também.
- Um administrador que não é da SLM não consegue mais agendar, atribuir motorista, mexer no Almoxarifado nem alterar a previsão de entrega, e cada tentativa fica registrada. Ele continua administrando usuários, configurações e auditoria.
- Foi criada a migração que fecha as 8 tabelas antigas ao acesso público do Supabase. Ela está testada, mas **ainda não foi aplicada**, porque depende da sua autorização.
- O sistema agora confere sozinho se a chave dos passageiros e a pasta de anexos estão corretas, sem mostrar os valores.
- Os anexos passaram a ter backup e teste de restauração, e há um passo a passo para guardar as cópias fora do Codespace e recuperar banco e documentos.
- Anexos podem ser ligados a uma etapa da demanda pela tela.
- A fonte do sistema não depende mais do Google.
- Há um guia completo do que a TI precisa para colocar o sistema no ar.

**O que funciona:** todos os módulos passaram em todos os testes automatizados, em ambiente de teste. Isso não substitui o teste das pessoas da SLM.

**O que ainda falta:** aplicar as migrações no banco real (com sua autorização), definir onde o sistema vai rodar, configurar e-mail e chave dos passageiros, guardar o backup fora do Codespace, comparar com o sistema antigo junto com a SLM e tomar as decisões listadas na seção 8.

**O que impede a publicação:** banco real sem as migrações, e-mail nunca testado de verdade, ausência de servidor de produção e de backup externo, e falta do aceite da SLM. Nenhum desses pontos se resolve só com código.
