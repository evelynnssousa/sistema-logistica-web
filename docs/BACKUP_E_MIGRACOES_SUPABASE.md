# Backup e migrações no Supabase

## Conexão

A API conecta ao PostgreSQL do Supabase por `backend/src/database/pool.ts`, com o driver `pg`.

| Variável | Uso | Obrigatória |
|---|---|---|
| `DATABASE_URL` | Endereço do banco, pelo session pooler (porta 5432) | Sim |
| `DB_POOL_MAX` | Limite de conexões da API | Não (padrão 5) |
| `DATABASE_SSL_CA_PATH` | Outro certificado de CA | Não |
| `PASSWORD_RESET_PEPPER`, `RESEND_API_KEY`, `RESEND_FROM` | Recuperação de senha | Só para essa função |
| `SESSION_CLEANUP_ENABLED` | Liga ou desliga a limpeza de sessões | Não |

Bancos remotos sempre usam TLS verificado com `backend/certificates/prod-ca-2021.crt`.

O projeto não usa as APIs do Supabase (Auth, Storage, PostgREST): a API própria acessa o PostgreSQL diretamente.

## Backup

### Métodos

| Método | Situação |
|---|---|
| `pg_dump` pelo session pooler | **Testado.** É o recomendado antes de cada migração |
| Backups automáticos do painel do Supabase | Depende do plano. Confira em Database → Backups: não é visível pelo banco |
| Transaction pooler (porta 6543) | Não use com `pg_dump` |
| `pg_dumpall` | Não funciona: o papel `postgres` do Supabase não é superusuário |

### Gerar

Exige Docker (usa a imagem `postgres:17`, mesma versão principal do servidor):

```bash
npm run backup:database
```

O arquivo vai para `backups/`, que o Git ignora, com permissão só para o dono. O `pg_dump` trabalha em uma transação somente de leitura e não altera o banco.

**O arquivo contém dados pessoais e hashes de senha.** Não o envie por e-mail ou chat, não o coloque no repositório e guarde-o em local com acesso restrito.

### Conferir

O comando mostra o SHA-256 e as contagens. Para um backup válido do banco atual, espere:

| Item | Esperado |
|---|---|
| Tabelas | 11 |
| Blocos de dados | 11 |
| Índices | 17 (os demais vêm das chaves) |
| Chaves estrangeiras | 18 |
| Tabelas com RLS | 11 |
| Políticas de RLS | 0 |
| Privilégios | 18 |

Anote o SHA-256 e confirme depois com `sha256sum <arquivo>`. Um backup só é confiável depois de restaurado, como abaixo.

### Testar a restauração

```bash
npm run backup:verify -- backups/<arquivo>.dump
```

Confere o SHA-256, restaura em um PostgreSQL descartável, compara as tabelas e mostra só as quantidades de registros. **Sem esta aprovação, a cópia não é considerada confiável.** Os privilégios dos papéis do Supabase não são restaurados nesse teste; para conferi-los, use o procedimento manual abaixo.

`npm run test:backup` prova o mesmo caminho só com dados fictícios, incluindo a reprovação de uma cópia adulterada. Não testa uma cópia real do Supabase: isso depende de autorização.

### Política proposta

Valores a confirmar com a TI. A rotina automática **não está ativa**, porque depende da infraestrutura aprovada, e nenhuma cópia vai para serviço externo sem autorização institucional.

| Item | Proposta |
|---|---|
| Frequência | Diária, com `npm run backup:database` em agendador da TI, e antes de cada migração |
| Retenção | 7 diárias, 4 semanais, 12 mensais |
| Local | Área de acesso restrito, separada do servidor da aplicação, com a cópia cifrada |
| Integridade | SHA-256 gravado ao lado de cada cópia, conferido na restauração |
| Teste de restauração | Mensal, com `npm run backup:verify`, e sempre depois de mudar o procedimento |
| Registro | `BACKUP_LOG_PATH`, exibido na tela de Monitoramento, sem credenciais nem caminhos |
| Alerta de falha | O agendador avisa pelo código de saída do comando. A tela também mostra a última falha |
| Anexos | Pasta de `ATTACHMENTS_DIR` com cópia própria, fora do `pg_dump` |
| Chave | `PASSENGER_DATA_KEY` guardada à parte: sem ela, os CPFs da cópia ficam ilegíveis |

### Restaurar em ambiente separado

**Nunca aponte estes comandos para o Supabase.** Eles criam um banco descartável na própria máquina:

```bash
export PGPASSWORD_RESTORE="$(openssl rand -hex 16)"
docker run -d --name slm-restauro --rm \
  -e POSTGRES_PASSWORD="$PGPASSWORD_RESTORE" -e POSTGRES_DB=restauro_test \
  -p 127.0.0.1:55442:5432 --tmpfs /var/lib/postgresql/data postgres:17

# Aguarde alguns segundos. Os papéis do Supabase precisam existir para restaurar os privilégios.
docker exec -i slm-restauro psql -U postgres -d restauro_test -c "
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS; CREATE ROLE supabase_admin NOLOGIN;
  DROP SCHEMA public CASCADE;"

docker run --rm --network host -e PGPASSWORD="$PGPASSWORD_RESTORE" \
  -v "$PWD/backups:/d" postgres:17 pg_restore --host=127.0.0.1 --port=55442 \
  --username=postgres --dbname=restauro_test --exit-on-error /d/<arquivo>.dump

docker exec -i slm-restauro psql -U postgres -d restauro_test \
  -c "SELECT count(*) FROM public.auth_users; SELECT count(*) FROM public.auth_audit_events;"

docker stop slm-restauro
```

Compare as contagens com as do banco de origem. Como o banco usa `tmpfs`, os dados somem ao parar o container.

### Cópia externa e recuperação (P-10)

Achado da auditoria: as cópias estavam só em `backups/`, no próprio Codespace. Uma cópia na mesma máquina não protege contra a perda da máquina. O procedimento abaixo vale para o banco real e para a produção. **Nenhuma cópia foi enviada para fora nem apagada nesta etapa:** o destino depende de decisão institucional.

**Os anexos não estão no `pg_dump`.** Ficam em `ATTACHMENTS_DIR` e têm cópia própria:

```bash
npm run backup:attachments                       # pacote .tar.gz, manifesto com SHA-256 de cada arquivo e .sha256
npm run backup:attachments:verify -- backups/slm-anexos-<data>.tar.gz
```

A verificação confere o SHA-256 do pacote, restaura em pasta temporária e confere cada arquivo. Para restaurar de verdade, use `--restaurar-em <pasta-vazia>`; o script nunca escreve sobre uma pasta com conteúdo. `npm run test:backup` testa os dois caminhos com dados fictícios, inclusive cópia adulterada.

**Passo a passo da cópia externa:**

1. Gere as cópias: `npm run backup:database` e, se houver anexos, `npm run backup:attachments`.
2. Teste as cópias: `npm run backup:verify -- <arquivo.dump>` e `npm run backup:attachments:verify -- <arquivo.tar.gz>`. Só uma cópia aprovada segue.
3. Cifre cada arquivo antes de sair da máquina, com senha guardada em cofre da instituição, separada da cópia:
   `gpg --symmetric --cipher-algo AES256 <arquivo>` (gera `<arquivo>.gpg`).
4. Leve o `.gpg` e o `.sha256` para o destino externo aprovado (unidade institucional, armazenamento da TI). **Não use e-mail, chat nem o repositório.**
5. No destino, confira: `sha256sum -c <arquivo>.gpg.sha256` (gere esse arquivo no passo 3 com `sha256sum <arquivo>.gpg > <arquivo>.gpg.sha256`).
6. Registre data, arquivo, SHA-256, destino e quem fez. Só então a cópia conta como externa.

**Retenção proposta (a confirmar com a TI):** 7 diárias, 4 semanais e 12 mensais, mais a cópia de antes de cada migração, guardada até a migração seguinte ser aprovada. Nenhuma cópia é apagada antes de existir outra mais nova, verificada e já no destino externo. A chave `PASSENGER_DATA_KEY` e a senha das cópias ficam em cofre, separadas das cópias.

**Integridade:** cada cópia tem SHA-256 gerado na criação; a verificação recalcula e compara antes de restaurar. Uma cópia só é confiável depois de restaurada com sucesso (passo 2) e com o SHA-256 conferido no destino (passo 5).

**Recuperação, em ordem:**

1. Pare a API, para não haver gravação durante a recuperação.
2. Escolha a cópia mais recente com SHA-256 conferido. Decifre com `gpg --decrypt`.
3. Teste a cópia em banco descartável (`npm run backup:verify`) e confira as contagens.
4. **Banco:** restaurar sobre o Supabase real é uma decisão da responsável e da TI, com autorização expressa, porque substitui os dados atuais. O caminho é `pg_restore --clean --if-exists --no-owner` contra o session pooler, como `postgres`, a partir da cópia aprovada; os privilégios padrão de `supabase_admin` não são restaurados e precisam ser conferidos depois (`npm run migrations:check` e a consulta de divergências acima). Alternativa sem sobrescrever: restaurar em projeto Supabase novo e apontar `DATABASE_URL` para ele.
5. **Anexos:** `npm run backup:attachments:verify -- <arquivo> --restaurar-em <pasta-vazia>` e aponte `ATTACHMENTS_DIR` para essa pasta, ou mova o conteúdo, com a API parada.
6. Confira a chave: um passageiro de teste lido com o CPF mascarado prova que `PASSENGER_DATA_KEY` é a mesma da cópia.
7. Suba a API, confira `/api/health`, o login e um anexo antigo.

**O que foi comprovado e o que não foi:** a geração, a verificação e a restauração foram testadas em banco e pastas descartáveis (`npm run test:backup`, `npm run test:migrations`). A cópia de 04/11 do banco real restaurou no ensaio da auditoria. **Nunca foi testada** a restauração sobre um projeto Supabase, nem a cópia em destino externo: ambas dependem de infraestrutura e autorização. A rotina automática também depende do agendador da TI (ver `PRODUCAO.md`).

### O que precisa ser preservado

- **Dados:** as 11 tabelas de `public`, principalmente `auth_users` (com os hashes de senha), `auth_audit_events` e `auth_sessions`.
- **Estrutura:** colunas, `CHECK`, chaves estrangeiras, índices, gatilhos e funções.
- **Segurança:** RLS ativo nas 11 tabelas e privilégios de cada papel.
- **Sequências:** o contador de `auth_audit_events` e os protocolos.
- **Fora do banco:** `backend/.env` e os segredos ficam em local próprio. O backup não os contém.

`auth`, `storage`, `realtime` e `vault` são administrados pelo Supabase. O sistema não os usa, e hoje `auth.users` e `storage.objects` estão vazios, por isso não entram neste backup. Se passarem a ser usados, será preciso rever o procedimento.

## Migrações pendentes

Nenhuma foi aplicada. O banco também não tem tabela de registro de migrações: hoje, a presença de cada tabela é o único registro.

Faça um backup antes e aplique uma de cada vez, conferindo o resultado. Cada arquivo já tem sua própria transação. O script abaixo faz isso.

### Inspecionar antes e depois

`npm run db:inspect` mostra, em transação somente leitura, a estrutura, os donos, a RLS, os privilégios dos papéis da API do Supabase, as funções, os gatilhos, as contagens e as contas por perfil e situação (só contagens e domínios, sem dados pessoais). Use antes de aplicar e depois, junto com `npm run migrations:check`.

### Aplicar com o script

Exige Docker. Prefira um horário sem uso e pare a API e a tela ligadas ao banco real antes de começar: qualquer dado novo depois do backup faz o script recusar a cópia. Rode no terminal do Codespaces, ou no prompt do Claude Code com o prefixo `!`, que não faz parte do comando.

**1. Conferir, só com leitura:**

```bash
npm run migrations:check
```

**2. Primeira etapa: gerar e testar o backup.** O script gera a cópia, testa a restauração em um banco descartável, registra o arquivo e os dados do banco e para, com código 5. **Nada é aplicado.**

```bash
node scripts/apply-migrations.cjs --aplicar --confirmar=APLICAR-MIGRACOES
```

**3. Guardar a cópia fora do Codespace.** Use o arquivo mostrado no passo anterior:

```bash
gpg --symmetric --cipher-algo AES256 backups/<arquivo>.dump
sha256sum backups/<arquivo>.dump.gpg
```

Baixe o `.gpg` pelo Explorer do VS Code ou, no seu computador, com `gh codespace cp -c <codespace> 'remote:/workspaces/sistema-logistica-web/backups/<arquivo>.dump.gpg' ./`. No destino, confira o SHA-256 e abra a cópia com `gpg --decrypt`. Guarde a senha em outro lugar. Não apague o `.dump` nem o `.manifesto.json` do Codespace antes do próximo passo.

**4. Segunda etapa: aplicar.**

```bash
node scripts/apply-migrations.cjs --aplicar --confirmar=APLICAR-MIGRACOES --backup=backups/<arquivo>.dump
```

Antes de aplicar, o script faz duas conferências independentes e, se alguma falhar, sai com código 1 sem aplicar nada:

- **O arquivo é o mesmo:** compara o SHA-256 do `.dump` com o registrado na primeira etapa.
- **Os dados são os mesmos:** o `.manifesto.json` guarda um resumo de todas as linhas e colunas das tabelas de `public`. O script calcula o resumo de novo no banco, somente com leitura, e compara. Qualquer linha criada, alterada ou apagada muda o resumo. Uma sessão em uso também muda, por isso a API precisa estar parada. Nesse caso, volte ao passo 2.

Sobra um intervalo de instantes entre a conferência e a primeira migração, que o script não fecha. Por isso, o sistema precisa continuar parado até o fim.

Depois, o script aplica as pendentes, da 002 à 017, parando no primeiro erro, e faz a conferência final.

**Transações:** cada arquivo de migração tem o próprio `BEGIN` e `COMMIT`, e não existe transação única para todas. Por isso, uma falha pode deixar parte aplicada: a migração em andamento é desfeita, e as anteriores permanecem. O código 2 indica esse caso.

| Código de saída | Significado |
|---|---|
| 0 | Concluído, ou nada pendente |
| 1 | Recusado antes de aplicar: nada mudou no banco |
| 2 | A aplicação começou e falhou. Cada migração tem a própria transação: a que falhou foi desfeita, as anteriores permanecem e as seguintes não rodaram. Corrija e rode de novo, pois as já aplicadas são reconhecidas. Se a mensagem disser que a conexão caiu, rode `npm run migrations:check` antes, para ver o estado |
| 3 | Todas aplicadas, e a conferência final encontrou um problema. Revise antes de usar |
| 4 | Todas aplicadas, e a conferência final não conseguiu terminar, como em uma queda de conexão. Rode `npm run migrations:check` e confira antes de usar |
| 5 | Primeira etapa concluída: backup pronto e nada aplicado. Falta guardar a cópia e rodar a segunda etapa |

Se o processo for interrompido à força, como por Ctrl+C, o código é outro. A migração em andamento é desfeita pelo banco quando a conexão termina, e `npm run migrations:check` mostra o estado.

`npm run test:migrations` prova esse caminho em um banco descartável, com os privilégios automáticos do Supabase.

| | 002_password_recovery | 003_user_access | 004_flight_passengers |
|---|---|---|---|
| **Cria** | `password_recovery_codes` | `auth_user_access` | `flight_request_passengers` |
| **Altera dados existentes** | Não | Não; lê `auth_users` para preencher a tabela nova e acrescenta nela um gatilho de coerência | Não |
| **Depende de** | `auth_users` | `auth_users` | `service_requests` |
| **Depende de outra migração** | Não | Não | Não |
| **Libera** | Recuperação de senha, com as 3 variáveis configuradas | Edição de perfil, equipe SLM e permissões | Consulta de passageiros e CPF |
| **Sem ela** | A recuperação responde normalmente, mas não envia código | Essa edição responde 503 | Essas rotas respondem 503 |
| **Reverter** | `DROP TABLE public.password_recovery_codes;` | `003_user_access.rollback.sql` | `DROP TABLE public.flight_request_passengers;` |
| **O que se perde ao reverter** | Códigos em andamento | Permissões individuais e equipe SLM definidas depois | **CPFs cadastrados.** Não reverta se já houver dados |

Reinicie a API depois de reverter a 003.

### Migração 005: módulos operacionais

Aplique depois da 003 e da 004, com backup e autorização, como as demais.

| | 005_operational_modules |
|---|---|
| **Cria** | `catalog_options`, `request_occurrences`, `material_request_history`, `inventory_checks`, `inventory_check_items`, função `reject_history_change` |
| **Altera a estrutura de** | `service_requests`, `request_history`, `materials`, `material_requests`, `material_request_items`, `flight_request_passengers`, `setores` (índice) e `auth_audit_events` (gatilho) |
| **Reescreve registros** | Não. Status antigos continuam aceitos e são traduzidos na leitura |
| **Para com erro se** | Já houver passageiros com CPF em texto; ou houver nomes duplicados em `setores` ou `materials`, ou material repetido em um mesmo pedido (índices únicos) |
| **Libera** | Todos os módulos operacionais, com a chave `PASSENGER_DATA_KEY` configurada para Passagens |
| **Sem ela** | As rotas dos módulos respondem 503 com `MODULES_MIGRATION_REQUIRED`, e nada é gravado |
| **Reverter** | `005_operational_modules.rollback.sql`, que para com erro se os módulos já tiverem dados |

**Antes de cadastrar passageiros reais**, configure `PASSENGER_DATA_KEY`, com `openssl rand -base64 32`. **Guarde a chave fora do banco e dos backups, e faça uma cópia segura: sem ela, os CPFs gravados não podem ser lidos.** Trocar a chave exige um procedimento de nova cifragem, que ainda não existe.

### Migração 006: integrações e automações

Pendente, como as demais. Só cria tabelas (`integration_events`, `email_deliveries`, `user_notifications`, `calendar_sync_items`, `integration_attempts`), com RLS e sem acesso de `anon`, `authenticated` ou `service_role`. Depende da 005 e não altera registros existentes.

- **Pode ser aplicada depois da 005.** Sem ela, as solicitações funcionam, mas as comunicações geradas nesse intervalo não existem na fila.
- **Efeito no ambiente de desenvolvimento:** cada ação passa a registrar e-mails e notificações no banco real. Nada é enviado sem autorização expressa. Veja `AMBIENTES.md`.
- **Reverter:** `006_integrations.rollback.sql`. Apaga a fila, as notificações e o registro de sincronização, sem tocar em solicitações, histórico e auditoria. Eventos já criados em um calendário externo não são removidos.
- **Eventos e tentativas não podem ser alterados nem apagados**, nem por SQL direto, enquanto o gatilho existir.

Depois da 005, a conferência de backup muda: são 19 tabelas com RLS, somadas as migrações 002 a 005, e 24 com a 006. A trava de imutabilidade em `auth_audit_events` impede também limpezas diretas por SQL, e a retenção da auditoria precisará de procedimento próprio, se for adotada.

### Migrações 007 a 010: Supercomando 04

Aplique nesta ordem, depois da 006, com backup e autorização, como as demais. Sem cada uma, a função correspondente responde 503, e o restante continua funcionando.

| | 007_operations_center | 008_attachments | 009_module_extensions | 010_monitoring |
|---|---|---|---|---|
| **Cria** | `protocol_counters`, `request_internal_notes`, `system_settings` | `request_attachments` | `vehicles`, `vehicle_logs`, `equipments`, `maintenance_executions`, `flight_quotes` | `technical_events`, `availability_periods`, `access_reviews` |
| **Altera a estrutura de** | `service_requests`, `material_requests`, `inventory_checks`; corrige a mensagem da função `reject_history_change` | Nada | `stock_movements` (gatilho de imutabilidade) | Nada |
| **Altera registros existentes** | **Só preenche a coluna nova `protocolo_codigo`.** Número antigo, status e `updated_at` não mudam | Não | Não | Não |
| **Libera** | Protocolo único, Central da SLM, prazos, parâmetros | Anexos, com `ATTACHMENTS_DIR` | Veículos, equipamentos, execução, cotações, estoque interno | Monitoramento e revisão de acessos |
| **Reverter** | `007_operations_center.rollback.sql`, que para se houver observações | `008_attachments.rollback.sql`, que para se houver anexos | `009_module_extensions.rollback.sql`, que para se houver registros | `010_monitoring.rollback.sql` |

**Antes de aplicar a 007, decida o momento:** os códigos são permanentes e passam a sair em e-mails e agenda. Reverter depois de divulgá-los não é recomendado: reaplicar pode gerar códigos diferentes. Se a solução antiga continuar registrando pedidos em paralelo, os dois sistemas terão numerações independentes.

**A 007 bloqueia gravações** em `service_requests`, `material_requests` e `inventory_checks` enquanto preenche os códigos. Com o volume atual, é breve. Prefira um horário sem uso.

**Depois das migrações**, as tabelas com RLS passam de 24 para 35, e `stock_movements` deixa de aceitar alteração ou exclusão por SQL direto.

### Migração 011: Supercomando 05

Aplique depois da 010, com backup e autorização, como as demais. Só acrescenta estrutura e não altera registros existentes. Sem ela, os pedidos continuam funcionando, e informar a previsão, indicar o e-mail do solicitante ou escrever uma observação sobre a entrega responde 503.

| | 011_delivery_forecast |
|---|---|
| **Cria** | `material_delivery_history`, com gatilho de imutabilidade |
| **Altera a estrutura de** | `material_requests`: colunas `previsao_entrega`, `previsao_revisao` e `solicitante_email` |
| **Altera registros existentes** | Não |
| **Libera** | Previsão e controle de entrega dos materiais |
| **Reverter** | `011_delivery_forecast.rollback.sql`, que para se houver previsões, e-mails ou histórico |

Depois dela, as tabelas com RLS passam de 35 para 36.

### Migração 012: Supercomandos 06 e 07

Aplique depois da 011, com backup e autorização, como as demais. Só acrescenta estrutura e não altera registros existentes. Sem ela, os fluxos continuam funcionando, e devolução, motivos por item, reserva, versões de modelos e formulários e controle interno respondem 503.

| | 012_operational_transparency |
|---|---|
| **Cria** | `request_returns`, `material_item_changes`, `settings_change_history`, `config_versions`, `warehouse_control_records` |
| **Altera a estrutura de** | `service_requests`, `auth_users`, `materials`, `material_request_items` |
| **Altera registros existentes** | Não |
| **Reverter** | `012_operational_transparency.rollback.sql`, que para se houver registros |

### Migração 013: Supercomando 08

Aplique depois da 012, com backup e autorização, como as demais. Só cria `manual_emails` e `manual_email_attachments`, sem alterar registros. Sem ela, só o envio manual responde 503. Reverter: `013_communications.rollback.sql`, que para se houver mensagens.

### Migração 014: Supercomando 09

Aplique depois da 013, com backup e autorização, como as demais. Cria as tabelas do Controle de Demandas e 10 categorias iniciais editáveis, sem setores. Em tabelas existentes, só amplia duas listas de valores aceitos: `protocol_counters.prefixo` ganha `DEM`, e `integration_events.module` ganha `demands`. Nenhum registro existente muda. Sem ela, o módulo fica oculto. Reverter: `014_demands.rollback.sql`, que para se houver demandas ou setores. Veja `CONTROLE_DE_DEMANDAS.md`.

### Migração 015: Supercomando 10

Aplique depois da 014, com backup e autorização, como as demais. Cria `user_directorate_links` e acrescenta colunas com valor padrão em `demand_sectors`, `demand_sector_members` e `demands`. Nenhum dado existente muda, e ninguém ganha vínculo ou acesso. Sem ela, o módulo fica oculto, e a aprovação de cadastros segue funcionando, sem os vínculos. Reverter: `015_organizational_structure.rollback.sql`, que para se já houver vínculos, e deve vir antes da reversão da 014.

### Migração 016: Supercomando 11

Aplique depois da 015, com backup e autorização, como as demais. Cria `fleet_drivers`, `request_occurrence_attachments` e `fleet_execution_corrections`. Acrescenta colunas vazias em `service_requests` (`motorista_id`, `motorista_observacoes`) e em `request_occurrences` (`categoria`, `motorista_id`), e aceita o perfil `driver` em `auth_user_access`. Nenhum registro existente muda, e ninguém vira motorista por causa dela. Sem ela, a Frota segue igual, e só o portal, o cadastro de motoristas e o perfil Motorista ficam indisponíveis. Reverter: `016_driver_portal.rollback.sql`, que para se já houver motoristas, contas de perfil Motorista ou correções. Veja `PORTAL_DO_MOTORISTA.md`.

### Migração 017: configurações do Portal do Motorista

Aplique depois da 016, com backup e autorização, como as demais. Cria `driver_occurrence_types`, com os seis tipos iniciais. Em `request_occurrences`, acrescenta `categoria_nome` e `justificativa` e troca a lista fixa de `categoria` por chave estrangeira para o cadastro. Acrescenta `execucao_registro`, vazia, em `service_requests`. Ocorrências já gravadas recebem em `categoria_nome` o nome que aparecia quando foram registradas. Os parâmetros usam `system_settings` e `settings_change_history`, que já existem, e nenhum é gravado pela migração: valem os padrões até alguém salvar. Sem ela, a Frota segue igual, mas com a 016 aplicada o portal responde 503, por isso as duas devem ir juntas, como o script já faz. Reverter: `017_driver_portal_settings.rollback.sql`, que para se já houver execução registrada, justificativa ou ocorrência com tipo novo. Os parâmetros e o histórico permanecem.

### Migração 018: fecha a API pública do Supabase (P-02)

Aplique depois da 017, com backup e autorização, como as demais; o script já a inclui. Não cria tabela nem toca em dados. Retira de `anon`, `authenticated`, `service_role` e `PUBLIC` todos os privilégios em tabelas, sequências e funções de `public`: na prática, os das 8 tabelas da versão anterior (`materials`, `material_requests`, `material_request_items`, `request_forms`, `request_history`, `service_requests`, `setores`, `stock_movements`), das sequências `service_requests_protocolo_seq` e `material_requests_protocolo_seq` e das funções `apply_stock_movement` e `set_updated_at`, que também passam a ter `search_path` fixo. RLS já negava leitura e escrita a `anon` e `authenticated`, mas não `TRUNCATE`, e `service_role` ignora RLS. A API conecta como dona das tabelas e não depende desses privilégios.

Como não cria tabela, o script a considera aplicada quando a 017 existe, nenhum objeto de `public` está aberto à API pública e as duas funções têm `search_path` fixo. Se alguém reabrir um privilégio depois, ela volta a aparecer como pendente, e aplicar de novo não tem outro efeito. Reverter: `018_public_api_privileges.rollback.sql`, que devolve exatamente os privilégios anteriores, conferidos no banco real em 05/11/2026. `npm run test:migrations` comprova, em banco descartável com os papéis do Supabase: antes, `anon` tem `TRUNCATE` em `materials`; depois, os três papéis não leem, gravam, esvaziam nem numeram nada, inclusive executando os comandos como cada papel; a reversão restaura o estado anterior.

### Migração 019: cota diária de e-mails (A1)

Criada em 08/11/2026, **não aplicada em nenhum banco remoto**, inclusive na homologação. Aplique depois da 018, com backup e autorização, como as demais; o script já a inclui (marcador `email_daily_usage`). Cria `email_daily_usage` (consumo por dia em UTC, notificações e recuperação de senha), com RLS e sem privilégios para a API pública, acrescenta `grouped_count` (padrão 1) e o índice `idx_email_deliveries_grouping` em `email_deliveries`, e **sela a fila anterior**: toda mensagem "pendente" ou "não configurada" (também em `manual_emails`) vira falha definitiva `BLOCKED_BEFORE_ACTIVATION`, com registro em `integration_attempts`, sem apagar nada. Na homologação, eram 4 mensagens em 08/11/2026. Depende da 006 e da 013. Sem ela, com `EMAIL_DAILY_LIMIT` definido, a fila de notificações não envia, a recuperação de senha segue sem contagem e os avisos administrativos saem um a um. Reverter: `019_email_quota.rollback.sql`, que para se houver aviso agrupado ainda não enviado. A selagem não é desfeita. Detalhes em `docs/INTEGRACOES_E_AUTOMACOES.md`.

### Migração 020: valores do Almoxarifado

Criada em 12/11/2026, **não aplicada em nenhum banco remoto**. Aplique depois da 019, com backup e autorização, como as demais; o script já a inclui (marcador `warehouse_price_agreements`). Cria `warehouse_price_agreements` (atas de registro de preços, com número único) e `material_value_adjustments` (registro permanente de cada valor informado para o saldo de um material), as duas com RLS e sem privilégios para a API pública. Acrescenta `valor_estoque` (padrão 0) em `materials` e, em `stock_movements`, `valor_total`, `valor_informado`, `nota_fiscal`, `empenho`, `fornecedor` e `ata_id`, todas vazias nas movimentações anteriores. Não altera nenhum registro existente. Depende da 007 e da 009. Sem ela, o estoque funciona sem valores, e a tela "Valores" responde que a migração falta. Reverter: `020_warehouse_finance.rollback.sql`, que para se já houver ata, valor informado ou movimentação com valor.

### Migração 021: atas e contratos no Controle de Demandas

Criada em 12/11/2026. Aplique depois da 020, com backup e autorização; o script já a inclui (marcador `contract_instruments`). Cria `contract_instruments` (ata ou contrato do setor responsável, com valor, vigência e antecedência do aviso), `contract_instrument_sectors` (compartilhamento), `contract_instrument_items` (quantidade registrada e valor unitário), `contract_instrument_usages` e `contract_instrument_amendments` (permanentes) e `contract_instrument_attachments` (mesmas garantias dos anexos das demandas), todas com RLS e sem privilégios para a API pública. Acrescenta `instrumento_id`, vazio, em `demands`. Não altera registros existentes. Depende da 014. Sem ela, a aba "Atas e Contratos" responde que a migração falta e o restante do Controle de Demandas segue igual. Reverter: `021_contract_instruments.rollback.sql`, que para se já houver ata ou contrato cadastrado.

### Migração 022: formulários editáveis, localização e atas no Almoxarifado

Criada em 13/11/2026. Aplique depois da 021, com backup e autorização. Não cria tabela: o script a reconhece pela coluna `contract_instrument_usages.stock_movement_id`. Acrescenta, vazias, `campos_personalizados` e `formulario_versao` em `material_requests`, `demands`, `contract_instruments`, `vehicles`, `equipments`, `materials`, `fleet_drivers`, `flight_quotes`, `maintenance_executions` e `request_occurrences`; `campos_entrega` em `material_requests`; `localizacao` em `materials`; `instrumento_item_id` em `stock_movements`; e `stock_movement_id` em `contract_instrument_usages`. Não altera registros existentes. Sem ela, os formulários seguem funcionando, mas campos novos preenchidos, localização e entrada pela ata respondem que a migração falta. Reverter: `022_forms_and_links.rollback.sql`, que para se já houver algum desses valores gravado.

**A baixa automática na entrega não depende da 020:** desde 12/11/2026, registrar a entrega de um pedido lança a saída no estoque interno em qualquer banco. Quem lançava saídas manuais para as entregas deve parar, para não baixar duas vezes.

**Conceda a Central individualmente.** Nem o perfil Administrador recebe `slm_central:read` e `slm_central:manage`: é preciso incluir as quatro pessoas na equipe SLM e conceder a cada uma, pela tela do usuário.

### O que a 003 faz com cada conta

| Conta atual | Resultado |
|---|---|
| `role = admin` | Administrador, fora da equipe SLM |
| `role = operator`, ativa ou não | Solicitante, fora da equipe, sem permissões especiais |
| **`role = operator` aprovada, com escrita em módulo** | **A migração para com erro.** Defina a equipe SLM antes, para ninguém perder o acesso sem aviso |
| Pendente ou rejeitada | Sem linha; ganha ao ser aprovada |

Ninguém entra automaticamente na equipe SLM nem recebe `warehouse:manage`, CPF, agendamento ou abertura em nome de outro setor.

**Atenção (P-08, corrigido em 06/11/2026):** agendar e informar ou alterar a previsão de entrega exigem a equipe SLM também para o Administrador. Como a 003 coloca todos os administradores fora da equipe, **depois de migrar, quem agenda e informa previsões é o Operador SLM** (pelo perfil, desde 08/11/2026, sem concessão manual), ou um administrador marcado na equipe SLM por outro administrador. A administração do Almoxarifado (materiais, estoque, inventário, situação e entrega) continua com o perfil Administrador, dentro ou fora da equipe.

**Depois de aplicar**, confira se não há divergências. O resultado precisa ser vazio:

```sql
SELECT u.id FROM public.auth_users u
  JOIN public.auth_user_access a ON a.user_id = u.id
 WHERE u.role IS DISTINCT FROM
       CASE WHEN a.profile = 'administrator' THEN 'admin' ELSE 'operator' END;
```

**A 003 não libera dados reais de passageiros.** Isso depende da 004 e da 005, com a chave de proteção configurada.

### Riscos

- **Bloqueio:** criar a chave estrangeira bloqueia escritas em `auth_users` por um instante. Com o volume atual, é imperceptível.
- **Privilégios padrão:** o Supabase concede automaticamente acesso a `anon`, `authenticated` e `service_role` em tabelas, funções e sequências novas. As migrações retiram esse acesso, e a conferência final reprova tabela, função ou sequência nova que continue aberta. **Migrações futuras precisam fazer o mesmo.**
- **Objetos anteriores às migrações:** as 8 tabelas, as 2 sequências e as 2 funções da versão anterior ficam acessíveis à API pública até a 018. Depois dela, a conferência final reprova qualquer objeto de `public` aberto a `anon`, `authenticated`, `service_role` ou `PUBLIC`.
- **CPF:** sozinha, a 004 guarda o número em texto. A aplicação só grava CPF com a 005 aplicada, cifrado com AES-256-GCM. Não insira passageiros entre as duas migrações: a 005 para com erro se encontrar algum.

## Testes e desenvolvimento

Consulte `docs/AMBIENTES.md`. **`npm run dev:backend` usa o banco de `backend/.env`**: o que for feito nessa API grava no banco real.
