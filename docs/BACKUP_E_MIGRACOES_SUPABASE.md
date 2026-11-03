# Backup e migrações no Supabase

## Conexão

A API conecta ao PostgreSQL do Supabase por `backend/src/database/pool.ts`, com o driver `pg`.

| Variável | Uso | Obrigatória |
|---|---|---|
| `DATABASE_URL` | Endereço do banco, pelo session pooler (porta 5432) | Sim |
| `DB_POOL_MAX` | Limite de conexões da API | Não (padrão 5) |
| `DATABASE_SSL_CA_PATH` | Outro certificado de CA | Não |
| `PASSWORD_RESET_PEPPER`, `RESEND_API_KEY`, `RESEND_FROM` | Recuperação de senha | Só para essa função |
| `SESSION_CLEANUP_ENABLED` | Liga ou desliga a limpeza de sessões | Não |

Bancos remotos sempre usam TLS verificado com `backend/certificates/prod-ca-2021.crt`.

O projeto não usa as APIs do Supabase (Auth, Storage, PostgREST): a API própria acessa o PostgreSQL diretamente.

## Backup

### Métodos

| Método | Situação |
|---|---|
| `pg_dump` pelo session pooler | **Testado.** É o recomendado antes de cada migração |
| Backups automáticos do painel do Supabase | Depende do plano. Confira em Database → Backups: não é visível pelo banco |
| Transaction pooler (porta 6543) | Não use com `pg_dump` |
| `pg_dumpall` | Não funciona: o papel `postgres` do Supabase não é superusuário |

### Gerar

Exige Docker (usa a imagem `postgres:17`, mesma versão principal do servidor):

```bash
npm run backup:database
```

O arquivo vai para `backups/`, que o Git ignora, com permissão só para o dono. O `pg_dump` trabalha em uma transação somente de leitura e não altera o banco.

**O arquivo contém dados pessoais e hashes de senha.** Não o envie por e-mail ou chat, não o coloque no repositório e guarde-o em local com acesso restrito.

### Conferir

O comando mostra o SHA-256 e as contagens. Para um backup válido do banco atual, espere:

| Item | Esperado |
|---|---|
| Tabelas | 11 |
| Blocos de dados | 11 |
| Índices | 17 (os demais vêm das chaves) |
| Chaves estrangeiras | 18 |
| Tabelas com RLS | 11 |
| Políticas de RLS | 0 |
| Privilégios | 18 |

Anote o SHA-256 e confirme depois com `sha256sum <arquivo>`. Um backup só é confiável depois de restaurado, como abaixo.

### Restaurar em ambiente separado

**Nunca aponte estes comandos para o Supabase.** Eles criam um banco descartável na própria máquina:

```bash
export PGPASSWORD_RESTORE="$(openssl rand -hex 16)"
docker run -d --name slm-restauro --rm \
  -e POSTGRES_PASSWORD="$PGPASSWORD_RESTORE" -e POSTGRES_DB=restauro_test \
  -p 127.0.0.1:55442:5432 --tmpfs /var/lib/postgresql/data postgres:17

# Aguarde alguns segundos. Os papéis do Supabase precisam existir para restaurar os privilégios.
docker exec -i slm-restauro psql -U postgres -d restauro_test -c "
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS; CREATE ROLE supabase_admin NOLOGIN;
  DROP SCHEMA public CASCADE;"

docker run --rm --network host -e PGPASSWORD="$PGPASSWORD_RESTORE" \
  -v "$PWD/backups:/d" postgres:17 pg_restore --host=127.0.0.1 --port=55442 \
  --username=postgres --dbname=restauro_test --exit-on-error /d/<arquivo>.dump

docker exec -i slm-restauro psql -U postgres -d restauro_test \
  -c "SELECT count(*) FROM public.auth_users; SELECT count(*) FROM public.auth_audit_events;"

docker stop slm-restauro
```

Compare as contagens com as do banco de origem. Como o banco usa `tmpfs`, os dados somem ao parar o container.

### O que precisa ser preservado

- **Dados:** as 11 tabelas de `public`, principalmente `auth_users` (com os hashes de senha), `auth_audit_events` e `auth_sessions`.
- **Estrutura:** colunas, `CHECK`, chaves estrangeiras, índices, gatilhos e funções.
- **Segurança:** RLS ativo nas 11 tabelas e privilégios de cada papel.
- **Sequências:** o contador de `auth_audit_events` e os protocolos.
- **Fora do banco:** `backend/.env` e os segredos ficam em local próprio. O backup não os contém.

`auth`, `storage`, `realtime` e `vault` são administrados pelo Supabase. O sistema não os usa, e hoje `auth.users` e `storage.objects` estão vazios, por isso não entram neste backup. Se passarem a ser usados, será preciso rever o procedimento.

## Migrações pendentes

Nenhuma foi aplicada. O banco também não tem tabela de registro de migrações: hoje, a presença de cada tabela é o único registro.

Faça um backup antes e aplique uma de cada vez, conferindo o resultado. Cada arquivo já tem sua própria transação.

| | 002_password_recovery | 003_user_access | 004_flight_passengers |
|---|---|---|---|
| **Cria** | `password_recovery_codes` | `auth_user_access` | `flight_request_passengers` |
| **Altera dados existentes** | Não | Não; apenas lê `auth_users` para preencher a tabela nova | Não |
| **Depende de** | `auth_users` | `auth_users` | `service_requests` |
| **Depende de outra migração** | Não | Não | Não |
| **Libera** | Recuperação de senha, com as 3 variáveis configuradas | Edição de perfil, equipe SLM e permissões | Consulta de passageiros e CPF |
| **Sem ela** | A recuperação responde normalmente, mas não envia código | Essa edição responde 503 | Essas rotas respondem 503 |
| **Reverter** | `DROP TABLE public.password_recovery_codes;` | `DROP TABLE public.auth_user_access;` | `DROP TABLE public.flight_request_passengers;` |
| **O que se perde ao reverter** | Códigos em andamento | Permissões individuais e equipe SLM definidas depois | **CPFs cadastrados.** Não reverta se já houver dados |

Reinicie a API depois de reverter a 003.

### O que a 003 faz com cada conta

| Conta atual | Resultado |
|---|---|
| `role = admin` | Administrador, fora da equipe SLM |
| `role = operator` com escrita em módulo | Operador SLM **dentro da equipe**, com `warehouse:manage` se já tinha `warehouse:write` |
| `role = operator` sem escrita | Solicitante |
| Pendente ou rejeitada | Sem linha; ganha ao ser aprovada |

### Riscos

- **Bloqueio:** criar a chave estrangeira bloqueia escritas em `auth_users` por um instante. Com o volume atual, é imperceptível.
- **Privilégios padrão:** o Supabase concede automaticamente acesso a `anon` e `authenticated` em tabelas novas. As três migrações retiram esse acesso, o que foi conferido. **Migrações futuras precisam fazer o mesmo.**
- **CPF sem criptografia:** a 004 guarda o número em texto, protegido por acesso e auditoria. Decida antes de cadastrar passageiros reais.

## Testes e desenvolvimento

Consulte `docs/AMBIENTES.md`. **`npm run dev:backend` usa o banco de `backend/.env`**: o que for feito nessa API grava no banco real.
