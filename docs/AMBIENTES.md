# Ambientes do sistema

| | Desenvolvimento | Testes automatizados | Testes de navegador |
|---|---|---|---|
| **Banco** | **Supabase real**, de `backend/.env` | Nenhum, ou PostgreSQL descartável | PostgreSQL descartável |
| **Grava dados reais?** | **Sim** | Não | Não |
| **Portas** | API 3000, tela 5173 | Banco 55902 (integração), 55903 (restauração) | API 3901, tela 5901, banco 55901 |
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

Durante uma investigação, `E2E_ONLY=session-persistence npm run test:e2e` roda só os cenários indicados, separados por vírgula. O executor pode terminar acusando falta de dados de outros cenários: para validar tudo, rode sem a variável.

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
| `npm run migrations:check` | Somente leitura: mostra as migrações pendentes e o que impediria aplicá-las |
| `node scripts/apply-migrations.cjs --aplicar --confirmar=APLICAR-MIGRACOES` | Primeira etapa: gera e testa um backup e para, sem aplicar. Só lê o banco |
| `node scripts/apply-migrations.cjs --aplicar --confirmar=APLICAR-MIGRACOES --backup=<arquivo>` | **Grava**: segunda etapa, aplica as migrações. Recusa se o arquivo ou os dados tiverem mudado. Veja `BACKUP_E_MIGRACOES_SUPABASE.md` |
| `backend/src/cli/create-initial-admin.ts` | **Grava**: cria o primeiro administrador |
| `backend/src/cli/reset-initial-admin-password.ts` | **Grava**: redefine a senha de um administrador |

## Depois da migração 005

Sem a migração, os módulos operacionais respondem 503 e não gravam. Depois que ela for aplicada no banco real, **as telas dos módulos em `npm run dev:frontend` também gravam dados reais**, incluindo solicitações, configurações e pedidos de material.

## Depois das migrações 007 a 010

Os novos protocolos, a Central, os anexos e os demais registros passam a gravar no banco real por `npm run dev:frontend`, como os demais módulos. Sem cada migração, a função correspondente responde 503, e as solicitações seguem com o número antigo.

Duas funções só ligam com variável própria, para iniciar a API continuar sem gravar nada: `MONITORING_ENABLED=true` para o registro contínuo de disponibilidade e `ATTACHMENTS_DIR` para os anexos. Erros técnicos, com a 010 aplicada, são gravados assim que acontecem.

`npm run test:backup` e `npm run backup:verify` usam só bancos descartáveis. O segundo lê a cópia indicada, que contém dados pessoais: rode na máquina autorizada a guardá-la.

## Depois da migração 012

Devolução, motivos por item, reserva, histórico de parâmetros, versões de modelos e de formulários e controle interno do Almoxarifado passam a gravar no banco real por `npm run dev:frontend`. Sem a migração, essas funções respondem 503, e o restante continua funcionando, com os textos e campos padrão.

## Central de comunicação

Depois da 013, enviar pela tela de desenvolvimento registra a mensagem no banco real. Ela só sai com `NOTIFICATION_EMAILS_ENABLED=true` e com o worker ligado. Sem isso, fica como não enviada ou aguardando envio, e nunca como enviada. Anexos exigem `ATTACHMENTS_DIR`.

## Controle de Demandas

Depois das migrações 014 e 015, usar o módulo pela tela de desenvolvimento grava no banco real. Fora de produção, a geração automática de ocorrências e os alertas de prazo só rodam com `DEMANDS_WORKER_ENABLED=true`, e iniciar a API continua sem gravar nada. Sem o worker, as próximas ocorrências não são geradas. Veja `CONTROLE_DE_DEMANDAS.md`.

Para ver o módulo sem tocar no banco real, use `npm run demo:demandas`: API, tela e banco descartáveis nas portas 3910, 5910 e 55910, com contas e dados demonstrativos e o mesmo isolamento dos testes. Se uma dessas portas estiver ocupada, o comando para sem encerrar nada.

## Portal do Motorista

Depois das migrações 016 e 017, usar o portal pela tela de desenvolvimento grava no banco real: início, término e ocorrências de viagem. A conta de perfil Motorista vê só o portal. Sem a migração, o perfil não pode ser definido, e a Frota segue igual.

## Comunicações automáticas

Fora de produção, a API não processa as filas: o worker exige `INTEGRATIONS_WORKER_ENABLED=true`. Iniciar a API continua sem gravar nada.

Mesmo assim, **depois da migração 006, cada ação no ambiente de desenvolvimento registra e-mails e notificações no banco real**. Sem `NOTIFICATION_EMAILS_ENABLED=true`, esses e-mails ficam como "não configurados" e não saem.

Nos testes, `NODE_ENV=test` nunca escolhe um provedor real, mesmo com credenciais, e a trava de rede continua valendo. `npm run test:e2e` usa transportes simulados, que são recusados em produção. Veja `INTEGRACOES_E_AUTOMACOES.md`.
