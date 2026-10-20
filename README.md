# sistema-logistica-web
Sistema de Serviços de Logística e Manutenção

## Desenvolvimento

Inicie a API e o frontend em terminais separados:

```sh
npm run dev:backend
npm --prefix frontend run dev
```

O frontend encaminha chamadas `/api` para a API local na porta 3000. O endpoint
`GET /api/health` confirma a disponibilidade do backend.

## Build

```sh
npm run build:frontend
npm run build:backend
```

O comando `npm run build` executa os dois builds em sequência.

## Autenticação

A autenticação usa PostgreSQL. Forneça `DATABASE_URL` pelo ambiente de execução
e configure `INSTITUTIONAL_EMAIL_DOMAINS` como lista separada por vírgulas dos
domínios autorizados para solicitar uma conta. `FRONTEND_URL` define a origem
principal; `FRONTEND_ORIGINS` pode acrescentar origens confiáveis. Em produção,
use HTTPS e `NODE_ENV=production` para habilitar cookies `Secure`.

O backend carrega `backend/.env` sem substituir variáveis já fornecidas pelo
ambiente. Consulte `backend/.env.example` para os nomes de configuração, sem
armazenar credenciais no repositório. A conexão `pg` sempre exige TLS com
validação do certificado e do hostname (`rejectUnauthorized: true`). Para usar
o root CA do projeto Supabase, obtenha-o em Project Settings → Database → SSL
Configuration e configure `DATABASE_CA_CERT_PATH` com um caminho relativo a
`backend/` (por exemplo, em `backend/certificates/`). Também é aceito
`sslrootcert` na URL; os parâmetros SSL da URL são normalizados para que não
substituam as opções TLS validadas pelo backend. Não use `sslmode=no-verify`.

O schema necessário está em `backend/migrations/001_authentication.sql`. Ele
ainda precisa ser aplicado pelo processo de migração aprovado pela equipe; o
servidor não executa SQL de alteração automaticamente. Sem banco/schema
disponível, `/api/health` continua respondendo, enquanto autenticação retorna
`503`.

### Aplicação da migração de autenticação

Execute a migração uma única vez, por uma pessoa autorizada, usando o papel
PostgreSQL confiável que será usado pelo backend em `DATABASE_URL` ou um papel
proprietário que conceda ao backend apenas as permissões necessárias. O script
usa uma transação: qualquer conflito ou falha aborta e reverte toda a migração.
Ele não usa `IF NOT EXISTS`; objetos preexistentes com esses nomes precisam ser
investigados, não ignorados.

As três tabelas usam RLS e revogam privilégios de `PUBLIC`; quando existirem, os
papéis Supabase `anon`, `authenticated` e `service_role` também têm os
privilégios de tabela e sequence revogados. Nenhuma policy concede acesso pela
Data API. O proprietário PostgreSQL usado pelo backend é confiável e pode
bypassar RLS; por isso a proteção principal é manter `DATABASE_URL` somente no
backend e não conceder esses objetos aos papéis de cliente. Se o backend usar um
papel separado do proprietário, conceda somente os privilégios de que ele
precisa por um procedimento operacional controlado; não use `anon` ou
`authenticated` para a conexão do servidor.

Para provisionar o primeiro administrador, injete `AUTH_INITIAL_ADMIN_KEY`
(segredo temporário de pelo menos 32 bytes) no ambiente confiável de execução e
rode `npm run auth:create-admin` em um terminal interativo conectado ao banco.
O comando verifica que não há administrador ativo, pede novamente a chave e
solicita senha sem eco no terminal. Não existe usuário ou senha padrão nem rota
pública para promover contas. Remova a chave temporária do ambiente depois do
bootstrap.

As rotas implementadas são `POST /api/auth/register`, `POST /api/auth/login`,
`GET /api/auth/session`, `POST /api/auth/logout`, `GET
/api/admin/registration-requests`, `POST
/api/admin/registration-requests/:userId/decision` e `POST
/api/admin/users/:userId/block`. Rotas futuras que retornem CPF devem aplicar o
middleware `requirePermission(repository, 'flights:cpf:read')`; ele exige a
concessão explícita e audita o recurso sem registrar o CPF.

As tabelas de autenticação/auditoria e a camada de persistência estão definidas
na migração, mas cadastro, login e aprovação não ficam operacionais até que a
equipe aplique o schema e configure as variáveis de ambiente no serviço. As APIs
de negócio dos módulos ainda não existem; a política RBAC fica preparada para
ser aplicada a elas quando forem implementadas.
