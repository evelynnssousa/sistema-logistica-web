# Pré-migração do banco real: relatório para autorização

| | |
|---|---|
| **Data** | 06/11/2026, a partir das 13h (UTC) |
| **Base** | `RELATORIO_ESTABILIZACAO_2026-11-06.md` (APROVADO COM RESTRIÇÕES, para homologação) |
| **Código** | Branch `integracao/cadastro-e-permissoes`, commit `b1e2e19` e seguintes desta etapa |
| **Situação** | **Etapas 3 a 5 concluídas. Nada foi aplicado. Aguardando autorização expressa.** |

## O que foi feito no banco real

Só leitura, sempre em `BEGIN TRANSACTION READ ONLY`, sem consultar colunas pessoais (contas aparecem como contagens e domínios):

- `npm run migrations:check` (conferência das pendências);
- `npm run db:inspect` (nova ferramenta desta etapa, `scripts/inspect-database.cjs`): estrutura, donos, RLS, privilégios, funções, gatilhos, contagens, contas por situação, bloqueios conhecidos;
- `npm run backup:database` (pg_dump em transação somente leitura).

Antes de começar, as portas 3000 e 5173 (API e tela de desenvolvimento ligadas ao banco real) estavam livres, e a última atividade registrada no banco é de 05/11 às 18:53 UTC. Nenhum processo gravou no banco durante a verificação.

**A primeira etapa do script de aplicação não foi executada.** Ela só gera backup e para, sem aplicar, mas a ferramenta de segurança desta sessão bloqueou o comando por conter `--aplicar`. Não contornei o bloqueio. O backup foi feito pelo caminho estritamente de leitura, e o comando da primeira etapa está no item 6, para ser executado por você.

## 1. Situação atual do banco

| Item | Valor |
|---|---|
| Servidor | PostgreSQL 17.11 (Supabase), via session pooler, TLS verificado |
| Papel usado pelo sistema | `postgres`, **sem superusuário**, dono de todas as 11 tabelas e das 2 funções de `public`; membro de `anon`, `authenticated` e `service_role` |
| Tabelas em `public` | 11, todas com RLS, nenhuma política, nenhuma visão |
| Registros | `auth_users` 7, `auth_sessions` 128 (nenhuma válida), `auth_audit_events` 155; as 8 tabelas operacionais estão **vazias** |
| Contas | 1 administrador ativo (domínio `jucesp.sp.gov.br`); 4 cadastros pendentes (3 `jucesp.sp.gov.br`, 1 `jucespmail.sp.gov.br`); 2 contas fictícias do incidente de 03/11 (`example.gov.br`): 1 operador inativo com permissões antigas de escrita e 1 rejeitada |
| Integridade | Nenhuma restrição não validada, nenhuma sessão órfã, nenhum nome repetido em setores ou materiais |
| Schemas do Supabase | `auth.users` e `storage.objects` vazios: o sistema não os usa |
| Extensões | `pgcrypto`, `uuid-ossp`, `pg_stat_statements` (schema `extensions`), `supabase_vault`. As migrações não usam funções de extensão |
| Gatilhos de evento | 6 do Supabase (`pgrst_ddl_watch`, `pgrst_drop_watch` e de extensões). Só notificam o PostgREST; não alteram o que as migrações criam |
| Variáveis do backend | Só `DATABASE_URL`, `DB_POOL_MAX`, `FRONTEND_URL`, `PORT`. Nenhuma chave do Supabase. O backend não usa PostgREST, Auth, Storage nem `service_role` |

## 2. Migrações pendentes

17, na ordem: 002, 003, 004, 005, 006, 007, 008, 009, 010, 011, 012, 013, 014, 015, 016, 017, 018. Nenhum bloqueio conhecido:

| Conferência | Resultado |
|---|---|
| Operadores ativos com escrita (bloqueio da 003) | 0. O operador fictício com escrita está **inativo**: vira Solicitante sem permissões |
| Passageiros com CPF em texto (bloqueio da 005) | Tabela inexistente |
| Nomes repetidos em setores e materiais, item repetido em pedido (bloqueios da 005) | 0 |
| Tabelas que as migrações criam (53) e já existem | Nenhuma |

### A migração 018 no banco real

| Pergunta | Resposta, conferida no catálogo do banco real |
|---|---|
| Tabelas afetadas | `materials`, `material_requests`, `material_request_items`, `request_forms`, `request_history`, `service_requests`, `setores`, `stock_movements` |
| Outros objetos | Sequências `service_requests_protocolo_seq` e `material_requests_protocolo_seq`; funções `apply_stock_movement` e `set_updated_at` |
| Permissões removidas | De `anon`, `authenticated` e `service_role`: `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `REFERENCES`, `TRIGGER` e `MAINTAIN` nas 8 tabelas; `USAGE`, `SELECT`, `UPDATE` nas 2 sequências; `EXECUTE` nas 2 funções, também de `PUBLIC` |
| Quem concedeu | `postgres`, o mesmo papel que aplicará a migração: a revogação tem efeito (se o concedente fosse `supabase_admin`, não teria) |
| O backend usa `service_role`? | Não. Conecta como `postgres`, dono das tabelas, que não depende desses privilégios. O fato de `postgres` ser membro de `anon` e `service_role` não muda o acesso dele, que vem de ser o dono |
| Operações legítimas continuam? | Sim, comprovado no ensaio (item 3): login, sessão, consultas de todos os módulos, cadastro e gravação, logout |
| Efeito sobre o painel do Supabase | O editor de tabelas do painel usa um papel administrativo e continua vendo os dados. A Data API (PostgREST) deixa de alcançar as tabelas de `public`, que é o objetivo |

**Ajuste feito nesta etapa (sem mudar nenhuma migração):** o banco real tem o privilégio `MAINTAIN`, novo no PostgreSQL 17. A 018 já o remove (`REVOKE ALL`), mas a conferência final do script não o inspecionava. A conferência e o teste passaram a incluí-lo.

## 3. Backup, restauração e ensaio

| Item | Resultado |
|---|---|
| Backup completo | `backups/slm-completo-2026-11-06T13-04-28-246Z.dump`, 70.340 bytes |
| SHA-256 | `8f36bf833fe26b12c21b3b23547e43108aca61a86a4ab846adcc846cb35333fa` |
| Teste de restauração | `npm run backup:verify`: SHA-256 confere, 11 de 11 tabelas, contagens idênticas às do banco real |
| Anexos | **Não há anexos a copiar**: `ATTACHMENTS_DIR` não está configurada no ambiente real, e o envio de anexos nunca funcionou nele. A cópia dos anexos passa a valer quando a pasta existir (`npm run backup:attachments`) |
| **Destino externo** | **Não disponível nesta sessão.** As cópias estão só em `backups/`, dentro do Codespace. Não enviei o arquivo para nenhum serviço: ele contém dados pessoais e hashes de senha, e nenhum destino institucional foi autorizado |

**Ensaio completo sobre a cópia** (PostgreSQL 17 descartável, porta própria, removido ao fim), reproduzindo o Supabase: `postgres` sem superusuário, dono das tabelas, membro dos papéis da API, com os mesmos privilégios padrão. Restaurado da cópia acima.

| Verificação | Resultado |
|---|---|
| Restauração como `postgres` sem superusuário | Dados completos; 3 erros esperados ao recriar privilégios padrão de `supabase_admin` (nenhum efeito sobre dados ou estrutura) |
| Antes da aplicação | `anon` com `TRUNCATE` em `materials`, como no real |
| Aplicação com o mesmo script e as mesmas opções que serão usadas no real (só sem backup, por ser local) | **17 migrações aplicadas, saída 0**; conferência final: 64 tabelas, 64 com RLS, 0 divergências de perfil, nenhum objeto aberto à API pública |
| Dados | 7 contas, 128 sessões, 155 eventos antes e depois: nada perdido nem criado |
| Contas depois da 003 | Administrador ativo → Administrador, **fora da equipe SLM**, sem concessões; operador fictício inativo → Solicitante sem permissões; pendentes e rejeitada sem linha de acesso (recebem ao serem aprovadas) |
| Testes negativos | Como `anon`, `authenticated` e `service_role`: ler `auth_users` e `materials`, `TRUNCATE`, inserir e numerar protocolo → "permission denied" |
| API desta versão ligada à cópia migrada | `/health` 200; login de contas fictícias de ensaio 200; administrador fora da SLM sem `warehouse:manage` nem `requests:schedule`, mas com `users:manage`; administrador da SLM com ambas; cadastro de unidade e material pela SLM 201, pelo externo 403; listas de usuários, auditoria, Manutenção, Frota, Passagens, Almoxarifado, Demandas, notificações, pesquisa e integrações 200; logout 200 e sessão encerrada (401) |

Desde a verificação, o banco real não teve atividade registrada. Antes de aplicar, o script confere de novo que os dados são idênticos aos da cópia.

## 4. Riscos identificados

| # | Risco | Gravidade | Tratamento |
|---|---|---|---|
| R1 | **Cópia só no Codespace** | Alta | Levar a cópia cifrada para um destino institucional antes da segunda etapa (item 6, passo 2). Sem isso, perder o Codespace durante a migração deixa sem ponto de retorno |
| R2 | **O único administrador não poderá agendar nem gerir o Almoxarifado depois da migração** (P-08), e o sistema não permite que ele altere o próprio acesso | Média | Não impede a homologação: ele aprova os operadores da SLM como Operador SLM, na equipe, e concede agendamento e Almoxarifado. Para um administrador da SLM, é preciso um segundo administrador que o marque na equipe |
| R3 | Banco único: o que se testar na homologação fica no banco que pode virar o de produção | Média | Ver item 8. Decisão sua |
| R4 | Mudanças permanentes de estrutura (trocas de `CHECK`, preenchimento do protocolo na 007) | Baixa | As tabelas operacionais estão vazias; as reversões existem e recusam quando perderiam dados; o backup é o ponto de retorno |
| R5 | Gravação durante a aplicação | Baixa | Manter API (3000) e tela (5173) paradas. O script recusa se os dados mudarem depois do backup |
| R6 | Queda de conexão no meio | Baixa | Cada migração tem transação própria; o script sai com 2 e informa o que ficou aplicado; nunca repetir sem rodar `migrations:check` antes |
| R7 | Pendente com domínio `jucespmail.sp.gov.br` | Baixa | Conferir com a área antes de aprovar (P-09) |
| R8 | Contas fictícias de 03/11 continuam | Baixa | Ficam inativa/rejeitada e sem permissões depois da 003. Exclusão só com sua autorização (P-25) |

## 5. Impactos

- **Dados:** nenhum registro é apagado ou alterado nas tabelas de contas, sessões e auditoria. As 8 tabelas antigas estão vazias.
- **Login:** continua igual; as senhas não mudam. As 128 sessões já estão vencidas.
- **Acesso:** o administrador vira "Administrador fora da equipe SLM". Os 4 pendentes continuam pendentes.
- **Telas:** os módulos deixam de responder 503 e passam a funcionar. Passagens (cadastro de passageiros) e anexos continuam indisponíveis até `PASSENGER_DATA_KEY` e `ATTACHMENTS_DIR` existirem; e-mail e recuperação de senha, até o Resend.
- **Supabase:** a Data API deixa de alcançar as tabelas; o painel continua funcionando.
- **Sistema antigo:** nada muda nele.

## 6. Comandos exatos

Rode no terminal do Codespaces (ou no prompt do Claude Code com o prefixo `!`), na pasta do projeto, com a API e a tela de desenvolvimento **paradas**.

**Passo 1. Primeira etapa: backup verificado e registro, sem aplicar nada** (saída esperada: 5)

```bash
node scripts/apply-migrations.cjs --aplicar --confirmar=APLICAR-MIGRACOES
```

Ele mostra `Arquivo:` e `SHA-256:`. Anote os dois.

**Passo 2. Cópia externa cifrada** (obrigatório antes do passo 3)

```bash
gpg --symmetric --cipher-algo AES256 backups/<arquivo>.dump
sha256sum backups/<arquivo>.dump.gpg > backups/<arquivo>.dump.gpg.sha256
```

Guarde a senha do `gpg` em cofre da instituição, separada da cópia. Baixe o `.gpg` e o `.sha256` pelo explorador do VS Code (botão direito → Download) para o destino institucional e confira lá com `sha256sum -c`. Não use e-mail, chat nem o repositório.

**Passo 3. Segunda etapa: aplicação** (só depois da autorização e do passo 2; saída esperada: 0)

```bash
node scripts/apply-migrations.cjs --aplicar --confirmar=APLICAR-MIGRACOES --backup=backups/<arquivo>.dump
```

Esperado: `Backup conferido`, `aplicada` de 002 a 018, `Objetos de public acessíveis à API pública: nenhum`, `Concluído: 17 migrações aplicadas`. Se sair com 1, nada mudou; com 2, 3 ou 4, **pare** e rode o passo 4 antes de qualquer outra coisa.

**Passo 4. Conferência posterior** (só leitura)

```bash
npm run migrations:check     # esperado: "Nenhuma migração pendente."
npm run db:inspect           # 64 tabelas com RLS; nenhuma linha em "Privilégios ... papéis da API"; contas 7, sessões 128
npm run config:check         # avisos esperados: chave, anexos, Resend e pepper
```

## 7. Reversão

Na ordem, conforme o momento:

1. **Falha durante a aplicação (saída 2):** a migração que falhou é desfeita pelo próprio banco; as anteriores ficam. Não repetir às cegas: `npm run migrations:check` mostra onde parou. Corrigida a causa, o mesmo comando do passo 3 retoma, mas só se os dados ainda forem iguais aos do backup; senão, novo passo 1.
2. **Desfazer com o banco ainda sem dados novos:** aplicar os `.rollback.sql` na ordem inversa, de 018 a 002, com o mesmo acesso do script. Cada um recusa sozinho se já houver dados que dependam dele. Exemplo para um arquivo (a senha vem do `.env`, nunca escrita no comando):

   ```bash
   docker run --rm -i --network host -e PGSSLMODE=require -e DATABASE_URL="$(grep ^DATABASE_URL= backend/.env | cut -d= -f2-)" \
     -v "$PWD/backend/database/schema:/s:ro" postgres:17 \
     sh -c 'psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f /s/018_public_api_privileges.rollback.sql'
   ```

3. **Depois que houver dados de homologação, ou se a reversão recusar:** restaurar a cópia do passo 1, conforme "Recuperação, em ordem" em `docs/BACKUP_E_MIGRACOES_SUPABASE.md`. Restaurar sobre o Supabase substitui os dados atuais e exige sua autorização expressa; a alternativa sem sobrescrever é restaurar num projeto Supabase novo.

A reversão da 018 reabre as tabelas antigas à API pública: use só se a 018 comprovadamente causar problema.

## 8. O ambiente está preparado para a homologação?

**O banco e o código, sim:** nenhum bloqueio, cópia restaurável, ensaio completo aprovado sobre a cópia real.

**Para a SLM começar a testar, faltam três condições que não dependem de código:**

1. **Cópia externa** (R1). Sem ela, não recomendo aplicar.
2. **Onde a SLM acessa o sistema.** Hoje ele só roda no Codespace, pelos servidores de desenvolvimento (`npm run dev:backend` e `npm run dev:frontend`). O endereço encaminhado do Codespace, como privado, só abre para a sua conta do GitHub; torná-lo público expõe o sistema na internet sem as proteções de produção. As alternativas são a TI providenciar um ambiente de homologação (`docs/PRODUCAO.md`) ou a homologação ser feita a partir da sua sessão, com cada operador entrando com a própria conta.
3. **Confirmação de que este banco está reservado para homologação.** Ele não tem dados operacionais, mas é o único projeto Supabase. O que for criado na homologação ficará nele; limpar depois exige exclusões, que dependem da sua autorização. A alternativa é um projeto Supabase separado para homologação.

Além disso, para homologar Passagens com passageiros e os anexos, é preciso definir `PASSENGER_DATA_KEY` e `ATTACHMENTS_DIR` no ambiente de homologação. Não gerei a chave: se este banco virar o de produção, ela passaria a ser a chave definitiva, que deve ser gerada no servidor e guardada em cofre.

## Para autorizar

Responda informando:

- que autoriza aplicar **as 17 migrações, de 002 a 018**, no banco real;
- se a cópia externa (passo 2) foi feita e onde, ou se aceita aplicar sem ela (não recomendado);
- se este banco está reservado para homologação;
- se prefere executar você mesma os passos 1 e 3, ou liberar a ferramenta para que eu os execute.
