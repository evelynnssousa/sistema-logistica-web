# Esquema do banco e testes de integração

## Esquema

- `schema/001_public_schema_snapshot.sql`: cópia, só de estrutura, do schema `public` do banco real. É referência do que já existe lá. **Não aplique no banco real.**
- `schema/002_password_recovery.sql`: tabela de códigos de recuperação de senha. **Ainda não existe no banco real** e precisa ser aplicada em uma etapa autorizada. Até lá, a recuperação de senha não envia código.

- `schema/003_user_access.sql`: perfil, equipe SLM e permissões individuais. **Pendente de aprovação; não foi aplicada.** Reversão em `schema/003_user_access.rollback.sql`.
- `schema/004_flight_passengers.sql`: passageiros e CPF, fora de `service_requests.dados`. **Pendente de aprovação; não foi aplicada.**
- `schema/005_operational_modules.sql`: estrutura dos módulos operacionais. **Pendente de aprovação; não foi aplicada.** Depende da 003 e da 004. Reversão em `schema/005_operational_modules.rollback.sql`. Detalhes em `docs/BACKUP_E_MIGRACOES_SUPABASE.md`.
- `schema/006_integrations.sql`: fila de e-mails, notificações e sincronização de agenda. **Pendente de aprovação; não foi aplicada.** Depende da 005. Reversão em `schema/006_integrations.rollback.sql`.

### Migrações 003 e 004

Aplique em ordem, uma vez, depois de um backup. As duas são independentes da 002. Não alteram colunas nem registros de `auth_users`, `auth_sessions` ou `auth_audit_events`; a 003 acrescenta em `auth_users` um gatilho que recusa divergência com a tabela nova.

| Situação | O que funciona |
|---|---|
| Sem a 003 | Login, sessões, aprovação de cadastros, consulta e ativação de usuários. O acesso é calculado pelas colunas antigas de `auth_users`. Alterar perfil, equipe SLM ou permissões responde 503 com `ACCESS_MIGRATION_REQUIRED`. |
| Com a 003 | Tudo acima, mais a edição de acesso. A API percebe a tabela nova em até 30 segundos, sem reiniciar, e as sessões abertas continuam valendo. |
| Sem a 004 | Consultas de passageiros e CPF respondem 503. |

O que a 003 grava em cada conta já decidida:

- `role = 'admin'` vira perfil Administrador, fora da equipe SLM.
- `role = 'operator'` vira Solicitante, fora da equipe, sem permissões especiais.
- **Se houver `operator` aprovado com escrita em algum módulo, a migração para com erro**, para ninguém perder o acesso sem aviso.
- `settings:read` e `settings:write` antigos viram concessões individuais. CPF e `warehouse:write` antigos não são convertidos.

Para desfazer a 003, use `schema/003_user_access.rollback.sql`. Para a 004, veja o comentário no início do arquivo. Depois, reinicie a API.

A revisão completa de cada migração e o procedimento de backup estão em `docs/BACKUP_E_MIGRACOES_SUPABASE.md`.

Para atualizar o snapshot, rode `pg_dump` com `--schema-only --schema=public --no-owner --no-privileges` e remova `CREATE SCHEMA public;` e as linhas `\restrict` e `\unrestrict`.

## Testes de integração

`publicSchemaIntegration.test.ts`, `accessMigration.test.ts`, `userManagementIntegration.test.ts` e `operationalModulesIntegration.test.ts` **apagam o schema `public`** do banco de destino e recriam a estrutura. Por isso eles só aceitam um banco local (`127.0.0.1` ou `localhost`) com nome terminado em `_test`.

Use o comando que cria um PostgreSQL descartável, roda os testes e o remove:

```bash
npm run test:integration
```

`npm run test:backend:postgres` é a etapa interna dele, e `DATABASE_URL` nunca serve de substituta para `TEST_DATABASE_URL`. Consulte `docs/AMBIENTES.md`.
