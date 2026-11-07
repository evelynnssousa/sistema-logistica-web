# Hospedagem gratuita: Cloudflare Pages, Render e Supabase

Situação em 2026-11-07: **preparado e testado só localmente.** Nenhuma conta foi criada ou
conectada, e nada foi publicado. O desenvolvimento local e a homologação não mudam.

| Parte | Serviço | Plano |
|---|---|---|
| Telas | Cloudflare Pages | Free |
| `/api/*` | Pages Function (`frontend/functions/api/[[path]].ts`) | Free (Workers) |
| API | Render (`render.yaml`) | Free |
| Banco | Supabase PostgreSQL | Free |
| Anexos | SharePoint (`ATTACHMENTS_STORAGE=sharepoint`), depois da autorização | — |

**Os planos gratuitos não são adequados para a operação institucional definitiva.** Eles servem
para a homologação e para uma avaliação inicial. O próprio Render recomenda não usar o plano
Free em produção, e nenhum dos três oferece garantia de disponibilidade, suporte ou backup
automático nesse plano. A escolha da hospedagem definitiva está em `docs/PRODUCAO.md`.
**Nenhuma contratação, upgrade ou cadastro de cartão está autorizado.**

## Ambientes: homologação e produção

A primeira publicação é **só de homologação**. Cada ambiente tem os próprios projetos,
serviços, endereços, variáveis e credenciais; nada é compartilhado entre eles.

| | Homologação | Produção |
|---|---|---|
| Situação | Proposta para a primeira publicação | **Não autorizada** |
| Supabase | Projeto existente `rrqulhpnghoetgrdswqr` (`jucesp-logistica-homologacao`), com as migrações 002 a 018 aplicadas | Banco real. **Tem 17 migrações pendentes (002 a 018) e não pode ser usado na primeira publicação** |
| Cloudflare Pages | Projeto próprio de homologação | Projeto próprio de produção |
| Render | Serviço próprio de homologação | Serviço próprio de produção |
| Endereços | `*.pages.dev` e `*.onrender.com` próprios | Próprios, sem reaproveitar os da homologação |
| `DATABASE_URL` | Session pooler do projeto de homologação | Session pooler do banco real |
| `PROXY_SHARED_SECRET` = `BACKEND_PROXY_SECRET` | Gerado só para a homologação | Gerado só para a produção |
| `PASSENGER_DATA_KEY`, `PASSWORD_RESET_PEPPER`, chaves de e-mail e do SharePoint | Próprias | Próprias. Nunca copiar as da homologação, nem o contrário |
| Dados | Exclusivamente fictícios ou de teste (títulos "HOMOLOG –", CPFs de teste); ver `docs/ROTEIRO_HOMOLOGACAO_SLM.md` | Dados reais |
| Backups | `backups/homologacao/` | `backups/`, com a política de `docs/BACKUP_E_MIGRACOES_SUPABASE.md` |

Cuidados com os limites, que valem por conta e não por projeto:

- **Render:** as 750 horas mensais são da *workspace*. Dois serviços Free na mesma workspace
  dividem essas horas; esgotadas, o Render suspende **todos** os serviços Free dela até o mês
  seguinte. Por isso, e para separar o acesso, use uma workspace para cada ambiente.
- **Cloudflare:** as 100.000 chamadas diárias às Functions são da conta. Projetos de
  homologação e produção na mesma conta dividem esse limite.
- **Supabase:** o plano Free permite 2 projetos ativos por organização.

O `render.yaml` descreve um serviço chamado `slm-api`. Ao importá-lo para um ambiente, dê ao
serviço um nome que identifique o ambiente, como `slm-api-homologacao`. O arquivo em si não
precisa mudar.

## Como o proxy funciona

O navegador fala só com o endereço do Cloudflare Pages. As telas são arquivos estáticos, e
`/api/*` vai para a Pages Function, que chama a API no Render:

1. O destino é sempre `BACKEND_ORIGIN`. A função monta a URL com o host dessa variável e só
   o caminho e a consulta do pedido, e confere o resultado. Um pedido fora de `/api`, com
   `//` ou `\` no início, ou que resultaria em outro host, é recusado.
2. Método, caminho, consulta e corpo seguem iguais. Os cabeçalhos também, inclusive `cookie`,
   `x-csrf-token`, `content-type` e `x-file-name`, menos os de conexão (hop-by-hop), os
   internos do Cloudflare (`cf-*`) e os de encaminhamento enviados pelo cliente.
3. A função define `X-SLM-Client-IP` e `X-Forwarded-For` com `CF-Connecting-IP`, que só o
   Cloudflare preenche. Também envia `X-SLM-Proxy-Secret` com `BACKEND_PROXY_SECRET`.
4. A resposta volta como veio: situação, corpo em fluxo (downloads), cabeçalhos de segurança
   da API e cada `Set-Cookie` separado. Redirecionamentos não são seguidos.
5. Se a API não responde, inclusive durante a hibernação do Render Free, a espera vai até
   100 s, ajustável por `BACKEND_TIMEOUT_MS`. Depois disso, ou diante de uma página de erro da
   plataforma, o navegador recebe 503 com uma mensagem genérica, sem endereço nem detalhe. Os
   erros em JSON da própria API passam como estão.
6. Sem `BACKEND_ORIGIN` válida (ausente, com caminho, usuário, consulta, ou sem https), a
   função responde 503 (`API_NOT_CONFIGURED`) e **não encaminha nada**.

**Cookies:** a tela e a API ficam na mesma origem (o endereço do Pages). O cookie de sessão
continua *host-only*, `HttpOnly`, `SameSite=Strict` e `Secure` em produção, sem mudança.

**API:** com `PROXY_SHARED_SECRET`, `backend/src/security/trustedProxy.ts` recusa com 403
quem chama o endereço do Render direto, exceto `/api/health`. Nos pedidos que trazem o
segredo, o IP usado pelos limites de tentativa vem de `X-SLM-Client-IP`. Por isso
`TRUST_PROXY` fica **sem valor** no Render: assim `X-Forwarded-For` nunca é aceito. Sem
`PROXY_SHARED_SECRET`, como no ambiente local e na homologação atual no Codespace, nada muda.

## Cloudflare Pages

| Campo | Valor |
|---|---|
| Diretório raiz | `frontend` |
| Comando de build | `npm ci && npm run build` |
| Diretório de saída | `dist` |
| Funções | `frontend/functions`, encontradas pelo Pages dentro do diretório raiz |

O Pages publica a partir do repositório Git: só entra o que estiver em commit na branch
configurada (ver "O que ainda impede a primeira publicação").

### Variáveis do ambiente de produção do projeto

Em *Settings → Variables and Secrets*, escolhendo o ambiente **Production** do projeto (no
projeto de homologação, "Production" é a versão principal da homologação):

- `BACKEND_ORIGIN`: endereço do serviço do Render **do mesmo ambiente**, só a origem, como
  `https://<serviço>.onrender.com`. Sem caminho, sem barra no final, sem usuário e sem
  consulta; precisa ser https. Qualquer outro formato faz a função responder 503.
- `BACKEND_PROXY_SECRET`: tipo **Secret**, com o mesmo valor de `PROXY_SHARED_SECRET` no
  Render do mesmo ambiente. Ao menos 32 caracteres aleatórios. Depois de gravado, o painel
  não mostra mais o valor.
- `BACKEND_TIMEOUT_MS`: opcional.

As variáveis são lidas na publicação: depois de mudá-las, publique de novo.

### Prévias (preview deployments)

O Pages cria uma prévia para cada envio a uma branch que não é a de produção, e para cada
pull request do próprio repositório. **Por padrão, as prévias são públicas**, e cada uma tem
o próprio endereço (`<hash>.<projeto>.pages.dev` e `<branch>.<projeto>.pages.dev`).

Regras:

1. **O ambiente Preview não recebe nenhuma variável:** nem `BACKEND_ORIGIN`, nem
   `BACKEND_PROXY_SECRET`. Assim a prévia mostra as telas, mas `/api/*` responde 503 e nenhum
   pedido chega a uma API ou a um banco. A documentação consultada não diz se o ambiente
   Preview herda valores do Production: depois de configurar, abra a aba Preview e confirme
   que ela está vazia.
2. **Prévias nunca recebem credenciais de produção** nem endereço de API ligada ao banco real.
3. Ative a política de acesso das prévias (*Settings → General → Enable access policy*, que
   usa o Cloudflare Access) nos dois projetos. Ela restringe as prévias à conta do
   Cloudflare; não protege o endereço principal `*.pages.dev`.
4. Não dê às prévias o segredo da homologação: como a API aceita um único
   `PROXY_SHARED_SECRET`, isso equivaleria a compartilhar a credencial do ambiente.

Para testar uma alteração sem comprometer a homologação:

- **Telas:** abra a prévia (com a política de acesso ativa). Ela não alcança nenhuma API.
- **Proxy e API juntos:** rode localmente `npm run test:backend` (inclui
  `frontend/tests/apiProxy.test.ts`) e `npm run test:integration` (proxy diante da API real,
  com PostgreSQL descartável). Nenhum dos dois usa o banco de homologação.
- **No Cloudflare de verdade:** só depois que a alteração entrar na branch de produção do
  projeto de homologação, seguindo o roteiro de homologação.

### Cabeçalhos

`frontend/public/_headers` publica os mesmos cabeçalhos de segurança do `vite preview` (CSP,
`X-Frame-Options`, `nosniff`, `Referrer-Policy`) e cache longo para `/assets/*`. Um teste
confere que a CSP dos dois é a mesma. Ver as ressalvas em "Segurança".

## Render

O `render.yaml` traz a configuração: build `npm ci --include=dev && npm run build:backend`,
start `npm run start:backend` e verificação de saúde em `/api/health`, que não acessa o banco.
`NODE_ENV=production` vale também durante a instalação; por isso o `--include=dev`, que
mantém o TypeScript necessário ao build. A porta vem de `PORT`, definida pelo Render.
Localmente continua 3000. `autoDeploy: false`: cada publicação é feita à mão no painel.

Variáveis no painel: `DATABASE_URL`, `FRONTEND_URL` (endereço do Pages do mesmo ambiente),
`APP_PUBLIC_URL`, `PROXY_SHARED_SECRET`, `PASSENGER_DATA_KEY`, `PASSWORD_RESET_PEPPER`,
`INSTITUTIONAL_EMAIL_DOMAINS` e, depois da autorização, as do SharePoint
(`docs/ARMAZENAMENTO_SHAREPOINT.md`). Todas estão marcadas `sync: false` no `render.yaml`:
os valores são digitados no painel, nunca no repositório. `TRUST_PROXY` fica sem valor.
`npm run config:check` confere o que falta sem mostrar valores. No Render, ele acusa erro se
`ATTACHMENTS_DIR` apontar para o disco local, que não é persistente.

O envio de e-mail usa a API HTTPS do Resend, que não é afetada pelo bloqueio das portas SMTP
(25, 465 e 587) do Render Free.

## Supabase

A API usa só o PostgreSQL do Supabase, pelo driver `pg` (`backend/src/database/pool.ts`).
Não usa Auth, Storage nem a API REST do Supabase.

### `DATABASE_URL`

Use o **Session pooler** (Supavisor em modo sessão), copiado de *Connect* no painel do
projeto:

```
postgresql://postgres.<referência-do-projeto>:<senha>@aws-<n>-<região>.pooler.supabase.com:5432/postgres
```

- **Porta 5432, Session pooler.** É IPv4 em todos os planos e aceita todos os recursos de
  sessão do PostgreSQL. A conexão direta (`db.<ref>.supabase.co`) é só IPv6 no plano Free;
  o Codespace não tem IPv6, e a documentação do Render consultada não confirma IPv6 de saída.
- **Não use a porta 6543 (Transaction pooler)**: não serve para `pg_dump` nem para as
  migrações, e não preserva estado de sessão entre transações.
- O usuário é `postgres.<referência-do-projeto>`, e não só `postgres`.
- **Não acrescente `sslmode` nem outros parâmetros de TLS à URL.** O `pool.ts` remove esses
  parâmetros e define o TLS sozinho: todo banco remoto usa TLS verificado
  (`rejectUnauthorized: true`) com a CA `backend/certificates/prod-ca-2021.crt`, que está no
  repositório e é a CA pública do Supabase. `sslmode=disable` em banco remoto é recusado.
  `DATABASE_SSL_CA_PATH` troca o certificado, só se o Supabase mudar a CA.
- `DB_POOL_MAX` limita as conexões da API (padrão 5).
- A senha é a do banco do projeto, definida no Supabase. Fica só no painel do Render, como
  `sync: false`; nunca neste documento nem no repositório.

Detalhes em `docs/BACKUP_E_MIGRACOES_SUPABASE.md`. Para a homologação, o formato esperado é
conferido por `scripts/homologacao.cjs`, que recusa outro projeto, outro usuário, outro host
ou a porta 6543.

### Conferir a conexão

Antes de publicar, a partir do Codespace e sem gravar nada:

```bash
npm run homolog -- verificar      # homologação: projeto, TLS, papel, versão e conteúdo, só leitura
npm run config:check              # variáveis presentes e válidas, sem mostrar valores
```

Depois da publicação, a conexão da API se confirma pelos registros do serviço no Render e por
uma entrada no sistema. O `/api/health` não acessa o banco: responder 200 prova só que a API
está no ar.

### Migrações

**Nenhuma migração roda no deploy.** O build do Render só instala e compila; a API não aplica
migrações ao iniciar. As migrações são uma etapa separada, feita do Codespace, com backup
antes e autorização expressa:

1. Conferir o que falta, só com leitura: `npm run migrations:check` (para a homologação,
   pelo wrapper `npm run homolog -- -- npm run migrations:check`).
2. Primeira etapa da aplicação (`--aplicar --confirmar=APLICAR-MIGRACOES`): gera o backup,
   testa a restauração e para, sem aplicar.
3. Guardar a cópia fora do Codespace (ver "Backups").
4. Segunda etapa, com `--backup=<arquivo.dump>`: confere que o arquivo e os dados não mudaram
   e aplica, uma migração por transação.
5. Conferir de novo com `migrations:check`. Só então publicar a versão da API que depende
   delas.

O procedimento completo está em `scripts/apply-migrations.cjs` e em
`docs/BACKUP_E_MIGRACOES_SUPABASE.md`. A homologação já tem 002 a 018. O banco real não tem
nenhuma delas, e aplicá-las depende de autorização própria.

### Backup e restauração

O plano Free do Supabase **não tem backups automáticos nem recuperação a um ponto no tempo**.
A própria documentação recomenda exportar os dados regularmente e guardá-los fora do
Supabase. O backup é, portanto, só o manual:

```bash
npm run backup:database                                           # banco do backend/.env
npm run homolog -- -- npm run backup:database -- --out backups/homologacao   # homologação
npm run backup:verify -- backups/<pasta>/<arquivo>.dump           # restaura em PostgreSQL descartável
```

- Exige Docker. O `pg_dump` roda em transação somente leitura pelo Session pooler.
- Na homologação, informe sempre `--out backups/homologacao`: sem isso, a cópia cai em
  `backups/`, junto das cópias do banco real.
- O arquivo tem dados pessoais e hashes de senha. Cifre com `gpg --symmetric --cipher-algo
  AES256`, gere o `.sha256` do arquivo cifrado e guarde os dois fora do Codespace e fora do
  Supabase, no destino institucional definido com a TI (`docs/PLANO_HOMOLOGACAO.md`). A senha
  do `gpg` vai para o cofre, separada da cópia. Nunca use e-mail, chat ou o repositório.
- **Uma cópia só vale depois de restaurada:** `backup:verify` restaura em um PostgreSQL
  descartável, sem nenhuma credencial do projeto, e confere as contagens. Para restaurar de
  fato em outro ambiente, siga "Restaurar em ambiente separado" em
  `docs/BACKUP_E_MIGRACOES_SUPABASE.md`.

### Pausa por inatividade

Projetos Free do Supabase **são pausados depois de 1 semana de inatividade**. Pausado, o
banco não responde, e a API passa a falhar nas rotas que o usam (o `/api/health` continua
respondendo, porque não consulta o banco). A reativação é feita no painel do Supabase pela
pessoa responsável pela conta. A documentação consultada não detalha o procedimento nem limita
o número de reativações. Projetos pausados não contam para o limite de 2 projetos ativos.

## Limites dos planos gratuitos

**Consulta em 2026-11-07.** Os limites mudam sem aviso: confira as páginas oficiais antes de
cada publicação e atualize esta seção.

### Cloudflare Workers Free (vale para as Pages Functions) e Pages Free

| Item | Limite |
|---|---|
| Chamadas às Functions | 100.000 por dia, por conta, somadas às de Workers; zera à meia-noite UTC (21h em Brasília) |
| Acima do limite diário | O Cloudflare responde erro 1027. A documentação não diz se a Pages Function cai para os arquivos estáticos; na prática, a API fica fora até a meia-noite UTC |
| Arquivos estáticos (telas) | Gratuitos e ilimitados, desde que não passem pela Function |
| CPU por chamada | 10 ms (o tempo esperando a API não conta) |
| Subrequisições por chamada | 50 (o proxy faz 1) |
| Memória | 128 MB |
| Corpo do pedido | 100 MB no plano Free do domínio; acima, 413. A API aceita até 101 MB, então o limite efetivo é o do Cloudflare |
| Builds | 500 por mês, 1 por vez, até 20 minutos cada |
| Arquivos por site | 20.000, até 25 MiB cada |
| Prévias | Ilimitadas e públicas por padrão |

### Render Free

| Item | Limite |
|---|---|
| Horas de instância | 750 por mês, por workspace; esgotadas, **todos** os serviços Free da workspace ficam suspensos até o mês seguinte. Serviço hibernado não consome horas |
| Hibernação | Depois de 15 minutos sem tráfego de entrada |
| Inicialização | Cerca de 1 minuto no primeiro acesso depois da hibernação (o proxy espera até 100 s) |
| Disco | Efêmero: tudo o que é gravado se perde a cada publicação, reinício ou hibernação. Sem disco persistente |
| Tráfego de saída e minutos de build | Cota mensal incluída, cujo valor aparece só no painel de cobrança. Esgotada: com cartão cadastrado, há **cobrança adicional**; sem cartão, os serviços Free ficam suspensos (tráfego) ou os builds novos ficam bloqueados (minutos) até o mês seguinte |
| Outras restrições | 1 instância, sem acesso ao terminal, portas SMTP bloqueadas, retorno só às 2 publicações anteriores; o Render pode reiniciar o serviço a qualquer momento e suspender serviços com volume incomum de tráfego de saída |

Com a API hibernada, também param os processos internos (limpeza de sessões, fila de
e-mails, monitoramento, alertas de demandas).

### Supabase Free

| Item | Limite |
|---|---|
| Banco | 500 MB por projeto (CPU compartilhada, 500 MB de RAM) |
| Projetos | 2 ativos por organização; pausados não contam |
| Pausa | Depois de 1 semana de inatividade |
| Backups | Nenhum automático, sem recuperação a um ponto no tempo |
| Tráfego de saída | 5 GB (mais 5 GB em cache) |
| Registros (logs) | 1 dia |
| Acima da cota | Aviso por e-mail e prazo de tolerância; depois, restrições que podem incluir pausar projetos ou deixar o banco só para leitura, até a cota renovar no ciclo seguinte |

### Como evitar cobranças inesperadas

Custo zero não é garantido em qualquer circunstância: os limites e as regras de cobrança são
dos fornecedores e podem mudar. Para reduzir o risco:

1. **Não cadastrar cartão nem forma de pagamento** em nenhum dos três serviços. No Render,
   isso é o que faz o excesso de tráfego virar suspensão, e não cobrança. O Supabase informa
   que não cobra no plano Free.
2. Não ativar recursos pagos, complementos (IPv4, PITR, discos) nem planos superiores. Nenhum
   upgrade está autorizado.
3. Usar contas institucionais, com o e-mail de cobrança lido pela pessoa responsável, para
   receber os avisos de cota.
4. Conferir o uso no painel de cada serviço ao menos uma vez por semana durante a
   homologação.

## Backups: banco, anexos e código

São três cópias diferentes. Uma não substitui a outra.

| Cópia | O que contém | Como | Situação |
|---|---|---|---|
| Banco (PostgreSQL) | Estrutura e dados do schema `public`: contas, solicitações, históricos, configurações. Não contém o conteúdo dos anexos | `npm run backup:database` e `npm run backup:verify` (ver "Backup e restauração") | Disponível e testado |
| Anexos no SharePoint | Os arquivos enviados, guardados na biblioteca do SharePoint | Retenção, lixeira e cópias da própria biblioteca, a definir com a TI (`docs/ARMAZENAMENTO_SHAREPOINT.md`, item 5) | **Não existe.** O SharePoint depende de autorização institucional e ainda não foi conectado; foi testado só com simulação |
| Anexos em disco local | Os arquivos da pasta `ATTACHMENTS_DIR` | `npm run backup:attachments` e `npm run backup:attachments:verify` | Disponível, mas só para o disco local. No Render não há disco local: os anexos ficam indisponíveis (503) |
| Código-fonte | O sistema em si | Repositório privado no GitHub | Parcial: há muitas alterações só no Codespace, sem commit (ver abaixo) |

**`npm run backup:attachments` não equivale a um backup do SharePoint.** Ele lê só a pasta
local; os arquivos guardados no SharePoint não passam por ele.

O código só está protegido depois de commit e envio ao GitHub. Um Codespace pode ser apagado,
e as alterações sem commit iriam junto. A identificação da versão em homologação está em
`docs/auditoria/IDENTIFICACAO_VERSAO_HOMOLOGACAO_2026-11-07.md`.

## Segurança

O que já existe e não deve ser enfraquecido: CSP restritiva, cookie de sessão `HttpOnly`,
`SameSite=Strict` e `Secure`, CSRF obrigatório, recusa da chamada direta ao Render e destino
do proxy fixado por `BACKEND_ORIGIN`.

Ressalvas da verificação de 2026-11-07, para ajuste separado, que não foi feito:

1. **`Strict-Transport-Security` nas telas.** O `_headers` não o define. Hoje o cabeçalho
   chega só nas respostas da API em produção (180 dias, sem subdomínios), que estão no mesmo
   endereço, então o navegador o recebe a partir da primeira chamada à API. Recomenda-se
   acrescentá-lo também ao `_headers`, com o mesmo valor da API.
2. **`Permissions-Policy`** não é definido nem nas telas nem na API. Recomenda-se desligar
   o que o sistema não usa (câmera, microfone, localização, entre outros), depois de conferir
   que nenhuma tela precisa deles.
3. **Sem teste real no Cloudflare e no Render.** A função não foi empacotada com o Wrangler,
   para não adicionar dependência; a compatibilidade foi conferida com as APIs padrão
   (`fetch`, `Headers.getSetCookie`, `AbortSignal.timeout`). Precisam ser confirmados na
   primeira publicação de homologação: entrada, saída, sessão, CSRF, downloads e envios
   grandes (limites de CPU e de corpo do Cloudflare), o IP nos limites de tentativa, a recusa
   da chamada direta ao Render e o primeiro acesso depois da hibernação.
4. Não há teste específico de `parseTrustProxy` com valor inválido. Os testes do segredo do
   proxy existem.

## O que ainda impede a primeira publicação

1. **Os arquivos da publicação não estão no Git.** `frontend/functions/api/[[path]].ts`,
   `frontend/public/_headers`, `frontend/tsconfig.functions.json`, `render.yaml` e
   `backend/src/security/trustedProxy.ts` estão sem commit, como as demais alterações. O Pages
   e o Render publicam a partir do repositório; sem commit e envio, eles ficariam de fora.
2. Autorizar e criar as contas e os projetos de homologação (Cloudflare, Render), e definir
   as variáveis de cada um, com segredos gerados só para a homologação.
3. Decidir o destino institucional das cópias do banco de homologação (ver
   `docs/PLANO_HOMOLOGACAO.md`).
4. Anexos: ficam indisponíveis (503) até o SharePoint ser autorizado.
5. Validar em homologação real os itens de "Segurança", item 3.
6. Produção: depende das migrações do banco real, de autorização própria e da escolha da
   hospedagem definitiva.

## Testes

- `frontend/tests/apiProxy.test.ts` (em `npm run test:backend`): GET e POST, consulta,
  cookies e `Set-Cookie`, CSRF, envio e download binário, cabeçalhos forjados, segredo, API
  indisponível, configuração inválida, destino controlado pelo cliente e `_headers`.
- `backend/src/security/trustedProxy.test.ts` (em `npm run test:backend`): recusa da chamada
  direta, saúde liberada, IP só com o segredo, segredo fraco.
- `frontend/tests/apiProxyIntegration.test.ts` (em `npm run test:integration`): a API real
  com PostgreSQL descartável atrás da função. Cobre entrada, sessão, CSRF, saída, anexos,
  recusa direta e limite por IP.

## Fontes oficiais consultadas (2026-11-07)

- Cloudflare Workers, limites: https://developers.cloudflare.com/workers/platform/limits/
- Cloudflare Pages Functions, cobrança: https://developers.cloudflare.com/pages/functions/pricing/
- Cloudflare Pages, limites: https://developers.cloudflare.com/pages/platform/limits/
- Cloudflare Pages, prévias: https://developers.cloudflare.com/pages/configuration/preview-deployments/
- Cloudflare Pages, variáveis e bindings: https://developers.cloudflare.com/pages/functions/bindings/
- Render Free: https://render.com/docs/free
- Supabase, preços: https://supabase.com/pricing
- Supabase, cobrança e FAQ: https://supabase.com/docs/guides/platform/billing-on-supabase e https://supabase.com/docs/guides/platform/billing-faq
- Supabase, controle de custos: https://supabase.com/docs/guides/platform/cost-control
- Supabase, backups: https://supabase.com/docs/guides/platform/backups
- Supabase, conexão: https://supabase.com/docs/guides/database/connecting-to-postgres
- Supabase, SSL: https://supabase.com/docs/guides/platform/ssl-enforcement
