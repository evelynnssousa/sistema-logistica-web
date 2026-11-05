# Relatório da auditoria geral do sistema SLM

> **Atualização:** P-03 (sequências novas), a pausa do backup em P-10 e o código de saída em P-24 foram corrigidos depois desta auditoria, nos commits `7efc2ff`, `fdc87dd` e `65b8d66`. O restante do relatório descreve o estado de 05/11/2026, antes deles.

| | |
|---|---|
| **Data** | 05/11/2026 |
| **Revisão** | Branch `integracao/cadastro-e-permissoes`, commit `cb1e4bd`, mais 88 arquivos alterados e 157 não rastreados, que são a maior parte do sistema |
| **Escopo** | Supercomandos 01 a 09. Os 10 (Estrutura organizacional), 11 e 12 entram como complemento |
| **Documentos** | `MATRIZ_CONFORMIDADE.md` e `PLANO_DE_CORRECOES.md`, nesta pasta |

## I. Parecer final: REPROVADO

Há um problema crítico e oito altos em aberto, e nenhuma integração externa foi comprovada. O motivo não é o código ter falhado nos testes: toda a suíte passou. O sistema só foi comprovado em ambiente descartável e ainda não está em condição de operar no ambiente real.

## Limites desta auditoria

- **Fontes:** os textos originais de 01 a 12 foram recuperados do histórico das sessões. **O Supercomando 13 não foi localizado.** O título pede "01 a 13" e o corpo pede "01 a 09". Se o 13 existir, é preciso enviá-lo.
- **Numeração:** este comando se chama "Supercomando 10", número que já pertence à Estrutura organizacional.
- **Sem aceitação humana:** ninguém da SLM testou os fluxos. Os testes foram escritos junto com o código, pelo mesmo autor. São evidência forte de comportamento, mas não uma verificação independente.
- **Não cliquei botão por botão.** O percurso de telas é o dos 139 cenários de navegador, mais a leitura de código direcionada aos pontos de risco.
- **Revisão visual:** 170 capturas foram geradas, e olhei 7. As demais passaram só pelas verificações automáticas de rolagem, contraste, nome acessível e alvo.
- **Consultas anteriores ao banco real:** na revisão pré-migração pedida antes deste comando, consultei o banco real somente em transação de leitura. Esta auditoria não voltou a se conectar a ele e usa aqueles resultados.
- **Efeitos colaterais desta auditoria:** criei esta pasta. Os testes regeneraram `backend/dist` e `frontend/dist`, que o Git ignora. `npm audit` enviou a lista de dependências ao registro do npm. Nenhum arquivo funcional, e-mail, evento ou dado real foi alterado.

## A. Resumo executivo

**Situação geral:** a implementação é ampla e coerente, e nenhuma funcionalidade testada apresentou erro. Os riscos estão fora do código testado: nada disso está no Git nem no banco real, faltam credenciais e infraestrutura, e há regras sem decisão.

| Classificação (Supercomandos 01 a 09) | Quantidade |
|---|---:|
| Requisitos identificados, consolidados | **181** |
| Implementados e validados em ambiente descartável | 141 |
| Implementados parcialmente | 19 |
| Implementados, mas não validados | 4 |
| Não implementados | 1 |
| Implementados com erro | 0 |
| Divergentes da orientação | 4 |
| Bloqueados por dependência | 12 |

"Validado" tem sentido limitado: banco descartável, e-mail e calendário simulados, sem aceite da área. O número 181 não conta cada marcador dos textos, porque itens com a mesma evidência foram reunidos.

## B. Resultado por Supercomando

| Supercomando | Total | Validados | Parciais | Não validados | Não impl. | Divergentes | Bloqueados |
|---|---:|---:|---:|---:|---:|---:|---:|
| 01 Desenvolvimento integral | 36 | 29 | 3 | 0 | 0 | 1 | 3 |
| 02 Modernização visual | 15 | 10 | 4 | 1 | 0 | 0 | 0 |
| 03 Integrações | 18 | 13 | 0 | 0 | 0 | 0 | 5 |
| 04 Central SLM e evolução | 33 | 24 | 6 | 1 | 0 | 1 | 1 |
| 05 Previsão de entrega | 6 | 4 | 0 | 0 | 0 | 1 | 1 |
| 06 Justificativas | 14 | 11 | 1 | 1 | 0 | 0 | 1 |
| 07 E-mails e formulários | 18 | 14 | 2 | 1 | 1 | 0 | 0 |
| 08 Central de comunicação | 10 | 7 | 2 | 0 | 0 | 0 | 1 |
| 09 Controle de Demandas | 31 | 29 | 1 | 0 | 0 | 1 | 0 |
| **Total** | **181** | **141** | **19** | **4** | **1** | **4** | **12** |
| *Complemento: 10, 11 e 12* | *20* | *17* | *2* | *0* | *0* | *1* | *0* |

O detalhe de cada requisito está em `MATRIZ_CONFORMIDADE.md`.

## C. Funcionalidades aprovadas

Aprovadas apenas nas condições descritas acima, com testes aprovados nesta auditoria:

- **Acesso:** login, sessão, logout, CSRF, aprovação de cadastro, perfis, permissões individuais, proteção do último administrador, senhas com Argon2id.
- **CPF:** cifrado no banco, mascarado na API, completo só com concessão individual na SLM, auditado, e negado se a auditoria falhar.
- **Manutenção, Frota e Passagens:** fluxos, status, histórico, justificativas, devolução, duplicidade, cotações, veículos, equipamentos.
- **Almoxarifado:** pedidos, inventário, estoque interno, atendimento parcial, previsão e entrega.
- **Plataforma:** protocolo único, linha do tempo, pesquisa, anexos, agenda interna e conflitos, notificações, relatórios, Central SLM, parâmetros.
- **E-mails, sem envio real:** fila, idempotência, tentativas, reprocessamento, modelos com versões, formulários com rascunho e publicação.
- **Controle de Demandas:** a Matriz Definitiva dos quatro perfis, recorrência, restritas, etapas, comentários, agenda, relatórios em PDF e Excel.
- **Portal do Motorista e suas configurações:** isolamento, início e fim, ocorrências, correção autorizada, jornada editável.

## D. Funcionalidades com pendências e problemas

### Crítico

**P-00. O sistema existe quase só no Codespace**
- **Requisito:** SC04 §16 e diretriz final, preservar o que existe. O próprio SC01 proibia commit, então isso é uma consequência do processo, não uma desobediência.
- **Problema:** 157 arquivos não rastreados e 88 alterados, além de um commit não enviado. Inclui as migrações 005 a 017, as reversões, `apply-migrations.cjs`, a maioria das rotas e todos os módulos novos.
- **Evidência:** `git status`; `git ls-files` não encontra `scripts/apply-migrations.cjs`.
- **Consequência:** perder o Codespace perde o sistema e também os scripts de reversão do banco.
- **Correção e critério:** autorizar commit e push. Pronto quando a branch remota for igual à local.

### Altos

**P-01. O banco real não tem as migrações**
- **Requisito:** SC01 §9, funcionalidade real. A não aplicação segue as ordens recebidas.
- **Problema:** `migrations:check` mostra **16 pendentes (002 a 017), não 12**. O banco real tem 11 tabelas, e as de operação estão vazias.
- **Consequência:** no ambiente real, além de login e cadastro, os módulos novos respondem 503 ou ficam ocultos.
- **Arquivos:** `backend/database/schema/`, `scripts/apply-migrations.cjs`. O script aplica todas e não permite parar na 013.
- **Correção e critério:** decidir o conjunto e aplicar com autorização, depois da Fase 1 do plano.

**P-02. Papéis públicos têm privilégios amplos em tabelas operacionais**
- **Requisito:** SC01 §4 e §7, SC09 §20.
- **Problema:** `anon`, `authenticated` e `service_role` têm SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES e TRIGGER em 8 tabelas (`materials`, `material_requests`, `material_request_items`, `request_forms`, `request_history`, `service_requests`, `setores`, `stock_movements`). Todas têm RLS sem políticas, o que nega leitura e escrita a `anon` e `authenticated`, mas **RLS não impede TRUNCATE**, e `service_role` ignora RLS.
- **Evidência:** catálogo do banco real, somente leitura. No ensaio, `anon` tinha TRUNCATE em `materials`. O PostgREST está conectado ao banco.
- **Consequência:** a API REST não oferece TRUNCATE, então não encontrei caminho de exploração direta. A proteção depende de o papel não ser alcançável e de a chave `service_role` não vazar. As tabelas `auth_*` não têm esses privilégios.
- **Não verificado:** se a Data API do Supabase está ligada e quais schemas expõe. Isso se confere no painel.
- **Correção e critério:** revogar por migração e conferir com `has_table_privilege`. A API conecta como `postgres`, então não depende desses privilégios.

**P-04. Chaves de passageiros e anexos ausentes no ambiente real** (bloqueado)
- **Requisito:** SC01 §6.4, SC04 §7.
- **Problema:** `PASSENGER_DATA_KEY` e `ATTACHMENTS_DIR` não existem em `backend/.env`.
- **Consequência:** cadastro de passageiros e envio de anexos respondem 503.
- **Podem ser definidas depois da migração**, porque nada grava sem elas. Os demais dados não dependem disso.
- **Correção e critério:** ver plano, Fase 3. A chave precisa de cópia segura fora do banco: sem ela, CPFs ficam ilegíveis, e não há troca de chave implementada. O diretório de anexos não deve ficar no Codespace.

**P-05. E-mail, recuperação de senha e Google Calendar nunca foram testados de verdade** (bloqueado)
- **Requisito:** SC01 §5, SC03 §4 e §7, SC05 §3, SC06 §2.5, SC08 §9.
- **Problema:** só há transporte simulado. Faltam credenciais do Resend, `PASSWORD_RESET_PEPPER`, conta de serviço e calendários.
- **Consequência:** ninguém recebe comunicação, nem o código de recuperação de senha. Há só um administrador ativo no banco real.
- **Arquivos:** `backend/src/integrations/transports.ts`, `backend/src/auth/email.ts`.
- **Correção e critério:** roteiro de homologação em `INTEGRACOES_E_AUTOMACOES.md`.

**P-06. Paridade com o sistema antigo não verificável** (bloqueado)
- **Requisito:** SC01 §6.3, SC03 §12, SC11 §1.
- **Evidência:** o código e as planilhas antigas não estão no repositório.
- **Consequência:** textos, campos, destinatários e calendários podem diferir sem que ninguém saiba.
- **Correção e critério:** comparação com a área usuária, ou acesso ao antigo.

**P-08. Administrador fora da SLM agenda e edita previsão de entrega**
- **Requisito:** SC01 §4 ("somente integrantes individualmente autorizados da SLM... realizar agendamentos"), SC05 §2 e §8.
- **Evidência:** teste "agendar: administrador sem SLM pode"; `permissions.ts`, regra `requests:schedule`; `warehouse:manage` no perfil Administrador. O Plano registra as duas questões como abertas.
- **Consequência:** o perfil concede o que o requisito reservou à SLM.
- **Correção e critério:** decisão da responsável. Se valer o texto, a API recusa e o teste muda.

**P-10. Backup fora do padrão pedido**
- **Requisito:** SC04 §11.3, revisão pré-migração.
- **Problema:** a cópia vai só para `backups/` no Codespace, e `--aplicar` aplica logo em seguida, sem pausa. A rotina automática não está ativa. Não encontrei prova de cópia externa: os arquivos `.gpg` de 03/11 estão na mesma máquina. O documento proíbe apontar a restauração ao Supabase e não há procedimento testado para o banco real.
- **Evidência:** a cópia de 04/11 tem SHA-256 correto e restaurou no ensaio, mas tem 4 contas, 123 sessões e 136 eventos, contra 7, 128 e 151 no banco real.
- **Consequência:** uma perda do Codespace durante a migração deixa sem cópia. O painel do Supabase pode ter backups próprios, o que não dá para ver pelo banco.
- **Correção e critério:** ver plano, Fase 0.

**P-11. Não há ambiente de produção definido**
- **Requisito:** SC03 §5, SC04 §11.1 e §11.2, SC09 §6.6.
- **Problema:** não há Dockerfile, serviço de arquivos estáticos nem hospedagem. O sistema roda por `tsx watch` e Vite. Fora de `NODE_ENV=production`, os processos de fila e de recorrência não ligam sem variável, e `MONITORING_ENABLED` está desligado.
- **Consequência:** assim, recorrências não são geradas sozinhas, filas não processam e a disponibilidade não é registrada.
- **Correção e critério:** definir com a TI. Deploy depende de autorização.

### Médios

| ID | Requisito | Problema e evidência | Consequência | Correção e critério |
|---|---|---|---|---|
| P-03 | SC01 §7 | As migrações revogam tabelas e funções, não sequências. Banco real: `anon`, `authenticated` e `service_role` têm USAGE, SELECT e UPDATE em `service_requests_protocolo_seq` e `material_requests_protocolo_seq`. Ensaio: 5 sequências novas ficam iguais, `anon` executou `nextval`, e a conferência final terminou em "sem problemas" | Pode consumir ou reposicionar numeração por SQL direto, sem ler dados. A REST não expõe essas funções | Revogar e fazer o script conferir sequências. `test:migrations` falha se alguma ficar aberta |
| P-07 | SC01 §6.6 contra SC04 §12.4, SC05 §7, SC06 §4, SC07 §5 | Textos em conflito. Existem "Nova solicitação" e "Pedir material" | Setores podem pedir por um canal que a decisão posterior dizia não existir | Decisão da responsável |
| P-09 | SC01 §5, SC07 §4 | Sem lista de domínios, qualquer e-mail cadastra. Banco real tem um cadastro pendente com domínio diferente dos demais | Depende só da atenção de quem aprova | Definir `INSTITUTIONAL_EMAIL_DOMAINS` |
| P-12 | SC07 §3.2 | Não há tipo de campo Anexo em `formDefinitions.ts` | Formulário não coleta arquivo por campo próprio | Implementar ou dispensar |
| P-13 | SC07 §9 | Plano: obrigatoriedade em campo fixo opcional "só vale na tela" | Chamada direta à API ignora a regra publicada | Conferir no servidor |
| P-14 | SC08 §7 | Remetente só por variável de ambiente; envio por permissão, sem tela por perfil | Depende de ajuste técnico | Tela e autorização da TI |
| P-15 | SC09 §8 | A API aceita anexo em etapa; `uploadDemandAttachment` não envia a etapa | Anexo só na demanda | Incluir na tela |
| P-16 | SC03 §3 | Base legal, retenção e responsáveis não informados, corretamente não inventados | Avisos não validados, sem regra de descarte | Área competente |
| P-17 | SC09 §20, SC10 §6 | `app.ts` não define cabeçalhos globais (CSP, `nosniff`, HSTS), só as rotas de anexo; `frame-ancestors` está na configuração do Vite. `App.css` importa fonte do Google, e o E2E bloqueia essa origem | Menos defesa em profundidade; o navegador informa o IP ao Google | Definir no servidor de produção e hospedar a fonte |
| P-20 | SC04 §7 | Validação de conteúdo, macros e scripts em PDF, sem antivírus | Malware em formato válido passa | Avaliar com a TI |
| P-22 | SC01 §7 | `frontend/tsconfig*.json` não declara `strict`; limitador de login em memória | Menos garantias de tipo; o limite zera ao reiniciar e não vale entre instâncias | Ligar e corrigir; compartilhar se houver mais instâncias |
| P-24 | SC04 §11.6 | O documento diz que saída 1 é "nada mudou", mas falha na conferência final ou perda de conexão depois de aplicar também sai com 1 | Pessoa pode achar que nada foi aplicado | Corrigir. Até lá, sempre rodar `migrations:check` depois de uma saída 1 |
| P-25 | Incidente de 03/11 | As duas contas fictícias continuam no banco real. Uma está inativa com permissões antigas de escrita. Reativá-la antes da migração faz a 003 parar | Sujeira e risco se reativada | Decisão da responsável. Exclusão continua possível depois da migração |

### Baixos

| ID | Problema | Correção e critério |
|---|---|---|
| P-18 | Cores: `--jucesp-blue` é redefinido para `#0862c9` e usado 40 vezes em `App.css`; grafite com dois valores; `.stat-icon.purple`; 4.624 linhas de CSS antigo com `theme.css`. Azul: SC02 diz sem dominar, SC04 e SC09 pedem destaque. Hoje o primário é amarelo | Decidir o azul e remover o legado |
| P-19 | Configurações é uma única página de 10.853 px no computador | Dividir por grupo |
| P-21 | Sem teste com leitor de tela | Roteiro com NVDA ou VoiceOver |
| P-23 | Frota e portal: veículo da viagem em texto, hodômetro não alimenta km, jornada noturna recusada, reagendar não confere conflito do motorista, edição simultânea de parâmetros vale a última | Decidir caso a caso |
| P-22 | Sem uso: `ModulePlaceholderPage.tsx`, tabela `request_forms`, colunas `pode_cadastrar`, `ver_setor`, `e_slm`, papéis `integrante` e `consulta`, `tmp-backup-perfis/`, imagem `file_0000...png` em `frontend/public`. Pacote único de 945 kB | Remover com autorização e dividir o pacote |
| P-26 | Plano ainda fala em migrações "002 a 011"; numeração de Supercomandos repetida; SC12 cita a si mesmo onde deveria citar o 11 | Atualizar |

## E. Segurança e LGPD

**Comprovado por teste:** rotas com sessão e permissão exata, CSRF nas escritas, 404 ou 403 em acesso direto, CPF só com concessão e auditoria, dados forjados ignorados, Argon2id, cookie `HttpOnly` e `SameSite=Strict`, nada sensível no navegador, anexos sem URL pública, histórico imutável, CSV protegido contra fórmulas, prévia de e-mail em `iframe` sem permissões.

**`npm audit`:** 0 vulnerabilidades em dependências de produção, no backend e no frontend.

**Em aberto:** P-02, P-03, P-04, P-05, P-09, P-16, P-17, P-20 e P-25. `backend/.env` também tem permissão de leitura para todos (`rw-rw-rw-`) no Codespace.

**Revisão de objetos públicos no banco real:** RLS ativa nas 11 tabelas, sem políticas e sem views. Duas funções de gatilho (`apply_stock_movement`, `set_updated_at`) executáveis por papéis públicos, não diretamente úteis e sem `search_path` fixo. Nenhuma função `SECURITY DEFINER`. `auth.users` e `storage.objects` vazios.

## F. Visual e usabilidade

As 7 capturas vistas seguem a identidade: sidebar preta, item ativo amarelo com ícone preto, botões amarelos, cards em preto, amarelo, branco e grafite, ícones Phosphor, sem títulos antigos. Os textos removidos pelo SC02 não aparecem no código. Divergências: P-18, P-19 e P-21. Além disso, o painel de Demandas é longo, com cartões soltos deixando áreas vazias na grade, e o selo "API conectada" é uma informação técnica no cabeçalho de todas as pessoas.

## G. Testes executados

| Comando | Resultado | Observação |
|---|---|---|
| `npm run verify` (tipos, lint, unitários, builds) | Passou, 299 de 299 | Aviso de pacote acima de 500 kB |
| `npm run test:integration` | Passou, 283 de 283 | PostgreSQL descartável |
| `npm run test:backup` | Passou | Dados fictícios |
| `npm run test:migrations` | Passou, 8 cenários | Não confere sequências (P-03) |
| `npm run test:e2e` | Passou, 139 | O número 133, citado antes, foi lido com a execução em andamento |
| `npm run test:e2e` com capturas | Passou, 139 | 170 imagens, em pasta temporária |
| Ensaio próprio com a cópia de 04/11 | 16 aplicadas, dados antigos idênticos | Restauração como papel sem superusuário |
| Reversão de 017 a 002 no ensaio | 0 diferença de estrutura, dados e privilégios iguais | |
| `DROP SCHEMA` e restauração no ensaio | Dados e privilégios iguais; 3 erros esperados de privilégios padrão de `supabase_admin`, que se perdem | Nunca testado no Supabase |
| `npm audit --omit=dev` | 0 vulnerabilidades | |

**Falharam:** nenhum. O primeiro ensaio foi invalidado por erro meu de preparação e refeito.

**Não realizados:** envio real de e-mail, Google Calendar real, migração no banco real, aceite humano, leitor de tela, carga e desempenho, navegadores além do Chromium de teste, comparação com o sistema antigo.

## H. Plano de correção

Ver `PLANO_DE_CORRECOES.md`. Ordem: proteger o código e a cópia, corrigir privilégios antes de migrar, decidir as regras, resolver dependências da TI, depois desenvolver e fazer o acabamento.

**Nenhuma correção foi iniciada. Elas aguardam autorização expressa.**
