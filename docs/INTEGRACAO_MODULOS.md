# Integração de permissões nos módulos

Situação em 03/11/2026. As rotas protegidas estão em `backend/src/routes/routeAccessMap.ts`, que é verificado por teste contra o Express: uma rota nova fora do mapa faz os testes falharem.

## O que ainda não tem API

Nestas áreas, o bloqueio existe **só na tela**. Elas não guardam dados no servidor, e nenhuma proteção de backend pode ser declarada até a rota existir.

| Área | Situação atual | Permissões já previstas |
|---|---|---|
| Solicitações (Manutenção, Frota, Passagens) | Formulários sem envio e listas vazias | `requests:*`, `maintenance:*`, `fleet:*`, `flights:*` |
| Agendamento | Tela sem eventos | `requests:schedule`, `maintenance:schedule`, `fleet:schedule` |
| Configurações | Somente em `localStorage` do navegador | `settings:read`, `settings:manage` |
| Almoxarifado | Telas demonstrativas | `warehouse:read`, `warehouse:manage` |
| Agenda | Tela sem eventos | `calendar:read`, `calendar:manage` |
| Relatórios | Tela sem dados | `reports:read` |

A exceção em Passagens são os passageiros: `GET /flights/requests/:requestId/passengers` e `GET /flights/passengers/:passengerId/cpf` existem e dependem da migração 004.

## Como criar uma rota nova

```ts
router.use('/modulo', requireAuth, requireCsrf)
router.get('/modulo/itens', requirePermission('modulo:read'), handler)
```

1. Monte o router com caminho, para a proteção não alcançar outras rotas.
2. Classifique a rota em `routeAccessMap.ts`. Os testes passam a exigir a permissão, a sessão e o CSRF.
3. Use a identidade de `response.locals.authenticatedUser`. Nunca leia usuário, perfil, setor, equipe ou permissões do corpo, da URL ou de cabeçalhos.
4. Recurso sem acesso responde 404, para não revelar que existe.

## Solicitações

Funções prontas em `backend/src/auth/requestPolicy.ts`, ainda sem rota que as use em produção:

| Operação | Função | Regra |
|---|---|---|
| Criar | `resolveRequestOwnership` | Grave o resultado, e não o corpo da requisição. O solicitante é sempre quem está na sessão |
| Criar em nome de outro setor | a mesma | Exige `requests:create_on_behalf` **e** equipe SLM. Ser do CPC não basta |
| Listar | filtro no SQL | Sem `requests:read_all`, filtre por `solicitante_id = sessão` na consulta, e não depois |
| Consultar uma | `canReadRequest` | Sem acesso, responda 404 |
| Atualizar | `canUpdateRequest` | `requests:update` e `<módulo>:update` |
| Agendar | `canScheduleRequest` | `requests:schedule` e a permissão do módulo |
| Cancelar | `canCancelRequest` | `requests:cancel` e acesso à solicitação |

Falta decidir ou criar:

- **Quem abriu e para quem:** `service_requests` só tem `solicitante_id`. Para registrar quem da SLM abriu uma solicitação em nome de outra pessoa, será preciso uma coluna nova, como `aberto_por`, em uma migração futura.
- **Setor:** `auth_users.sector` é texto livre e `setor_id` nunca é preenchido. A regra compara o texto, sem diferenciar maiúsculas. Quando os setores forem administrados no servidor, deve comparar `setor_id`.
- **Formulários:** os campos de solicitante e setor são digitados ou escolhidos livremente na tela. A rota deve ignorá-los, como acima.
- **Permissões `*:manage`:** existem no catálogo, mas ainda não liberam nenhuma operação.

## Configurações

Quando existir API:

- `GET` exige `settings:read`; `POST`, `PATCH` e ativar ou desativar exigem `settings:manage`.
- Não ofereça exclusão: a desativação preserva as solicitações antigas.
- Solicitações devem guardar o nome da opção usada, além do identificador, para que renomear não reescreva o histórico.
- Os dados atuais do `localStorage` precisam de um caminho de migração. Esse armazenamento é provisório.

Na tela de hoje, a lista de setores, andares e tipos só é desativada, nunca apagada. O editor de formulários permite remover campos personalizados e opções desses campos, o que precisa ser revisto quando houver dados reais.

## Almoxarifado

É conferência de inventário: compara a quantidade do sistema governamental com a encontrada internamente. **Não há fluxo de pedidos.**

Ainda existem resquícios de pedidos, sem funcionamento: as tabelas `material_requests` e `material_request_items` no banco, e o botão desativado "Solicitar" e os textos de solicitação em `/portal/almoxarifado`. A tela `/almoxarifado` também mostra botões desativados de entrada e saída.

## Dependência das migrações

| Migração | Sem ela |
|---|---|
| 002 | A recuperação de senha responde normalmente, mas não envia código |
| 003 | Alterar perfil, equipe SLM ou permissões responde 503 com `ACCESS_MIGRATION_REQUIRED` |
| 004 | As rotas de passageiros e CPF respondem 503 |

Nenhuma foi aplicada no banco real. Consulte `backend/database/POSTGRES_INTEGRATION_TESTS.md`.
