# Ambiente de produção: requisitos e implantação

Preparado em 06/11/2026 (achado P-11 da auditoria de 05/11). **Nada aqui foi publicado, contratado ou configurado em servidor.** É o que a TI precisa providenciar e o roteiro para a primeira implantação. Ver também `AMBIENTES.md`, `BACKUP_E_MIGRACOES_SUPABASE.md` e `INTEGRACOES_E_AUTOMACOES.md`.

## 1. Arquitetura

```
Navegador ──HTTPS──> Proxy reverso (nginx ou equivalente da TI)
                         ├── /        → arquivos estáticos de frontend/dist (build do Vite)
                         └── /api/*   → API Node.js (backend/dist/server.js), porta interna
API ──TLS verificado──> PostgreSQL (Supabase, session pooler, porta 5432)
API ──HTTPS──> Resend (e-mail) e Google Calendar, só quando autorizados
API ──disco──> ATTACHMENTS_DIR (anexos), fora do código e com backup próprio
```

A API não serve a tela. O mesmo domínio atende a tela e a API, o que mantém o cookie de sessão `SameSite=Strict` e dispensa CORS entre domínios.

## 2. Requisitos de hospedagem

| Item | Mínimo | Observação |
|---|---|---|
| Sistema | Linux x64 com Node.js 24 LTS | A versão usada nos testes é a 24. `argon2` compila módulo nativo na instalação |
| Processo | 1 instância da API, gerenciada (systemd, PM2 ou contêiner) com reinício automático | **Uma instância só**: o limite de tentativas de login fica em memória (P-22). Mais de uma exige limite compartilhado |
| Memória e CPU | 1 vCPU e 1 GB de RAM para a API | Argon2id usa memória a cada login; não reduzir abaixo disso |
| Disco | Espaço para `ATTACHMENTS_DIR` conforme o limite total definido em Configurações, mais as cópias locais temporárias | Disco persistente, não efêmero |
| Rede de saída | `*.supabase.com:5432`, `api.resend.com:443`, `oauth2.googleapis.com:443`, `www.googleapis.com:443` | As duas últimas só se o Google Calendar for autorizado |
| Horário | Fuso `America/Sao_Paulo` não é obrigatório no servidor (as datas são gravadas em UTC), mas o relógio precisa estar sincronizado (NTP) | Sessões, códigos de recuperação e tokens do Google dependem do relógio |

## 3. Banco de dados

| Item | Requisito |
|---|---|
| Servidor | PostgreSQL 17 (Supabase atual). Conexão pelo session pooler, porta 5432; **não usar** o transaction pooler (6543) |
| TLS | Sempre verificado, com `backend/certificates/prod-ca-2021.crt` ou `DATABASE_SSL_CA_PATH` |
| Migrações | 002 a 018 aplicadas com `scripts/apply-migrations.cjs`, em duas etapas, só com autorização expressa. A 018 fecha a API pública do Supabase (P-02) |
| Papel da API | Dono das tabelas (`postgres` no Supabase). A API não usa PostgREST, Auth nem Storage do Supabase |
| Data API do Supabase | Recomendado desligar ou restringir os schemas expostos no painel (Settings → API). Depois da 018, nada em `public` fica acessível a `anon`, `authenticated` ou `service_role` |
| Backups do provedor | Conferir no painel (Database → Backups) o plano e a retenção. Não substituem as cópias próprias (seção 7) |
| Conexões | `DB_POOL_MAX=5` atende uma instância. Conferir o limite do plano do Supabase |

## 4. Armazenamento de anexos

| Item | Requisito |
|---|---|
| Local | `ATTACHMENTS_DIR` absoluta, **fora** da pasta do projeto (a API recusa uma pasta dentro dele) e fora de qualquer pasta servida pelo proxy |
| Permissão | Dono = usuário da API, modo `700` na pasta e `600` nos arquivos (a API já grava assim) |
| Acesso | Só pela API, com sessão e permissão. Não há URL pública. O proxy **não** deve expor essa pasta |
| Backup | `npm run backup:attachments`, com teste `npm run backup:attachments:verify`, na mesma rotina do banco |
| Antivírus | Não implementado (P-20). Se a TI exigir, implantar varredura na pasta ou no envio |
| Alternativa | Serviço de objetos aprovado pela TI, implementando a interface `AttachmentStorage` em `backend/src/attachments/storage.ts` |

## 5. Variáveis de ambiente

Confira com `npm run config:check` (com `NODE_ENV=production`), que mostra só nomes e situação, nunca valores, e sai com 1 se houver erro. A API também registra no log, ao iniciar, cada variável com aviso ou erro.

| Variável | Produção | Como obter |
|---|---|---|
| `NODE_ENV` | `production` | Fixo |
| `PORT` | Porta interna da API | TI |
| `DATABASE_URL` | Obrigatória | Painel do Supabase, session pooler, sem `sslmode` |
| `FRONTEND_URL` | Obrigatória, `https://` | Endereço público definido pela TI |
| `APP_PUBLIC_URL` | Recomendada, `https://`, igual ao endereço público | Sem ela, e-mails saem sem link e a recuperação usa código |
| `TRUST_PROXY` | `1` atrás de um proxy | Número de proxies confiáveis |
| `PASSENGER_DATA_KEY` | Obrigatória para Passagens | `openssl rand -base64 32`, gerada **no servidor**, com cópia em cofre da instituição. Sem ela, CPFs gravados ficam ilegíveis. Não há troca de chave implementada |
| `ATTACHMENTS_DIR` | Obrigatória para anexos | Pasta da seção 4 |
| `PASSWORD_RESET_PEPPER` | Obrigatória para recuperar senha | `openssl rand -hex 32` |
| `RESEND_API_KEY`, `RESEND_FROM` | Obrigatórias para qualquer e-mail | Conta Resend institucional, com domínio verificado (SPF e DKIM) |
| `NOTIFICATION_EMAILS_ENABLED` | `true` só depois da homologação do e-mail | Autorização da responsável |
| `EMAIL_INTERNAL_TO_*`, `EMAIL_CC_*` | Conforme a área | Lista oficial de destinatários |
| `GOOGLE_CALENDAR_*` | Só se autorizado | Conta de serviço e calendários institucionais |
| `INSTITUTIONAL_EMAIL_DOMAINS` | Recomendada | Lista oficial de domínios (P-09) |
| `MONITORING_ENABLED` | `true` | — |
| `BACKUP_LOG_PATH` | Recomendada | Arquivo de registro das cópias, lido pela tela de Monitoramento |
| `INTEGRATIONS_WORKER_ENABLED`, `DEMANDS_WORKER_ENABLED`, `SESSION_CLEANUP_ENABLED` | Sem valor (ligam sozinhos em produção) | Use `false` só para desligar |
| `EMAIL_TRANSPORT`, `GOOGLE_CALENDAR_TRANSPORT` | **Não definir** | Valores de teste; ignorados em produção |

Os segredos ficam no gerenciador de segredos da TI ou em arquivo `600` do usuário da API, **nunca no repositório**. `backend/.env.example` lista todas, sem valores.

## 6. HTTPS, domínio e cabeçalhos

1. Domínio institucional definido pela TI (por exemplo, um subdomínio de `jucesp.sp.gov.br`) e certificado TLS válido, renovado automaticamente.
2. Redirecionar HTTP para HTTPS. TLS 1.2 ou superior.
3. A API já envia, em toda resposta de `/api`: CSP `default-src 'none'`, `X-Content-Type-Options`, `Referrer-Policy`, `frame-ancestors 'none'`, `Cache-Control: no-store` e, em produção, HSTS de 180 dias.
4. Os arquivos estáticos precisam de cabeçalhos no proxy. Exemplo para nginx, a adaptar pela TI:

```nginx
server {
  listen 443 ssl http2;
  server_name slm.exemplo.sp.gov.br;           # domínio definido pela TI
  # ssl_certificate / ssl_certificate_key: certificado institucional

  root /srv/slm/frontend/dist;                  # build do Vite; nunca a pasta de anexos
  client_max_body_size 11m;                     # padrão de 10 MB por anexo; acompanhe o limite de Configurações (até 100 MB)

  add_header Strict-Transport-Security "max-age=15552000" always;
  add_header X-Content-Type-Options "nosniff" always;
  add_header Referrer-Policy "strict-origin-when-cross-origin" always;
  add_header X-Frame-Options "DENY" always;
  add_header Content-Security-Policy "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; object-src 'none'" always;

  location /api/ {
    proxy_pass http://127.0.0.1:3000;           # PORT da API
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  location / {
    try_files $uri /index.html;                 # rotas da tela (React Router)
  }
}
```

A fonte Inter já é servida pelo próprio sistema (P-17): nenhuma origem externa precisa ser liberada na CSP.

## 7. Backup e recuperação em produção

Detalhes em `BACKUP_E_MIGRACOES_SUPABASE.md`, seção "Cópia externa e recuperação". Resumo do que a TI precisa providenciar:

- agendador diário para `npm run backup:database` e `npm run backup:attachments`, com alerta quando a saída não for 0;
- destino externo ao servidor e ao Codespace, com acesso restrito e cópia cifrada;
- retenção de 7 diárias, 4 semanais e 12 mensais (proposta, a confirmar);
- teste mensal de restauração com `npm run backup:verify` e `npm run backup:attachments:verify`;
- cópia de `PASSENGER_DATA_KEY` guardada separadamente dos backups.

## 8. Monitoramento

| O quê | Como |
|---|---|
| Disponibilidade da API | `GET /api/health` a cada minuto, por monitor externo da TI |
| Disponibilidade interna | `MONITORING_ENABLED=true`: a tela de Monitoramento mostra banco, e-mail, calendário, armazenamento e períodos sem verificação |
| Logs | Saída padrão da API em JSON (`level: security`), sem senhas, CPFs nem conteúdo de e-mail. Reter conforme a política da TI |
| Filas | Tela de Integrações: e-mails e eventos aguardando, falhos e reprocessados |
| Backups | Tela de Monitoramento, a partir de `BACKUP_LOG_PATH` |
| Certificado e disco | Alerta de vencimento do certificado e de ocupação do disco de anexos |

## 9. Atualização e recuperação de versões

1. Cada versão sai de um commit identificado na branch aprovada; registrar o commit implantado.
2. Antes de atualizar: backup do banco e dos anexos, com teste de restauração aprovado.
3. Atualizar: `npm ci`, `npm --prefix frontend ci`, `npm run verify`, `npm run build:backend`, `npm run build:frontend`; aplicar migrações novas só com autorização; reiniciar a API; conferir `/api/health` e o login.
4. Voltar à versão anterior: reimplantar o commit anterior. Se uma migração foi aplicada, usar o `.rollback.sql` correspondente, que recusa quando já há dados que dependem dela; se recusar, restaurar o backup do passo 2.
5. Mudanças de banco nunca são feitas à mão no painel do Supabase.

## 10. Checklist de implantação

| # | Item | Responsável | Situação |
|---|---|---|---|
| 1 | Servidor ou serviço de hospedagem definido e contratado | TI | Pendente |
| 2 | Domínio e certificado HTTPS | TI | Pendente |
| 3 | Proxy reverso com os cabeçalhos da seção 6 | TI | Pendente |
| 4 | Node.js 24 e gerenciador de processo com reinício automático | TI | Pendente |
| 5 | Pasta de anexos persistente, `700`, fora do projeto | TI | Pendente |
| 6 | Segredos gerados no servidor e guardados em cofre (`PASSENGER_DATA_KEY`, `PASSWORD_RESET_PEPPER`) | TI e responsável | Pendente |
| 7 | Conta Resend com domínio verificado | TI | Pendente |
| 8 | `npm run config:check` sem erros, com `NODE_ENV=production` | Desenvolvimento | Pendente |
| 9 | Backup verificado do banco real, com cópia externa | Responsável | Pendente |
| 10 | Migrações 002 a 018 aplicadas com autorização | Responsável | Pendente |
| 11 | `npm run verify` e `npm run test:all` no commit a implantar | Desenvolvimento | Pronto para executar |
| 12 | Homologação do e-mail (roteiro em `INTEGRACOES_E_AUTOMACOES.md`) | Responsável e TI | Pendente |
| 13 | Agendamento dos backups e do monitor externo | TI | Pendente |
| 14 | Aceite da SLM nas contas reais | Área usuária | Pendente |
| 15 | Decisão sobre o período de convivência com o sistema antigo e os calendários | Responsável | Pendente |
