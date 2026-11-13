# Manter os serviços ativos (Render e Supabase gratuitos)

Os planos gratuitos "dormem" quando ninguém usa:

| Serviço | O que acontece | Efeito |
|---|---|---|
| **Render** (a API) | Dorme depois de 15 minutos sem acesso. | A primeira pessoa espera cerca de 1 minuto. Enquanto dorme, a fila de e-mails, os lembretes e as recorrências de Demandas param. |
| **Supabase** (os bancos) | Pausa o projeto depois de 7 dias sem atividade. | O sistema para até alguém reativar o projeto no painel. Os dados não se perdem, mas o projeto só pode ser reativado por 90 dias. |
| **Cloudflare Pages** (o site) | Não dorme. | Nada a fazer. |

Dois robôs do GitHub (GitHub Actions) resolvem isso. Eles já estão no projeto e ficam **parados** até você fazer a configuração abaixo. Os agendamentos só rodam a partir da branch `main`.

---

## Robô 1: manter a API acordada (Render)

Arquivo: `.github/workflows/manter-api-acordada.yml`. A cada 10 minutos, de segunda a sexta, das 7h às 19h de Brasília, ele abre o endereço `/api/health` da API. Ele não usa senha nem acessa o banco.

Consumo: cerca de 290 horas por mês do Render, dentro das 750 horas gratuitas, e cerca de 1.600 minutos por mês do GitHub Actions, dentro dos 2.000 gratuitos de um repositório privado.

**Como ligar:**

1. No **Render**, abra o serviço da API e copie o endereço que aparece no topo. Ele termina em `.onrender.com`.
2. No **GitHub**, abra o repositório e clique em **Settings**.
3. No menu da esquerda, vá em **Secrets and variables → Actions**.
4. Clique na aba **Variables** e depois em **New repository variable**.
5. Preencha:
   - **Name:** `SLM_API_HEALTH_URL`
   - **Value:** o endereço do passo 1 seguido de `/api/health`. Por exemplo: `https://nome-da-api.onrender.com/api/health`
6. Clique em **Add variable**.
7. Para testar, vá na aba **Actions**, clique em **Manter a API acordada**, depois em **Run workflow** e mais uma vez em **Run workflow**. Em até 2 minutos deve aparecer um ✅ verde.

---

## Robô 2: manter os bancos ativos (Supabase)

Arquivo: `.github/workflows/manter-bancos-ativos.yml`. Uma vez por dia, às 8h17, ele faz a consulta `SELECT 1` em cada banco. Essa consulta não lê nenhum dado. Consumo: cerca de 30 minutos por mês do GitHub Actions.

O robô precisa entrar no banco, então ele usa um **usuário só para isso**, que consegue conectar e **não tem acesso a nenhuma tabela**. A senha principal do banco nunca vai para o GitHub.

### Parte A: criar o usuário do robô (faça no banco real; na homologação, se quiser)

1. Abra o **Supabase** e entre no projeto do **banco real**.
2. No menu da esquerda, clique em **SQL Editor** e depois em **New query**.
3. Cole o texto abaixo e troque `TROQUE-POR-UMA-SENHA-LONGA` por uma senha nova, longa, só com letras e números. Ela não pode ser igual a nenhuma outra senha.

   ```sql
   CREATE ROLE slm_keepalive WITH LOGIN PASSWORD 'TROQUE-POR-UMA-SENHA-LONGA' NOINHERIT CONNECTION LIMIT 2;
   ```

4. Clique em **Run**. Deve aparecer "Success".
5. Guarde a senha só até o fim da Parte B.

### Parte B: montar o endereço de conexão

1. Ainda no Supabase, clique em **Connect**, no topo.
2. Escolha **Session pooler**. Aparece um endereço parecido com
   `postgresql://postgres.abcdefgh:[YOUR-PASSWORD]@aws-0-sa-east-1.pooler.supabase.com:5432/postgres`
3. Copie esse endereço e faça duas trocas:
   - troque `postgres.` (logo depois de `//`) por `slm_keepalive.`. O código do projeto que vem depois do ponto continua igual;
   - troque `[YOUR-PASSWORD]` pela senha da Parte A.
4. O resultado fica assim:
   `postgresql://slm_keepalive.abcdefgh:SUA-SENHA@aws-0-sa-east-1.pooler.supabase.com:5432/postgres`

Use o **Session pooler**, e não o endereço "Direct connection": as máquinas do GitHub não conseguem usar a conexão direta.

### Parte C: guardar no GitHub como segredo

1. No GitHub, vá em **Settings → Secrets and variables → Actions**.
2. Clique na aba **Secrets** (não em Variables) e depois em **New repository secret**.
3. Preencha:
   - **Name:** `SLM_KEEPALIVE_DB_REAL`
   - **Secret:** o endereço da Parte B
4. Clique em **Add secret**. O GitHub nunca mostra o segredo de novo, nem nos registros.
5. Para a homologação, que é opcional, repita as Partes A, B e C no projeto de homologação, com outra senha, e use o nome `SLM_KEEPALIVE_DB_HOMOLOG`.
6. Para testar, vá na aba **Actions**, clique em **Manter os bancos ativos** e depois em **Run workflow**. Deve aparecer "Banco real respondeu."

### Se um dia quiser desligar

- **Para parar o robô:** apague o segredo no GitHub.
- **Para apagar o usuário do banco:** no SQL Editor, rode `DROP ROLE slm_keepalive;`.

---

## Avisos

- **Repositório sem atividade:** o GitHub pode desativar agendamentos de repositórios parados há muito tempo. Se o ✅ parar de aparecer na aba Actions, abra o robô e clique em **Enable workflow**.
- **Se o Supabase pausar mesmo assim**, ele avisa por e-mail antes. Para reativar, abra o projeto no painel e clique em **Restore project**. Os dados continuam lá.
- **Produção:** quando o sistema for para produção com o banco real, a própria API passa a manter esse banco ativo. O robô 2 continua útil como garantia.
