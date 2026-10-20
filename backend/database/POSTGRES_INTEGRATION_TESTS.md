# Testes PostgreSQL de integração

## Estado e pré-requisitos

O alvo documentado é PostgreSQL `17.6` (`postgres:17.6`), sem `latest`. Confirme antes de cada ciclo que a versão principal corresponde à do projeto Supabase pretendido. A suíte exige Docker/Compose, daemon ativo e um container descartável já preparado. Ela não inicia nem remove containers.

O container deve usar o nome `sistema-logistica-auth-test`, a imagem fixada, o label `com.sistema-logistica.postgres-test=true`, somente a porta `5432` publicada em `127.0.0.1:55432`, nenhum volume montado e `--rm`. O guard rejeita overrides Docker, exige um socket Unix local, fixa esse endpoint nos comandos Docker seguintes e compara o endereço PostgreSQL com os IPs de rede do container. Ele também inspeciona ID, nome, label, imagem, portas, mounts, auto-remove e estado sem ler variáveis de ambiente do container.

Um socket Unix local pode, em tese, ser um proxy para outro daemon. O código não consegue provar criptograficamente a origem do processo Docker; por isso, bloqueia por padrão e exige a atestação manual `POSTGRES_TEST_LOCAL_DOCKER_ATTESTATION=1` somente após verificar que o socket corresponde diretamente ao daemon local do Codespace. Se essa origem não puder ser confirmada, não defina a variável e não prossiga.

Antes da aplicação do esquema, uma preparação manual autorizada deve deixar prontos no container descartável os papéis `app_private_owner` (`NOLOGIN`), `app_backend` (`LOGIN`), `anon` (`NOLOGIN`) e `authenticated` (`NOLOGIN`), todos sem superuser, `BYPASSRLS`, `CREATEDB` ou `CREATEROLE`. O owner será dono do schema e das tabelas. Depois da aplicação do esquema, grants mínimos e políticas RLS precisam ser aprovados e configurados manualmente.

- banco `sistema_logistica_auth_test` e papel bootstrap superuser `postgres`;
- nenhum schema de aplicação nem relações de usuário antes do preflight;
- após o preflight, schema `app_private` pertencente a `app_private_owner`, tabelas e índices do esquema versionado;
- grants mínimos e políticas RLS aprovados. O arquivo de esquema não define owner, grants ou RLS. O teste de integração bloqueia se o owner, os papéis, os privilégios ou o RLS com `FORCE` estiverem ausentes ou diferentes do esperado.

A conexão `TEST_DATABASE_URL` é exclusivamente para o papel bootstrap do container descartável. Os testes emulam os papéis operacionais por `SET ROLE`, usando somente nomes fixos e permitidos no código. Isso permite conferir os privilégios PostgreSQL; não reproduz JWT, claims ou o comportamento HTTP do PostgREST.

O preflight Docker ocorre antes de criar o container: rejeita overrides Docker e só aceita o contexto `default` apontando a um socket Unix local existente após a atestação manual. O preflight de schema, executado antes do DDL, valida container, host literal `127.0.0.1`, porta, banco, papel bootstrap superuser, IP real do servidor e versão principal. Também exige `app_private` ausente e nenhum schema/relação de aplicação, e imprime o endpoint local e o ID imutável do container. A suíte repete essas verificações e não usa `DATABASE_URL` como fallback. Qualquer falha encerra antes de DDL ou fixtures.

## Execução futura autorizada

Estes são comandos para uma etapa futura, não executados nesta preparação. Use apenas uma senha aleatória temporária, local e sem reutilização:

```bash
export RUN_POSTGRES_INTEGRATION_TESTS=1
export PG_TEST_PASSWORD="$(openssl rand -hex 32)"
export POSTGRES_TEST_LOCAL_DOCKER_ATTESTATION=1
export POSTGRES_TEST_DOCKER_HOST="$(npm run --silent test:backend:postgres:docker-preflight)"
[[ "$POSTGRES_TEST_DOCKER_HOST" == unix:///* ]] || exit 1
docker --host "$POSTGRES_TEST_DOCKER_HOST" run --detach --rm \
  --name sistema-logistica-auth-test \
  --label com.sistema-logistica.postgres-test=true \
  --publish 127.0.0.1:55432:5432 \
  --env POSTGRES_DB=sistema_logistica_auth_test \
  --env POSTGRES_USER=postgres \
  --env POSTGRES_PASSWORD="$PG_TEST_PASSWORD" \
  postgres:17.6
```

Defina a URL exclusivamente para o bootstrap do container local. A conexão nunca deve apontar a dados reais:

```bash
export TEST_DATABASE_URL="postgresql://postgres:${PG_TEST_PASSWORD}@127.0.0.1:55432/sistema_logistica_auth_test"
```

Antes de aplicar qualquer DDL, execute o preflight somente leitura e pare se ele retornar erro. Ele não aplica nem prepara o schema:

```bash
npm run test:backend:postgres:preflight
```

O endpoint já fica na variável validada antes da criação do container. Copie somente o container ID apresentado pelo preflight de schema; não substitua por nome, alias ou ID obtido de outra sessão. A aplicação é manual e só ocorre depois do preflight, sob o owner, numa transação única. O comando não está ligado ao script npm:

```bash
export POSTGRES_TEST_CONTAINER_ID='<container ID retornado pelo preflight>'
[[ "$POSTGRES_TEST_DOCKER_HOST" == unix:///* ]] || exit 1
[[ "$POSTGRES_TEST_CONTAINER_ID" =~ ^[a-f0-9]{64}$ ]] || exit 1
{ printf 'SET ROLE app_private_owner;\n'; cat backend/database/schema/001_authentication.sql; } |
  docker --host "$POSTGRES_TEST_DOCKER_HOST" exec -i "$POSTGRES_TEST_CONTAINER_ID" \
    psql -U postgres -d sistema_logistica_auth_test --single-transaction -v ON_ERROR_STOP=1
```

Depois, configure somente os grants e políticas RLS aprovados. A aplicação do esquema não instala políticas automaticamente. Só então execute a suíte:

```bash
npm run test:backend:postgres
```

Não reutilize `DATABASE_URL`, não exponha a URL no terminal/log e não use esse container para qualquer dado institucional. O script de testes não cria nem migra o schema, não executa `DROP DATABASE`, `TRUNCATE` ou limpeza genérica.

Para encerrar, use o mesmo endpoint e container ID validados com `docker --host "$POSTGRES_TEST_DOCKER_HOST" stop "$POSTGRES_TEST_CONTAINER_ID"`; `--rm` remove o container parado. Não crie volumes e não execute remoções genéricas de volumes. A aplicação manual ainda tem uma janela temporal após o preflight; mantenha a mesma sessão, endpoint e container ID, não compartilhe o container e repita o preflight se houver qualquer interrupção.

## Cobertura e limitações

Os testes consultam os catálogos PostgreSQL para schema, tabelas, constraints, FKs, índices, owner, propriedades LOGIN/NOLOGIN, grants e metadados de `pg_policies`; verificam que políticas não são atribuídas a `PUBLIC`, `anon` ou `authenticated`; e exercitam, como `app_backend`, os repositories, rollback, auditoria, criação/desativação/revogação de sessões e constraints com valores sintéticos. `app_private_owner` deve permanecer `NOLOGIN` e sem política de acesso a linhas; os testes verificam que ele não lê a fixture sintética sob `FORCE RLS`.

Os testes existentes com `FakePool` permanecem na suíte unitária e não provam comportamento real de PostgreSQL. `SET ROLE` troca `current_user`, mas mantém `session_user=postgres`; portanto, não simula login real, políticas que dependam de `session_user` ou claims JWT. A correlação do IP e socket reduz ambiguidades, mas não detecta um proxy local deliberado do socket Docker. A emulação não prova exposição da Data API: para isso será necessário Supabase local isolado e testes HTTP de PostgREST, sem dados reais. A imagem `17.6` é apenas o alvo local fixado e deve ser comparada com a versão principal do Supabase pretendido antes da aprovação da integração.