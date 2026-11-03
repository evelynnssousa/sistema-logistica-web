# Ambientes do sistema

| | Desenvolvimento | Testes automatizados | Testes de navegador |
|---|---|---|---|
| **Banco** | **Supabase real**, de `backend/.env` | Nenhum, ou PostgreSQL descartável | PostgreSQL descartável |
| **Grava dados reais?** | **Sim** | Não | Não |
| **Portas** | API 3000, tela 5173 | Banco 55902 (só integração) | API 3901, tela 5901, banco 55901 |
| **Contas** | Reais | Fictícias | Fictícias, com senha nova a cada execução |
| **Comando** | `npm run dev:backend` e `npm run dev:frontend` | `npm run test:backend` e `npm run test:integration` | `npm run test:e2e` |

## Desenvolvimento, ligado ao Supabase real

```bash
npm run dev:backend    # API na porta 3000
npm run dev:frontend   # Tela na porta 5173
```

**Tudo o que for feito por essa tela ou API grava em dados reais**: logins, cadastros, aprovações e falhas de login entram no banco e na auditoria. Ao iniciar, a API avisa no terminal: `Banco de dados: REMOTO`.

Não use esse ambiente para experimentar cadastros ou aprovações, nem aponte ferramentas de teste para ele. Em um banco remoto, a API recusa o cadastro e a entrada de contas com domínios reservados, como `example.gov.br`, `.test` e `.invalid`.

Com `tsx watch`, salvar um arquivo do backend reinicia a API. Iniciar a API não grava nada: a limpeza de sessões só roda sozinha em produção.

## Testes automatizados

```bash
npm run test:backend       # Sem banco nenhum
npm run test:integration   # Cria um PostgreSQL descartável, testa e o remove (exige Docker)
```

`npm run test:backend:postgres` é a etapa interna do segundo comando. Só rode diretamente com `TEST_DATABASE_URL` apontando para um banco local com nome terminado em `_test`.

## Testes de navegador

Uma vez, para instalar o navegador:

```bash
npx playwright install chromium
```

Depois:

```bash
npm run test:e2e
```

O comando faz tudo sozinho e pode rodar com os servidores de desenvolvimento no ar, porque não os utiliza. **Se uma porta de teste estiver ocupada, ele para com uma mensagem indicando o processo**, sem encerrar nem reutilizar nada.

**Não rode ferramentas de navegador manualmente contra as portas 3000 e 5173.** Foi assim que contas de teste chegaram ao banco real.

Novos cenários entram em `e2e/`. Eles recebem o endereço e a senha do executor e não podem ter endereços fixos nem ler variáveis de ambiente.

## Tudo de uma vez

```bash
npm run test:all   # Tipos, ESLint, testes, builds, integração e navegador
npm run audit:all
```

## Proteções contra o banco real

| Camada | O que impede |
|---|---|
| Trava de rede (`backend/testing/block-remote-connections.cjs`) | Qualquer conexão TCP para fora da máquina, seja qual for a biblioteca |
| Carregamento do `.env` (`loadEnvironment.ts`) | Em teste, as credenciais do arquivo não entram no processo |
| Pool de conexões (`pool.ts`, `databaseSafety.ts`) | Em teste, recusa banco que não seja local com nome terminado em `_test`, mesmo com `DATABASE_URL` definida |
| Ambiente mínimo (`scripts/testing/isolation.cjs`) | Os processos de teste não herdam variáveis do terminal |
| Portas | Os executores recusam 3000 e 5173, e também qualquer porta ocupada |
| Identificador da execução | O executor cancela se quem responde não for o seu backend, e cada resposta da API é conferida |
| Destino do proxy (`vite.config.ts`) | Em teste, a tela só encaminha para uma API local que não seja a da porta 3000 |
| Navegador | Só alcança o endereço da execução; o resto é bloqueado |
| Senhas | Aleatórias a cada execução, nunca gravadas em arquivos |
| API em banco remoto | Última barreira: domínios reservados não se cadastram nem entram |

Essas proteções valem para os comandos do projeto. Elas não impedem alguém de abrir a tela de desenvolvimento e cadastrar uma conta manualmente.

## Scripts que acessam o banco de `backend/.env` de propósito

Nenhum deles faz parte dos testes, e todos recusam banco remoto em ambiente de teste.

| Comando | Efeito |
|---|---|
| `npm run backup:database` | Somente leitura. Veja `docs/BACKUP_E_MIGRACOES_SUPABASE.md` |
| `backend/src/cli/create-initial-admin.ts` | **Grava**: cria o primeiro administrador |
| `backend/src/cli/reset-initial-admin-password.ts` | **Grava**: redefine a senha de um administrador |
