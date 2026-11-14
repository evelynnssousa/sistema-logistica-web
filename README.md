# sistema-logistica-web
Sistema de Serviços de Logística e Manutenção

## Manual de uso

O passo a passo de cada função, com imagens, está em [`docs/manual/MANUAL.md`](docs/manual/MANUAL.md).

## Ambientes

**Leia `docs/AMBIENTES.md` antes de testar qualquer coisa.** O desenvolvimento usa o Supabase real.

| Ambiente | Banco | Comando |
|---|---|---|
| Desenvolvimento | **Supabase real**: grava dados reais | `npm run dev:backend` e `npm run dev:frontend` |
| Testes do backend | Nenhum | `npm run test:backend` |
| Testes de integração | PostgreSQL descartável | `npm run test:integration` |
| Testes de navegador | PostgreSQL descartável, em portas próprias | `npm run test:e2e` |

## Instalação

Uma vez, na raiz:

```bash
npm ci
npm --prefix frontend ci
npx playwright install chromium   # Somente para os testes de navegador
```

Backend e frontend de desenvolvimento rodam separadamente, cada um em seu terminal. Abra a porta **5173**. Sem a API no ar, a tela informa que ela está indisponível.

## Verificações

| Comando | O que faz |
|---|---|
| `npm run verify` | Tipos, ESLint, testes do backend e builds |
| `npm run test:all` | Tudo acima, mais integração, backup e navegador (exige Docker) |
| `npm run audit:all` | `npm audit` do backend e do frontend |
| `npm run backup:database` | Backup do banco configurado, somente leitura (ver `docs/BACKUP_E_MIGRACOES_SUPABASE.md`) |
| `npm run backup:verify -- <arquivo>` | Confere a cópia e testa a restauração em banco descartável |
| `npm run test:backup` | Prova o caminho da cópia à restauração, só com dados fictícios |
| `npm run build:backend && npm run start:backend` | Executa a versão compilada em modo de produção |

## Permissões

O acesso é calculado no servidor a cada requisição: perfil + concessões individuais − retiradas. O catálogo fica em `backend/src/auth/permissions.ts`, e as regras de solicitações em `backend/src/auth/requestPolicy.ts`. Rotas novas devem usar `requireAuth`, `requirePermission` e, em escrita, `requireCsrf`. Toda rota nova precisa ser classificada em `backend/src/routes/routeAccessMap.ts`, ou os testes falham. As regras de cada módulo estão em `docs/INTEGRACAO_MODULOS.md`.

A edição de perfis e permissões depende da migração `003`, os módulos operacionais, da `005`, as comunicações automáticas, da `006`, e as funções do Supercomando 04, da `007` à `010`. Nenhuma foi aplicada no banco real. Nenhuma integração externa está ativa: veja `docs/INTEGRACOES_E_AUTOMACOES.md` e `docs/PRIVACIDADE_E_TRATAMENTO_DE_DADOS.md`. Consulte `backend/database/POSTGRES_INTEGRATION_TESTS.md`.

## Planejamento

O andamento, as decisões e as pendências estão em `docs/PLANO_DESENVOLVIMENTO_INTEGRAL.md`, e os requisitos em `docs/REQUISITOS_FUNCIONAIS.md`.
