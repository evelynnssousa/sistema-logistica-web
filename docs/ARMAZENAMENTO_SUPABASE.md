# Anexos no Supabase Storage

Opção para os anexos funcionarem no Render enquanto o SharePoint não é autorizado pela TI. Usa o
mesmo projeto do Supabase que já guarda o banco, sem custo dentro da faixa gratuita
(1 GB de arquivos e no máximo 50 MB por arquivo no plano Free).

`ATTACHMENTS_STORAGE=supabase` liga esta opção. Trocar depois para o SharePoint é só mudar a
variável, mas **os arquivos já gravados não mudam de lugar sozinhos**: a migração entre os dois
precisa ser feita à parte.

## Como funciona

- Os arquivos ficam num bucket **privado**. O sistema recusa um bucket público: a conferência de
  saúde (`/api/health`) acusa `SUPABASE_BUCKET_PUBLIC` e nenhum arquivo é gravado.
- O navegador nunca recebe link do Supabase. Todo download passa pela API, que confere a permissão
  e o SHA-256 de cada arquivo antes de entregar.
- O envio nunca substitui um arquivo existente (`x-upsert: false`).
- Caminho no bucket: `<2 primeiros caracteres>/<chave UUID>`, igual ao disco local.
- A chave secreta fica só na API (Render). Ela nunca vai para as telas, para o Cloudflare ou para
  o repositório.

## Passo a passo (cerca de 10 minutos)

Faça uma vez para a homologação e, depois, outra para a produção, cada uma no seu projeto do
Supabase.

### 1. Criar o bucket

1. No painel do Supabase, abra o projeto e vá em **Storage**.
2. Clique em **New bucket**.
3. Nome: `slm-anexos`.
4. **Deixe "Public bucket" DESLIGADO.**
5. Em limite de tamanho, informe **50 MB** (ou o limite configurado em Configurações → Anexos,
   se for menor).
6. Clique em **Create bucket**. Não crie políticas (policies): a API usa a chave secreta e não
   precisa delas. Sem políticas, ninguém de fora consegue ler.

### 2. Copiar o endereço e a chave secreta

1. Em **Project Settings → API Keys**, copie uma chave **secreta** (começa com `sb_secret_`).
   Se o projeto ainda usa as chaves antigas, use a `service_role`. **Nunca** use a
   `publishable` nem a `anon`: o sistema recusa as duas.
2. Em **Project Settings → Data API** (ou na página inicial do projeto), copie o **Project URL**,
   como `https://abcdefgh.supabase.co`.

Sugestão: crie uma chave secreta só para o SLM, com o nome `slm-anexos`. Assim ela pode ser
revogada sem afetar mais nada.

### 3. Configurar no Render

No serviço da API, em **Environment**, crie:

| Variável | Valor |
|---|---|
| `ATTACHMENTS_STORAGE` | `supabase` |
| `SUPABASE_URL` | o Project URL |
| `SUPABASE_SECRET_KEY` | a chave secreta |
| `SUPABASE_STORAGE_BUCKET` | `slm-anexos` (opcional: é o padrão) |

Não defina `ATTACHMENTS_DIR` no Render. Salve e faça **Manual Deploy → Deploy latest commit**.

### 4. Conferir

1. Abra a tela de **Monitoramento** do sistema: "Armazenamento de anexos" deve aparecer como "Disponível".
2. Envie um anexo de teste numa solicitação, baixe de volta e confira se abre.
3. No painel do Supabase, em Storage → `slm-anexos`, o arquivo aparece dentro de uma pasta de
   dois caracteres.

Se algo falhar, `npm run config:check` (com as mesmas variáveis) aponta o que está faltando, sem
mostrar valores. Códigos comuns no Monitoramento:

| Código | Significado |
|---|---|
| `SUPABASE_BUCKET_MISSING` | O bucket não existe ou o nome está diferente |
| `SUPABASE_BUCKET_PUBLIC` | O bucket está público: torne-o privado |
| `SUPABASE_AUTH_REJECTED` / `SUPABASE_FORBIDDEN` | Chave errada, revogada ou sem permissão |
| `ENOSPC` | Arquivo maior que o limite do bucket ou cota esgotada |

## Backup

**O plano gratuito do Supabase não faz backup dos arquivos.** A cópia é feita de um computador
autorizado, com as mesmas três variáveis (no ambiente ou em `backend/.env`):

```bash
npm run backup:attachments:supabase -- --out /caminho/fora/do/projeto/anexos
```

```bash
ATTACHMENTS_DIR=/caminho/fora/do/projeto/anexos npm run backup:attachments
```

O primeiro comando baixa só o que ainda não está na pasta. O segundo gera o pacote `.tar.gz`
com manifesto e SHA-256, conferido com `npm run backup:attachments:verify`. Guarde o pacote
cifrado, fora do computador, como o backup do banco. Sugestão: uma vez por semana.

## Limites do plano gratuito

- 1 GB de arquivos no projeto inteiro e 50 MB por arquivo.
- O projeto pausa depois de 7 dias sem uso (o robô `manter-bancos-ativos` evita isso).
- Sem backup automático (ver acima).

Para a produção definitiva, a escolha continua sendo da TI: SharePoint
(`docs/ARMAZENAMENTO_SHAREPOINT.md`), Supabase Pro ou outro serviço aprovado.
