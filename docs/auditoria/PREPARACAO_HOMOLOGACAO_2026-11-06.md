# Preparação do banco de homologação

| | |
|---|---|
| **Data** | 06/11/2026 |
| **Projeto de destino** | `jucesp-logistica-homologacao`, referência `rrqulhpnghoetgrdswqr`, `https://rrqulhpnghoetgrdswqr.supabase.co` |
| **Situação** | **Preparação concluída. Nada foi gravado em nenhum banco.** Falta a credencial para os testes com login; depois, a sua autorização para aplicar |

## 1. Arquivos inspecionados

- **Documentos:** `docs/PLANO_HOMOLOGACAO.md`, `docs/INSTRUCOES_TI_HOMOLOGACAO.md`, `docs/PRODUCAO.md`, `docs/auditoria/RELATORIO_ESTABILIZACAO_2026-11-06.md`, `docs/auditoria/MATRIZ_REQUISITOS_2026-11-06.md`, `docs/auditoria/PRE_MIGRACAO_2026-11-06.md`.
- **Conexão:** `backend/src/database/pool.ts`, `backend/src/loadEnvironment.ts`, `backend/src/database/databaseSafety.ts`, `backend/certificates/prod-ca-2021.crt`.
- **Estrutura e migrações:** `backend/database/schema/001_public_schema_snapshot.sql`, 002 a 018 e as reversões.
- **Scripts:** `scripts/apply-migrations.cjs`, `backup-database.cjs`, `verify-backup.cjs`, `inspect-database.cjs`, `backup-attachments.cjs`, `backend/src/cli/create-initial-admin.ts`.
- **Configuração:** `backend/.env.example`, `.gitignore`, `frontend/vite.config.ts`.

## 2. O que foi verificado sem credencial

| Verificação | Resultado |
|---|---|
| `backend/.env` aponta para a homologação? | **Não.** Aponta para outro projeto, o banco real. Conferido só pelo nome de usuário, sem exibir valores |
| Variáveis de ambiente do Codespace com banco ou Supabase | Nenhuma |
| O projeto `rrqulhpnghoetgrdswqr` existe e responde | Sim: `https://rrqulhpnghoetgrdswqr.supabase.co/rest/v1/` respondeu 401 sem chave, como esperado |
| Conexão direta (`db.rrqulhpnghoetgrdswqr.supabase.co`) | Só tem endereço IPv6, e **o Codespace não tem saída IPv6**: inviável |
| Tipo de conexão a usar | **Session pooler**, porta 5432, usuário `postgres.rrqulhpnghoetgrdswqr`. O mesmo tipo do banco real, já usado com sucesso pelos scripts. O Transaction pooler (6543) não serve para `pg_dump` nem para migrações |
| TLS | Os scripts sempre verificam o certificado com `backend/certificates/prod-ca-2021.crt`, a autoridade do Supabase usada com sucesso no banco real |

## 3. Configuração necessária (depende de você)

**Um único segredo do Codespaces.** Não cole a senha nesta conversa nem em arquivo versionado.

1. No painel do Supabase, projeto **jucesp-logistica-homologacao** → **Connect** → aba **Session pooler**. Copie o endereço (começa com `postgresql://postgres.rrqulhpnghoetgrdswqr:`, porta `5432`).
2. Troque `[YOUR-PASSWORD]` pela senha do banco **de homologação**. Se a senha tiver `@`, `:`, `/`, `#` ou `%`, prefira gerar outra em Settings → Database → Reset database password, só com letras e números, para evitar codificação. **Não use a mesma senha do banco real**: o script recusa.
3. No GitHub: **Settings → Codespaces → Secrets → New secret**.
   - **Name:** `SLM_HOMOLOG_DATABASE_URL`
   - **Value:** o endereço do passo 2
   - **Repository access:** `evelynnssousa/sistema-logistica-web`
4. Recarregue o Codespace para ele receber o segredo. O VS Code oferece "Reload to apply", ou pare e inicie o Codespace.
5. Recomendado no Supabase: em **Settings → API**, desligar a Data API ou retirar o schema `public` dos expostos. O sistema não usa a Data API, e a 018 fecha os privilégios de qualquer forma.

**Alternativa sem segredo do GitHub:** arquivo `backend/.env.homologacao`, com uma linha `DATABASE_URL=...` e permissão `600`. O Git ignora esse arquivo, e o script recusa o arquivo se a permissão for mais aberta. O segredo do Codespaces é preferível, porque não fica gravado no disco do Codespace.

**Nenhuma outra variável é necessária para aplicar a estrutura e as migrações.** Para a API da homologação, as demais configurações (`PASSENGER_DATA_KEY`, `ATTACHMENTS_DIR`, Resend) seguem `INSTRUCOES_TI_HOMOLOGACAO.md`.

## 4. Proteções criadas nesta etapa

**`scripts/homologacao.cjs`** (`npm run homolog`) é o único caminho para operar a homologação. Antes de qualquer coisa, sem conectar, ele exige:

| Trava | Por quê |
|---|---|
| Usuário exatamente `postgres.rrqulhpnghoetgrdswqr` | No pooler, o usuário é o que identifica o projeto: host e banco são os mesmos para projetos da mesma região |
| Host `*.pooler.supabase.com`, porta 5432, banco `/postgres`, com senha | Session pooler; recusa conexão direta, Transaction pooler e endereços locais |
| `backend/.env` apontando para outro projeto | Se o banco real estiver configurado como homologação, ou vice-versa, recusa |
| Senha diferente da do banco real | Garante que as credenciais do banco real não foram reaproveitadas |
| Gravação da estrutura só com `--confirmar=HOMOLOGACAO-rrqulhpnghoetgrdswqr` e com `public` vazio | Nada é sobrescrito; a 001 roda em transação única |

Ao repassar um comando (`npm run homolog -- -- <comando>`), o script injeta o `DATABASE_URL` da homologação só naquele processo, grava os backups em `backups/homologacao/` (separados das cópias do banco real) e usa as portas 3100 (API) e 5174 (tela), deixando livres as 3000 e 5173 do desenvolvimento. Mensagens de erro nunca repetem o endereço.

**Correções no script de migração, sem mudar nenhuma migração:**

- **Identidade do banco no registro do backup.** Era calculada só com host e nome do banco. No pooler do Supabase, isso é igual para dois projetos da mesma região, e o que os distingue é o usuário. A identidade passou a incluir o usuário (nunca a senha). Antes, a conferência dos dados já recusaria uma cópia trocada; agora a identidade também recusa. Há teste novo para esse caso: mesmo host e banco, outro usuário, dados idênticos.
- **Pasta própria para os backups da homologação**, só quando o comando vem de `scripts/homologacao.cjs`.

**Testes:**

| Teste | Resultado |
|---|---|
| `npm run test:homologacao` (novo, só endereços fictícios, sem rede) | Aprovado: aceita o projeto certo e recusa outro projeto, conexão direta, porta 6543, outro banco, `.env` trocado, senha repetida, arquivo com permissão aberta e ausência de credencial |
| `npm run test:migrations` | Aprovado, com o caso novo da identidade |
| Ensaio local em PostgreSQL 17 descartável que reproduz um projeto Supabase novo (`postgres` sem superusuário) | As consultas do `verificar` funcionam e acusam "vazio"; a 001 aplicada pelo script cria 11 tabelas com dono `postgres`; uma segunda aplicação é recusada e desfeita. O ensaio anterior aplicou as 17 migrações sobre esse estado com saída 0 |

Dois erros do próprio script novo foram encontrados nesse ensaio e corrigidos antes de qualquer uso real. Um era uma conversão de tipo na consulta de privilégios padrão. O outro: a leitura do TLS vinha da conexão pooler→banco, e não da conexão Codespace→pooler, o que podia acusar "sem TLS" por engano.

## 5. Resultado dos testes de conexão

**Ainda não executados:** dependem do segredo do item 3. Com ele configurado, o teste é este, só de leitura:

```bash
npm run homolog -- verificar
```

O que ele mostra, sem gravar nada:
- projeto de destino;
- TLS do Codespace ao pooler, com certificado verificado;
- versão do PostgreSQL (precisa ser 17, a do banco real, porque a 001 usa um comando da versão 17);
- papel (`postgres`, sem superusuário, podendo criar em `public`);
- papéis do Supabase, extensões, gatilhos de evento e privilégios padrão;
- situação do `public`. O esperado é **VAZIO**. Se houver qualquer objeto inesperado, ele aponta como problema e a estrutura não é aplicada.

## 6. Comandos exatos para aplicar, depois da sua autorização

Na pasta do projeto, no terminal do Codespaces ou no prompt com `!`:

```bash
npm run homolog -- verificar
npm run homolog -- estrutura --confirmar=HOMOLOGACAO-rrqulhpnghoetgrdswqr
npm run homolog -- -- node scripts/apply-migrations.cjs --aplicar --confirmar=APLICAR-MIGRACOES
npm run homolog -- -- node scripts/apply-migrations.cjs --aplicar --confirmar=APLICAR-MIGRACOES --backup=backups/homologacao/<arquivo>.dump
npm run homolog -- -- npm run migrations:check
npm run homolog -- -- npm run db:inspect
```

| Comando | Faz |
|---|---|
| 1 | Só leitura; precisa terminar em "VAZIO", sem PROBLEMA |
| 2 | Grava a estrutura inicial: 11 tabelas vazias |
| 3 | Backup do banco de homologação e teste da restauração; sai com 5, sem aplicar |
| 4 | Aplica 002 a 018 na ordem; esperado "Concluído: 17 migrações aplicadas" e "Objetos de public acessíveis à API pública: nenhum" |
| 5 e 6 | Conferência: "Nenhuma migração pendente"; 64 tabelas com RLS; nenhum privilégio dos papéis da API |

Depois, a administradora da homologação: `npm run homolog -- -- npx tsx backend/src/cli/create-initial-admin.ts`.

**Reversão:** com o banco de homologação, a forma mais simples é recriar o projeto ou esvaziar o `public` pelo painel. Também valem os `.rollback.sql` na ordem inversa, como em `PRE_MIGRACAO_2026-11-06.md`. Nada disso alcança o banco real.

**Autenticação após a migração:** no ensaio, a API desta versão autenticou, criou e encerrou sessões e aplicou as permissões depois das 17 migrações. Na homologação não há contas até a criação da administradora.

## 7. Riscos e incompatibilidades

| # | Item | Tratamento |
|---|---|---|
| 1 | Codespace sem IPv6 | Session pooler (item 2) |
| 2 | Projeto criado em PostgreSQL anterior ao 17 | O `verificar` acusa e impede a estrutura. Projetos novos do Supabase usam 17; se não for o caso, recriar na versão 17 |
| 3 | Projetos novos podem ter configuração do Supabase diferente da do projeto antigo (privilégios padrão, gatilhos de evento) | O `verificar` lista os dois; a 018 e a conferência final fecham e conferem tudo o que estiver aberto em `public` |
| 4 | A ferramenta de segurança desta sessão bloqueou, antes, o script de migração com `--aplicar` no banco real | Pode bloquear também na homologação. Nesse caso, você roda os comandos com `!`, ou libera a regra |
| 5 | Comando sem `npm run homolog -- --` usa o `backend/.env` (banco real) | Destacado no plano; o script imprime o destino antes de cada comando |
| 6 | O certificado do pooler da homologação não ser da mesma autoridade | O `verificar` falharia na conexão, sem gravar nada |

## 8. Confirmações

- **Banco real:** não foi acessado nesta etapa, nem para leitura. Nenhum comando usou o `backend/.env` para conectar. O arquivo só foi lido localmente, para conferir que aponta para outro projeto.
- **Destino:** todos os comandos preparados passam por `scripts/homologacao.cjs`, que só aceita o projeto `rrqulhpnghoetgrdswqr`.
- **Dados:** não houve gravação em banco algum. Nenhum dado do banco real foi copiado para a homologação. As únicas bases usadas foram descartáveis, locais e vazias, removidas ao fim.
- **Credenciais:** nenhuma foi gravada no código ou em arquivo versionado; nenhum `.env` foi para o Git.
- **Publicação:** nada foi publicado, e o Codespace não foi exposto.

**Aguardando:** (1) o segredo `SLM_HOMOLOG_DATABASE_URL`, para o teste de conexão; (2) depois dele, sua autorização expressa para aplicar a estrutura e as 17 migrações **exclusivamente** no projeto `rrqulhpnghoetgrdswqr`.
