# Plano para iniciar a homologação

Preparado em 06/11/2026. Complementa `docs/auditoria/PRE_MIGRACAO_2026-11-06.md`. Instruções para a TI em `docs/INSTRUCOES_TI_HOMOLOGACAO.md`. Roteiro de testes em `docs/ROTEIRO_HOMOLOGACAO_SLM.md` (51 casos, preservado sem alteração).

**Nada foi aplicado no banco real, nenhuma conta foi alterada ou excluída e nada foi publicado.**

## Recomendação

**Homologar em um projeto Supabase separado, vazio, e deixar o banco real como está até a entrada em produção.**

| | Projeto separado (recomendado) | Migrar o banco real agora |
|---|---|---|
| Banco que poderá ser o de produção | Migrado (002 a 020) em 12/11/2026, sem dados de teste | Recebe as 19 migrações (002 a 020) e todos os dados de teste |
| Dados pessoais na homologação | Só das contas criadas para homologar | As 7 contas atuais, inclusive as fictícias |
| Depois da homologação | O projeto de homologação pode ser mantido para testes futuros ou apagado | Limpar os dados de teste exige exclusões, com sua autorização |
| Backup externo | Não é pré-requisito para começar (o banco real não muda) | **Obrigatório antes** de aplicar |
| Reversão | Desnecessária: recria-se o projeto | Reversões ou restauração do backup |
| O que muda no banco real | As mesmas 19 migrações (002 a 020) foram aplicadas em 12/11/2026, a pedido da responsável; dados de teste nunca vão para lá | Já fica migrado |
| Tempo para começar | Criar o projeto (minutos) e preparar o acesso | Cópia externa + aplicação + acesso |

O procedimento do projeto separado foi ensaiado nesta etapa num PostgreSQL 17 descartável que reproduz um projeto Supabase novo (`postgres` sem superusuário): o esquema base (001) e as 17 migrações aplicaram com saída 0 e conferência final sem problemas (64 tabelas, todas com RLS, nada aberto à API pública).

**Em qualquer das duas opções, o gargalo é o acesso dos operadores** (seção D): sem um ambiente da TI, eles não têm como abrir o sistema.

## A. Backup já realizado

| Item | Situação |
|---|---|
| Arquivo | `backups/slm-completo-2026-11-06T13-04-28-246Z.dump` e `.sha256` |
| Integridade | `sha256sum -c` respondeu **OK** em 06/11; restauração testada com contagens idênticas |
| Proteção | Permissão `600` (só o dono), pasta `700`, ignorada pelo Git: nunca vai ao GitHub |
| Envio | Não foi enviado a nenhum serviço |

**Você, quando a TI indicar a pasta institucional** (comandos no terminal do Codespace, na pasta do projeto):

```bash
cd backups
gpg --symmetric --cipher-algo AES256 slm-completo-2026-11-06T13-04-28-246Z.dump
#   o gpg pede uma senha: forte, entregue à TI para o cofre, nunca junto da cópia
sha256sum slm-completo-2026-11-06T13-04-28-246Z.dump.gpg > slm-completo-2026-11-06T13-04-28-246Z.dump.gpg.sha256
```

Baixe os dois arquivos `.gpg` e `.gpg.sha256` pelo explorador do VS Code (botão direito → Download), grave-os na pasta institucional e peça à TI para conferir com `sha256sum -c`. Os arquivos originais continuam no Codespace; nada é apagado.

Se você escolher migrar o banco real (em vez do projeto separado), a primeira etapa do script gera **outra** cópia, com o registro exigido pela segunda etapa; essa nova cópia também precisa ir para a pasta institucional antes de aplicar.

## B. Contas no banco real

Levantamento somente leitura de 06/11. Sem nomes e e-mails; a referência são os 8 primeiros caracteres do identificador interno. Para ver quem é cada pessoa, use a tela **Cadastros pendentes**, com a sua conta de administradora.

| Ref. | Situação | Domínio | Setor de lotação | Cadastro | Observação | Decisão necessária |
|---|---|---|---|---|---|---|
| `cadc056e` | Ativa, administradora | `jucesp.sp.gov.br` | CPC | 20/10/2026 | Conta inicial, 134 logins, último em 05/11 | Ver seção C |
| `c0762467` | Pendente | `jucesp.sp.gov.br` | Coordenadoria de Patrimônios e Contratos | 04/11/2026 13:21 | — | Aprovar? Com qual perfil? É um dos 4 operadores da SLM? |
| `5255e49a` | Pendente | **`jucespmail.sp.gov.br`** | Coordenadoria de Patrimônios e Contratos | 05/11/2026 11:29 | Único com esse domínio, um minuto antes de outros dois cadastros | Confirmar se o domínio é institucional e se não é a mesma pessoa de outro cadastro |
| `fdd991a2` | Pendente | `jucesp.sp.gov.br` | Coordenadoria de Patrimônios e Contratos | 05/11/2026 11:30 | — | Aprovar? Com qual perfil? |
| `9c837395` | Pendente | `jucesp.sp.gov.br` | Coordenadoria de Patrimônios e Contratos | 05/11/2026 11:30 | — | Aprovar? Com qual perfil? |
| `27f07d91` | Inativa, operador antigo | `example.gov.br` (fictício) | RH | 03/11/2026 | Criada por engano no incidente de 03/11; nunca entrou; tem 8 permissões antigas de escrita | Manter inativa ou excluir (exclusão só com sua autorização) |
| `a544cbb3` | Rejeitada | `example.gov.br` (fictício) | CPC | 03/11/2026 | Criada por engano no incidente de 03/11 | Manter rejeitada ou excluir |

Efeito das migrações sobre elas, se aplicadas no banco real (ensaiado sobre a cópia): a administradora vira **Administrador, fora da equipe SLM**; a conta fictícia inativa vira **Solicitante sem permissões**, sem perder o histórico; pendentes e rejeitada não mudam.

**Com o projeto separado**, nenhuma dessas contas é copiada: cada operador cria a conta de novo no ambiente de homologação, e as decisões acima ficam para a produção.

## C. Administradora atual e habilitação dos operadores

**Situação:** depois das migrações, a administradora continua administrando usuários, cadastros, configurações, auditoria e o Almoxarifado (materiais, estoque, inventário, situação, entrega), mas **não** agenda nem informa ou altera a previsão de entrega, porque não estará na equipe SLM (regra P-08, ajustada em 06/11/2026). Ela também não pode alterar o próprio acesso. Isso não impede a homologação: quem agenda e opera são os operadores.

**Procedimento, depois das migrações (vale para o projeto separado e para o banco real):**

1. **Administradora:**
   - **No projeto separado**, ela é criada com o comando da seção E, passo 3.
   - **No banco real**, ela entra com a conta atual.
2. **Cada operador** abre o endereço de homologação, clica em **Criar conta** e se cadastra com o e-mail institucional. No banco real, os cadastros que já existem podem ser usados, se forem dos operadores.
3. **Administradora → Administração → Cadastros pendentes →** em cada operador:
   - **Perfil ao aprovar:** `Operador SLM`. A equipe SLM fica marcada automaticamente, porque o perfil exige.
   - **Já incluído no perfil** (desde 08/11/2026, sem marcar nada): **Realizar agendamentos**, **Almoxarifado → Administrar o módulo** e **Almoxarifado → Informar e alterar a previsão de entrega**. Valem só enquanto o operador estiver na equipe SLM.
   - **Permissões adicionais:** marque só o que não vem do perfil e que esse operador fará na homologação:

| Permissão (como aparece na tela) | Para quê | Sugestão para os testes |
|---|---|---|
| Acessar a Central de Operações / Atribuir responsáveis, prioridades e prazos pela Central | Central SLM | Pelo menos 1 |
| Consultar o CPF completo dos passageiros (auditado) | Passagens | 1, só se for necessário testar |
| Abrir solicitações em nome de outros setores | Abertura para outro setor | 1 |

   - Clique em **Aprovar**.
   - **Para os testes negativos C6 e A6 do roteiro**, um operador precisa ficar sem agendar. Como agendar vem do perfil, não basta deixar de marcar: depois de aprovar, abra **Administração → Usuários →** esse operador, em **Permissões** escolha **Retirar** em "Realizar agendamentos" e clique em **Salvar acesso**. A tela passa a mostrar "Sem acesso · retirada individualmente".
4. **Conferência:**
   - cada operador abre **Minha conta** e confere as permissões;
   - a administradora preenche a tabela "Concessões por operador" no início do roteiro (Agendar e Almoxarifado vêm do perfil: marque "sim", ou "retirada" no operador dos testes negativos);
   - em **Usuários**, o histórico de cada conta mostra quem aprovou e quando.
5. **Contas extras para o roteiro:**
   - uma de **Solicitante** de outro setor, nomeada "Homologação – Solicitante";
   - uma de **Motorista**, para o caso D4.

   Na aprovação, use os perfis `Solicitante` e `Motorista`. Não é possível conceder "Almoxarifado → Administrar o módulo" a nenhuma das duas: a tela bloqueia a opção e o servidor recusa e registra a tentativa na auditoria.
6. **Setores fictícios (aprovados em 06/11/2026, Supercomando 17):** `HOMOLOG – Setor A` e `HOMOLOG – Setor B`. Cadastre os dois pela interface administrativa, nos dois catálogos: **Configurações → Setores** e **Controle de Demandas → Configurações → Setores**. Não crie setores direto no banco.
7. **Se for preciso uma administradora na equipe SLM:** aprove primeiro um segundo administrador. Ele marca a administradora na equipe SLM na tela do usuário (**Perfil e equipe SLM**), e vice-versa. Isso não é necessário para a homologação.

**Recuperação de senha:** sem o Resend configurado, "Esqueci a senha" não envia e-mail. Oriente os operadores a guardar a senha. Para a administradora existe o comando `backend/src/cli/reset-initial-admin-password.ts`.

## D. Acesso dos quatro operadores

| Opção | Situação | Depende de |
|---|---|---|
| **1. Servidor interno de homologação, com HTTPS na rede da JUCESP (recomendado)** | Instruções completas em `INSTRUCOES_TI_HOMOLOGACAO.md`, item 2 | TI |
| 2. Hospedagem em nuvem contratada, com acesso restrito | Mesmos passos | TI e contratação |
| 3. Homologação assistida na sua sessão | Paliativo: cada operador usa a própria conta, na sua presença, no seu computador | Você |
| ~~Codespace público~~ | **Descartado:** exporia o ambiente de desenvolvimento na internet | — |

## E. Comandos exatos do projeto separado

*Atualizado em 06/11/2026 (Supercomando 11): o projeto é `jucesp-logistica-homologacao`, referência `rrqulhpnghoetgrdswqr`. Os comandos passam por `scripts/homologacao.cjs`, que substitui a função `H` da versão anterior desta seção. Relatório: `docs/auditoria/PREPARACAO_HOMOLOGACAO_2026-11-06.md`.*

**Credencial:** segredo do Codespaces `SLM_HOMOLOG_DATABASE_URL`, com o endereço do **Session pooler** (porta 5432, usuário `postgres.rrqulhpnghoetgrdswqr`). Passo a passo no relatório. Nunca colar a senha na conversa nem em arquivo versionado.

O script só executa quando o destino é exatamente esse projeto e não é o do `backend/.env`. Ele nunca mostra a senha nem o endereço.

```bash
npm run homolog -- verificar
#   só leitura: projeto, TLS, papel, versão, extensões e situação ("VAZIO")

npm run homolog -- estrutura --confirmar=HOMOLOGACAO-rrqulhpnghoetgrdswqr
#   grava: estrutura inicial (001), em transação única, só com public vazio

npm run homolog -- -- node scripts/apply-migrations.cjs --aplicar --confirmar=APLICAR-MIGRACOES
#   saída 5: backup do banco de homologação em backups/homologacao/, testado

npm run homolog -- -- node scripts/apply-migrations.cjs --aplicar --confirmar=APLICAR-MIGRACOES --backup=backups/homologacao/<arquivo>.dump
#   saída 0: as migrações pendentes (desde 12/11/2026, nenhuma nos dois bancos)

npm run homolog -- -- npm run migrations:check
#   "Nenhuma migração pendente."

npm run homolog -- -- npm run db:inspect
#   conferência posterior, só leitura

npm run homolog -- -- npx tsx backend/src/cli/create-initial-admin.ts
#   administradora da homologação
```

**Uso assistido** (opção 3 da seção D), em portas próprias. A API e a tela de desenvolvimento ligadas ao banco real (3000 e 5173) não mudam:

```bash
npm run homolog -- -- npm run dev:backend     # terminal 1: API da homologação na porta 3100
npm run homolog -- -- npm run dev:frontend    # terminal 2: tela da homologação na porta 5174
```

**Atenção:** sem `npm run homolog -- --` na frente, os comandos usam o `backend/.env`, que é o **banco real**.

## F. Quem faz o quê

| # | Ação | Quem | Bloqueia o início? |
|---|---|---|---|
| 1 | Decidir: projeto separado (recomendado) ou banco real | **Você** | Sim |
| 2 | Encaminhar `INSTRUCOES_TI_HOMOLOGACAO.md` à TI | **Você** | Sim |
| 3 | Pasta institucional restrita para o backup, e senha no cofre | **TI** | Só se migrar o banco real |
| 4 | Cifrar e gravar a cópia na pasta (seção A) | **Você** | Só se migrar o banco real |
| 5 | Criar o projeto Supabase de homologação | **TI** ou **você** | Sim (opção recomendada) |
| 6 | Aplicar 001 e as migrações 002 a 020 no projeto de homologação (seção E) — **feito** (020 em 12/11/2026) | **Você**, ou eu, se liberar a ferramenta | Sim |
| 7 | Servidor de homologação com HTTPS na rede interna | **TI** | Sim, para os operadores acessarem sozinhos |
| 8 | Gerar `PASSENGER_DATA_KEY` e definir `ATTACHMENTS_DIR` no servidor de homologação | **TI** | Não (Passagens e anexos ficam pendentes no roteiro) |
| 9 | Criar a administradora e aprovar os 4 operadores (seção C) | **Você** | Sim |
| 10 | Decidir sobre os 4 pendentes e as 2 fictícias do banco real | **Você** | Não, se usar o projeto separado |
| 11 | Executar o roteiro de 51 casos | **4 operadores** | — |
| 12 | Avaliar os resultados e corrigir os erros apontados | Desenvolvimento | — |

**Caminho mais rápido:** 1 → 2 → 5 → 6 → 9, e a homologação começa assistida na sua sessão (opção 3) enquanto a TI prepara o servidor (7). Nada disso altera o banco real.
