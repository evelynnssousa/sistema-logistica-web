# Esquema do banco e testes de integração

## Esquema

- `schema/001_public_schema_snapshot.sql`: cópia, só de estrutura, do schema `public` do banco real. É referência do que já existe lá. **Não aplique no banco real.**
- `schema/002_password_recovery.sql`: tabela de códigos de recuperação de senha. **Ainda não existe no banco real** e precisa ser aplicada em uma etapa autorizada. Até lá, a recuperação de senha não envia código.

Para atualizar o snapshot, rode `pg_dump` com `--schema-only --schema=public --no-owner --no-privileges` e remova `CREATE SCHEMA public;` e as linhas `\restrict` e `\unrestrict`.

## Testes de integração

`publicSchemaIntegration.test.ts` **apaga o schema `public`** do banco de destino e recria a estrutura. Por isso ele só aceita um banco local (`127.0.0.1` ou `localhost`) com nome terminado em `_test`.

Suba um PostgreSQL descartável, com uma senha aleatória e sem gravá-la em arquivos:

```bash
export TEST_DB_PASSWORD="$(openssl rand -hex 16)"
docker run -d --name slm-public-test --rm \
  -e POSTGRES_PASSWORD="$TEST_DB_PASSWORD" -e POSTGRES_DB=slm_public_test \
  -p 127.0.0.1:55432:5432 --tmpfs /var/lib/postgresql/data postgres:17
export TEST_DATABASE_URL="postgresql://postgres:$TEST_DB_PASSWORD@127.0.0.1:55432/slm_public_test"
```

Quando o banco estiver pronto, rode os testes e remova o container:

```bash
npm run test:backend:postgres
docker stop slm-public-test
```
