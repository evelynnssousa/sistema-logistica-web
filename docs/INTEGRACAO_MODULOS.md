# Integração de permissões nos módulos

Situação ao fim do Supercomando 01. As rotas protegidas estão em `backend/src/routes/routeAccessMap.ts`, que é verificado por teste contra o Express: uma rota nova fora do mapa faz os testes falharem.

## Situação das áreas

Todas têm API e persistência, e dependem da migração 005, ainda não aplicada no banco real. Sem ela, respondem 503 e não gravam.

| Área | Rotas | Permissões |
|---|---|---|
| Solicitações (Manutenção, Frota, Passagens) | `/maintenance`, `/fleet` e `/flights`, em `routes/requests.ts` | `requests:*`, `maintenance:*`, `fleet:*`, `flights:*` |
| Configurações | `/catalog` e `/settings/catalog`, em `routes/settings.ts` | `settings:read`, `settings:manage` |
| Almoxarifado | `/warehouse`, em `routes/warehouse.ts` | `warehouse:read`, `warehouse:manage` e, para abrir pedidos, `requests:create` |
| Painel, relatórios e agenda | `/dashboard`, `/reports` e `/calendar`, em `routes/insights.ts` | Sessão, `reports:read` e `calendar:read` |
| Controle de Demandas | `/demands`, em `routes/demands.ts` | Ter um dos quatro perfis (Servidor, Chefe, Diretor ou Administrador), conferido na rota; `demands:directorate` e `demands:configure`. Veja `CONTROLE_DE_DEMANDAS.md` |
| Notificações e integrações | `/notifications` e `/integrations`, em `routes/integrations.ts` | Sessão, `integrations:read` e `integrations:manage` |

Só o editor de campos dos formulários continua no `localStorage` do navegador.

`GET /dashboard/summary` passou a devolver também `byPeriod`, a série mensal usada no Dashboard, sempre no alcance de quem consulta. Foi um acréscimo: os campos anteriores não mudaram.

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

Funções em `backend/src/auth/requestPolicy.ts`, usadas pelas rotas:

| Operação | Função | Regra |
|---|---|---|
| Criar | `resolveRequestOwnership` | Grave o resultado, e não o corpo da requisição. O solicitante é sempre quem está na sessão |
| Criar em nome de outro setor | a mesma | Exige equipe SLM, perfil elegível e concessão individual de `requests:create_on_behalf`, inclusive para administradores. Ser do CPC não basta |
| Listar | filtro no SQL | Sem `requests:read_all`, filtre por `solicitante_id = sessão` na consulta, e não depois |
| Consultar uma | `canReadRequest` | Sem acesso, responda 404 |
| Atualizar | `canUpdateRequest` | `requests:update` e `<módulo>:update` |
| Agendar | `canScheduleRequest` | Administrador ou Operador SLM, na equipe SLM, pelo perfil (desde 08/11/2026); sempre com a permissão do módulo. Retirada individual prevalece. Solicitante nunca |
| Cancelar | `canCancelRequest` | `requests:cancel` e acesso à solicitação |
| Cancelar a própria | `canCancelOwnRequest` | `requests:cancel_own` (só concessão individual), ser quem abriu e a solicitação ainda aguardar agendamento ou estar em cotação; conferido de novo na transação |
| Consultar CPF completo | `canReadFullCpf` | Administrador ou Operador SLM, na equipe SLM, com concessão individual de `flights:cpf:read`, `flights:read` e acesso à solicitação. Nenhum perfil concede |

Permissões especiais: `requests:schedule`, `requests:create_on_behalf` e `flights:cpf:read`. A regra de elegibilidade está em `backend/src/auth/permissions.ts`. O servidor retira as concedidas individualmente ao sair da equipe, ao passar para Solicitante e ao desativar a conta, e elas não voltam sozinhas. `requests:schedule`, `warehouse:manage` e `warehouse:forecast` também fazem parte do perfil Operador SLM e só valem enquanto a pessoa integrar a equipe: voltam com a equipe, porque vêm do perfil, e não de concessão.

Como ficou:

- **Quem abriu e para quem:** `service_requests.aberto_por` e `em_nome_de_outro_setor`. O solicitante continua sendo quem está na sessão.
- **Setor:** `auth_users.sector` segue como texto livre. O setor da solicitação é copiado para `setor_nome`, e `setor_id` é preenchido quando o nome corresponde a um setor cadastrado.
- **Formulários:** identidade e setor aparecem somente para leitura, e a API ignora esses campos no corpo.
- **Status e transições:** somente em `backend/src/requests/workflow.ts`. Transição indevida responde 409.
- **Permissões `*:manage` de solicitações, e `calendar:manage`:** existem no catálogo, mas ainda não liberam nenhuma operação.
- **Nova ação em um módulo:** publique o acontecimento com `publishIntegrationEvent`, dentro da transação, depois do histórico e da auditoria. Veja `INTEGRACOES_E_AUTOMACOES.md`.

## Configurações

- `GET /catalog` entrega as opções ativas a qualquer sessão. `GET /settings/catalog` exige `settings:read`; `POST`, `PATCH`, ativar e desativar exigem `settings:manage`.
- Não há exclusão. Os registros guardam o nome usado, além do identificador, e renomear não reescreve o histórico.
- A tela oferece copiar para o servidor os cadastros antigos do `localStorage`, sem apagá-los.
- O editor de formulários grava em `PUT /settings/parameters/forms`, com `settings:manage`, e os formulários leem de `GET /forms/definitions`, com qualquer sessão. Sem personalização gravada, valem os campos padrão. A API recusa uma solicitação sem um campo obrigatório criado no editor.

## Almoxarifado

Pedidos com duas origens em uma só central, catálogo de materiais e conferência de inventário. **O sistema não se comunica com o sistema governamental:** a origem "governamental" é uma cópia digitada, e a tela diz isso.

A entrega e a conferência **não movimentam** `materials.estoque_atual` nem `stock_movements`, porque a decisão sobre quem controla o estoque oficial está em aberto. Veja `PLANO_DESENVOLVIMENTO_INTEGRAL.md`.

A previsão de entrega fica no próprio pedido, em `PUT /warehouse/requests/:requestId/delivery-forecast`, com `warehouse:manage`. Regras em `requests/deliveryRules.ts`. A situação da entrega é calculada na leitura, e a data efetiva continua em `entregue_em`. O histórico fica em `material_delivery_history`, separado de `material_request_history`, porque este é exibido ao solicitante.

Como a pessoa de um pedido digitado pode não ter conta, ela é identificada pelo e-mail informado pela equipe. A conta aprovada com esse e-mail recebe uma visão restrita do pedido (`limitedView`), montada em lista fechada em `routes/warehouse.ts`. Sem conta, recebe só o e-mail.

## Modelos e formulários

Rotas em `routes/configuration.ts`, com as regras em `requests/formRules.ts` e `integrations/templateVariables.ts`. Variável nova entra na biblioteca fechada, e nunca para CPF ou passageiros. Campo novo em um formulário padrão precisa entrar em `defaultForms` e em `formDefinitions.ts`.

## Dependência das migrações

| Migração | Sem ela |
|---|---|
| 002 | A recuperação de senha responde normalmente, mas não envia código |
| 003 | Alterar perfil, equipe SLM ou permissões responde 503 com `ACCESS_MIGRATION_REQUIRED` |
| 004 | As rotas de passageiros e CPF respondem 503 |
| 005 | Os módulos operacionais respondem 503 com `MODULES_MIGRATION_REQUIRED` |

Nenhuma foi aplicada no banco real. Consulte `backend/database/POSTGRES_INTEGRATION_TESTS.md`.
