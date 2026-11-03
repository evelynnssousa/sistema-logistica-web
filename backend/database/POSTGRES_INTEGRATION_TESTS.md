# Esquema do banco e testes de integração

## Esquema

- `schema/001_public_schema_snapshot.sql`: cópia, só de estrutura, do schema `public` do banco real. É referência do que já existe lá. **Não aplique no banco real.**
- `schema/002_password_recovery.sql`: tabela de códigos de recuperação de senha. **Ainda não existe no banco real** e precisa ser aplicada em uma etapa autorizada. Até lá, a recuperação de senha não envia código.

- `schema/003_user_access.sql`: perfil, equipe SLM e permissões individuais. **Pendente de aprovação; não foi aplicada.**
- `schema/004_flight_passengers.sql`: passageiros e CPF, fora de `service_requests.dados`. **Pendente de aprovação; não foi aplicada.**

### Migrações 003 e 004

Aplique em ordem, uma vez, depois de um backup. As duas são independentes da 002 e apenas criam tabelas: não alteram `auth_users`, `auth_sessions` nem `auth_audit_events`.

| Situação | O que funciona |
|---|---|
| Sem a 003 | Login, sessões, aprovação de cadastros, consulta e ativação de usuários. O acesso é calculado pelas colunas antigas de `auth_users`. Alterar perfil, equipe SLM ou permissões responde 503 com `ACCESS_MIGRATION_REQUIRED`. |
| Com a 003 | Tudo acima, mais a edição de acesso. A API percebe a tabela nova em até 30 segundos, sem reiniciar, e as sessões abertas continuam valendo. |
| Sem a 004 | Consultas de passageiros e CPF respondem 503. |

O que a 003 grava em cada conta já decidida:

- `role = 'admin'` vira perfil Administrador.
- `role = 'operator'` com escrita em algum módulo vira Operador SLM **e entra na equipe SLM**, por já ter esse acesso. Confira a lista depois de aplicar e retire quem não for da equipe.
- Os demais viram Solicitante.
- `flights:cpf:read`, `settings:read`, `settings:write` e `warehouse:write` antigos viram concessões individuais. Nenhuma conta ganha acesso ao CPF.

Para desfazer, veja o comentário no início de cada arquivo e reinicie a API.

A revisão completa de cada migração e o procedimento de backup estão em `docs/BACKUP_E_MIGRACOES_SUPABASE.md`.

Para atualizar o snapshot, rode `pg_dump` com `--schema-only --schema=public --no-owner --no-privileges` e remova `CREATE SCHEMA public;` e as linhas `\restrict` e `\unrestrict`.

## Testes de integração

`publicSchemaIntegration.test.ts`, `accessMigration.test.ts` e `userManagementIntegration.test.ts` **apagam o schema `public`** do banco de destino e recriam a estrutura. Por isso eles só aceitam um banco local (`127.0.0.1` ou `localhost`) com nome terminado em `_test`.

Use o comando que cria um PostgreSQL descartável, roda os testes e o remove:

```bash
npm run test:integration
```

`npm run test:backend:postgres` é a etapa interna dele, e `DATABASE_URL` nunca serve de substituta para `TEST_DATABASE_URL`. Consulte `docs/AMBIENTES.md`.
