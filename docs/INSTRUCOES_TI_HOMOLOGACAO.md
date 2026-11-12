# Solicitação à TI: armazenamento de backup e ambiente de homologação

Sistema de Serviços de Logística e Manutenção (SLM) da JUCESP. Preparado em 06/11/2026 para encaminhamento à TI. Detalhes técnicos de produção em `docs/PRODUCAO.md`.

O sistema está pronto para homologação com a equipe SLM. Para começar, precisamos de três itens da TI, em ordem de prioridade.

## Item 1. Armazenamento institucional para backup (prioridade máxima)

**Para quê:** guardar a cópia do banco de dados do sistema, feita antes de qualquer alteração. Hoje ela existe só em um ambiente de desenvolvimento temporário (GitHub Codespaces). A cópia contém dados pessoais (nomes, e-mails e setores de 7 contas) e hashes de senha.

**Requisitos:**

| Requisito | Detalhe |
|---|---|
| Local | Armazenamento institucional da JUCESP (servidor de arquivos, OneDrive/SharePoint ou Google Drive institucional), **nunca** conta pessoal |
| Acesso | Pasta restrita a, no máximo, a responsável pelo projeto e um técnico da TI. Sem compartilhamento por link |
| Criptografia | Os arquivos chegam já cifrados (AES-256, com `gpg`). Se o serviço também cifra em repouso, melhor |
| Senha da cópia | Guardada separadamente, no cofre de senhas da TI, nunca na mesma pasta |
| Registro | Quem enviou, quando, nome do arquivo e SHA-256 (fornecidos junto) |
| Retenção | Manter a cópia pré-migração até a produção estar estável e com rotina própria de backup; proposta geral: 7 diárias, 4 semanais, 12 mensais |
| Tamanho | Menos de 1 MB hoje; prever crescimento com o uso |

**O que a TI precisa informar à responsável:** o local (caminho ou pasta), quem tem acesso e como a senha será guardada no cofre.

**Como a cópia chega:** a responsável cifra o arquivo no ambiente de desenvolvimento, baixa o `.gpg` e o arquivo `.sha256` e os grava na pasta indicada. A TI confere no destino:

```bash
sha256sum -c <arquivo>.dump.gpg.sha256      # deve responder "OK"
```

## Item 2. Ambiente de homologação

**Para quê:** permitir que os quatro operadores da SLM e o administrador usem o sistema pelo navegador, na rede da JUCESP, sem expor o ambiente de desenvolvimento na internet.

### Opção recomendada: servidor interno

| Requisito | Detalhe |
|---|---|
| Servidor | Linux x64 (VM interna basta), 1 vCPU, 1 GB de RAM livres para a aplicação, 10 GB de disco |
| Software | Node.js 24 LTS, nginx (ou proxy equivalente), git |
| Rede | Acesso pela rede interna ou VPN da JUCESP. **Não precisa estar na internet.** Saída para `*.pooler.supabase.com:5432` (banco) |
| Endereço | Nome interno, por exemplo `slm-homologacao.<dominio-interno>`, com certificado TLS (pode ser da AC interna) |
| Processo | systemd (ou equivalente) com reinício automático |
| Pasta de anexos | `/var/lib/slm-homologacao/anexos`, dono = usuário da aplicação, permissão `700` |
| Acesso ao código | O repositório no GitHub é **privado**: a responsável concede acesso de leitura à conta de um técnico da TI, ou entrega um pacote da versão |

### Passo a passo de instalação (TI)

```bash
# 1. Usuário e pastas
sudo useradd --system --create-home --home-dir /srv/slm slm
sudo install -d -o slm -g slm -m 700 /var/lib/slm-homologacao/anexos
sudo install -d -o root -g slm -m 750 /etc/slm

# 2. Código, na versão indicada pela responsável
sudo -u slm git clone https://github.com/evelynnssousa/sistema-logistica-web.git /srv/slm/app
cd /srv/slm/app && sudo -u slm git checkout <commit-indicado>

# 3. Dependências, conferência e build
sudo -u slm npm ci
sudo -u slm npm --prefix frontend ci
sudo -u slm npm run verify          # tipos, lint, testes unitários e builds
```

**4. Configuração** em `/etc/slm/homologacao.env` (dono `root`, grupo `slm`, permissão `640`). Os valores secretos são gerados no próprio servidor e nunca enviados por e-mail ou chat:

```bash
NODE_ENV=production
PORT=3100
DATABASE_URL=<session pooler do projeto Supabase de HOMOLOGAÇÃO, sem sslmode>
FRONTEND_URL=https://slm-homologacao.<dominio-interno>
APP_PUBLIC_URL=https://slm-homologacao.<dominio-interno>
TRUST_PROXY=1
ATTACHMENTS_DIR=/var/lib/slm-homologacao/anexos
PASSENGER_DATA_KEY=<gerar: openssl rand -base64 32>
PASSWORD_RESET_PEPPER=<gerar: openssl rand -hex 32>
MONITORING_ENABLED=true
# Confirmar a lista oficial com a responsável (há um cadastro com jucespmail.sp.gov.br).
# Comentários só em linha própria: o systemd não aceita comentário no fim da linha.
INSTITUTIONAL_EMAIL_DOMAINS=jucesp.sp.gov.br
# E-mail: deixar sem RESEND_* até a homologação própria do e-mail.
# Não definir EMAIL_TRANSPORT. Não há variáveis do Google: a integração foi removida.
```

A chave `PASSENGER_DATA_KEY` de homologação **não** deve ser reaproveitada em produção.

**5. Conferir a configuração** (mostra só nomes e situação, nunca valores; precisa terminar "Sem erros"):

```bash
cd /srv/slm/app && sudo -u slm env $(sudo cat /etc/slm/homologacao.env | grep -v '^#' | xargs) npm run config:check
```

**6. Serviço** `/etc/systemd/system/slm-homologacao.service`:

```ini
[Unit]
Description=SLM - homologacao
After=network-online.target

[Service]
User=slm
WorkingDirectory=/srv/slm/app
EnvironmentFile=/etc/slm/homologacao.env
ExecStart=/usr/bin/node backend/dist/server.js
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=full
ReadWritePaths=/var/lib/slm-homologacao

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now slm-homologacao
curl -fsS http://127.0.0.1:3100/api/health     # deve responder com sucesso
```

**7. Proxy:** usar o modelo de nginx de `docs/PRODUCAO.md`, seção 6, com `root /srv/slm/app/frontend/dist;`, `proxy_pass http://127.0.0.1:3100;` e o certificado interno.

**8. Entregar à responsável:** o endereço, a confirmação de que `config:check` não teve erros e de que `/api/health` responde.

### Alternativas, se não houver servidor interno a curto prazo

| Alternativa | Avaliação |
|---|---|
| Serviço de hospedagem em nuvem contratado pela JUCESP (por exemplo, um serviço de aplicações Node com proxy gerenciado) | Funciona com os mesmos passos 3 a 7. Depende de contratação e de restringir o acesso (lista de IPs da JUCESP ou login institucional na frente) |
| Endereço encaminhado do Codespace tornado público | **Não recomendado.** Expõe na internet um ambiente de desenvolvimento, sem HTTPS próprio, sem proxy, sem monitoramento e dependente de a sessão da responsável estar aberta |
| Homologação assistida na sessão da responsável | Possível como paliativo: cada operador usa a própria conta, mas só na presença dela e no computador dela. Não substitui o ambiente da TI |

## Item 3. Banco de dados de homologação separado

**Para quê:** testar sem tocar no banco que poderá ser o de produção.

| Requisito | Detalhe |
|---|---|
| Serviço | Novo projeto Supabase, na mesma organização institucional do atual, chamado por exemplo `slm-homologacao`, região São Paulo (`sa-east-1`) |
| Senha do banco | Gerada pelo próprio Supabase ou forte, guardada no cofre da TI |
| Configuração | Nenhuma: o sistema usa só o PostgreSQL. Recomendado desligar a Data API (Settings → API) ou não expor o schema `public` |
| Entregar | O endereço do **session pooler** (porta 5432), por canal seguro, para a responsável e para o arquivo de configuração do item 2 |

Se a TI preferir outro PostgreSQL 17 gerenciado em vez do Supabase, ele também serve, desde que aceite TLS e um usuário dono do schema `public`.

## Resumo do que pedimos

1. Pasta institucional restrita para o backup cifrado, com a senha no cofre.
2. Servidor interno de homologação, ou alternativa equivalente, com HTTPS na rede da JUCESP.
3. Projeto de banco de dados separado para homologação.

Nenhum desses itens envolve publicar o sistema para o público, nem desligar o sistema antigo.
