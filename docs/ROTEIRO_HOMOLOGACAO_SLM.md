# Roteiro de homologação da SLM

Para os quatro operadores da SLM testarem o sistema na prática, depois da migração do banco autorizada. Preparado em 06/11/2026. Ver `docs/auditoria/PRE_MIGRACAO_2026-11-06.md`.

## Antes de começar

| Item | Responsável |
|---|---|
| Migrações 002 a 018 aplicadas e conferidas (`migrations:check` sem pendências) | Responsável pelo projeto |
| Banco confirmado como reservado para homologação | Responsável pelo projeto |
| Endereço de acesso definido (ver item 8 do relatório de pré-migração) | Responsável e TI |
| Contas dos quatro operadores aprovadas como **Operador SLM**, na **Equipe SLM**, com as concessões de cada um (agendar, Almoxarifado, Central SLM, CPF, em nome de outro setor) registradas abaixo | Administrador |
| Uma conta de **Solicitante** de outro setor, identificada como homologação (por exemplo, nome "Homologação – Solicitante") | Administrador |
| Um setor fictício "Homologação", para separar os registros de teste | Administrador |

**Regras:** use só dados de teste identificados como homologação (títulos começando com "HOMOLOG –"). Não use CPF real: use CPFs de teste válidos, como `123.456.789-09`. Não teste no sistema antigo. Se algo for corrigido durante a homologação, registre a alteração e o motivo na coluna de apontamentos e repita o caso.

**Concessões por operador** (preencher):

| Operador | Agendar | Almoxarifado | Central SLM | CPF completo | Em nome de outro setor |
|---|---|---|---|---|---|
| 1 | | | | | |
| 2 | | | | | |
| 3 | | | | | |
| 4 | | | | | |

## Como registrar

Para cada caso: **Resultado obtido** (o que aconteceu), **Erro** (descrição e captura de tela, sem dados pessoais), **Classificação** e **Situação**.

| Classificação | Quando usar |
|---|---|
| Crítica | Compromete segurança, dados ou funcionamento essencial (ex.: alguém vê o que não deveria; dado some) |
| Alta | Impede uma funcionalidade importante |
| Média | Compromete parte da experiência ou do fluxo |
| Baixa | Ajuste visual ou melhoria não impeditiva |

Situação: **Aprovado**, **Reprovado** ou **Pendente** (não foi possível testar; diga por quê).

Os casos marcados com 🔒 dependem de configuração externa ainda não feita (e-mail, chave de passageiros, pasta de anexos, Google Calendar). Registre-os como **Pendente – dependência externa** se a configuração não existir, sem classificá-los como erro do sistema.

## Casos de teste

### A. Acesso

| ID | Funcionalidade | Objetivo | Perfil | Passo a passo | Resultado esperado | Resultado obtido | Erro | Classificação | Situação |
|---|---|---|---|---|---|---|---|---|---|
| A1 | Login e saída | Entrar e sair com segurança | Qualquer | Entrar com e-mail e senha; usar o sistema; clicar em Sair; tentar voltar pelo navegador | Entra no painel; depois de sair, volta para o login e não acessa nada | | | | |
| A2 | Senha errada | Proteção contra tentativas | Qualquer | Errar a senha várias vezes seguidas | Mensagem genérica; após o limite, bloqueio temporário, mesmo com a senha certa | | | | |
| A3 | Cadastro | Pedir acesso | Pessoa nova (homologação) | Abrir "Criar conta", preencher com e-mail institucional de teste | Cadastro fica pendente, sem acesso até a aprovação | | | | |
| A4 | Aprovação | Aprovar com perfil correto | Administrador | Cadastros pendentes → aprovar o cadastro de A3 como Solicitante | Pessoa passa a entrar e vê só o que o perfil permite | | | | |
| A5 | Recuperação de senha 🔒 | Recuperar acesso por e-mail | Qualquer | "Esqueci a senha" → informar o e-mail → usar o código ou link recebido | Recebe o e-mail, troca a senha, código vale uma vez e por 10 minutos | | | | |
| A6 | Permissões da SLM | Conferir as concessões | Cada operador | Abrir Minha conta e os módulos | Cada um vê e faz exatamente o que foi concedido na tabela acima | | | | |
| A7 | Administrador fora da SLM | Administrador não opera pela SLM | Administrador (fora da equipe) | Tentar agendar uma solicitação e alterar a previsão de um pedido do Almoxarifado | Opção não aparece ou é recusada; a tentativa aparece na Auditoria como acesso negado | | | | |
| A8 | Acesso de outro setor | Solicitante só vê o que é seu | Solicitante | Tentar abrir, pelo endereço, uma solicitação de outra pessoa | Não encontrada (404) ou acesso negado; nada é exibido | | | | |
| A9 | Revisão de acessos | Lista de acessos sensíveis | Administrador | Usuários → Revisão de acessos | Mostra quem tem acesso sensível, sem expor senhas | | | | |

### B. Solicitações (regras comuns)

| ID | Funcionalidade | Objetivo | Perfil | Passo a passo | Resultado esperado | Resultado obtido | Erro | Classificação | Situação |
|---|---|---|---|---|---|---|---|---|---|
| B1 | Protocolo único | Identificação da solicitação | Solicitante | Abrir uma solicitação de Manutenção "HOMOLOG –" | Recebe protocolo `MAN-AAAA-…`; aparece em Minhas solicitações | | | | |
| B2 | Em nome de outro setor | Restrição | Operador com e sem a concessão | Abrir solicitação para outro setor | Só quem tem a concessão consegue; os demais não veem a opção | | | | |
| B3 | Duplicidade | Aviso antes de enviar | Solicitante | Repetir a mesma solicitação de B1 | Aviso de possível duplicidade; quem preenche decide | | | | |
| B4 | Linha do tempo | Histórico completo | Operador | Abrir B1 e fazer duas mudanças de status | Cada mudança aparece com autor, data, hora e motivo; nada pode ser apagado | | | | |
| B5 | Devolução | Pedir correção ao solicitante | Operador | Devolver B1 pedindo correção de um campo | Solicitante vê o pedido e corrige só o campo indicado; o protocolo não muda | | | | |
| B6 | Cancelamento | Motivo obrigatório | Operador | Cancelar uma solicitação de teste | Exige motivo padronizado; "Outros" exige texto; fica no histórico | | | | |
| B7 | Pesquisa global | Encontrar por protocolo e palavra | Operador e Solicitante | Pesquisar o protocolo de B1 e a palavra "HOMOLOG" | Operador encontra; Solicitante só encontra o que é seu | | | | |
| B8 | Notificações | Aviso dentro do sistema | Solicitante | Depois de B4, abrir o sino de notificações | Aparece a mudança, com link para a solicitação | | | | |
| B9 | Anexos 🔒 | Documentos na solicitação | Solicitante e Operador | Anexar um PDF; tentar anexar um arquivo renomeado (ex.: .exe como .pdf) | PDF aceito e baixável só por quem vê a solicitação; arquivo falso recusado | | | | |

### C. Manutenção

| ID | Funcionalidade | Objetivo | Perfil | Passo a passo | Resultado esperado | Resultado obtido | Erro | Classificação | Situação |
|---|---|---|---|---|---|---|---|---|---|
| C1 | Agendamento | Agendar conforme o pedido | Operador com agendar | Agendar B1 na data pedida | Status "Agendado"; aparece na Agenda | | | | |
| C2 | Agendar diferente do pedido | Justificativa | Operador com agendar | Agendar em outra data | Exige motivo; o histórico mostra pedido, agendado e motivo | | | | |
| C3 | Reagendamento | Mudança com motivo | Operador com agendar | Reagendar C1 | Exige motivo; status "Reagendado"; histórico preserva o anterior | | | | |
| C4 | Conflito de agenda | Evitar sobreposição | Operador com agendar | Agendar outra solicitação com o mesmo responsável no mesmo horário | Pede confirmação; a escolha fica registrada | | | | |
| C5 | Execução e conclusão | Registro da execução | Operador | Iniciar e concluir C1, informando equipamento (opcional) | "Em andamento" e "Concluído"; execução no histórico | | | | |
| C6 | Agendar sem concessão | Restrição | Operador sem agendar | Tentar agendar | Opção indisponível ou recusada | | | | |

### D. Frota

| ID | Funcionalidade | Objetivo | Perfil | Passo a passo | Resultado esperado | Resultado obtido | Erro | Classificação | Situação |
|---|---|---|---|---|---|---|---|---|---|
| D1 | Solicitação de veículo | Pedido com origem, destino e horário | Solicitante | Frota → Nova solicitação "HOMOLOG –" | Protocolo `FRO-…`; status "Aguardando agendamento" | | | | |
| D2 | Veículos | Cadastro e registros | Operador | Frota → Veículos: cadastrar veículo de teste e um registro de uso | Veículo listado; uso no histórico; alerta de revisão quando aplicável | | | | |
| D3 | Agendar e atribuir motorista | Fluxo completo | Operador com agendar | Agendar D1 e atribuir motorista | Agendado; motorista vê a viagem no portal | | | | |
| D4 | Portal do Motorista | Início, fim e ocorrência | Motorista (conta de homologação) | Iniciar a viagem, registrar ocorrência, finalizar | Reflete na Frota com horários reais; motorista não vê outros módulos | | | | |

### E. Passagens aéreas

| ID | Funcionalidade | Objetivo | Perfil | Passo a passo | Resultado esperado | Resultado obtido | Erro | Classificação | Situação |
|---|---|---|---|---|---|---|---|---|---|
| E1 | Solicitação com passageiro 🔒 | Pedido e proteção do CPF | Solicitante | Nova solicitação com CPF de teste `123.456.789-09` | Protocolo `PAS-…`; CPF aparece mascarado | | | | |
| E2 | CPF completo 🔒 | Restrição e auditoria | Operador com e sem a concessão de CPF | Abrir E1 e pedir o CPF completo | Só quem tem a concessão vê; a consulta fica na Auditoria | | | | |
| E3 | Cotações e emissão | Fluxo de Passagens | Operador | Registrar cotações, escolher uma com justificativa, emitir | "Em cotação" → "Aguardando aprovação" → "Em emissão" → "Emitida"; bilhete exigido | | | | |

### F. Almoxarifado

| ID | Funcionalidade | Objetivo | Perfil | Passo a passo | Resultado esperado | Resultado obtido | Erro | Classificação | Situação |
|---|---|---|---|---|---|---|---|---|---|
| F1 | Materiais e estoque | Cadastro e saldo | Operador com Almoxarifado | Cadastrar material "HOMOLOG – Papel"; dar entrada de saldo com justificativa | Material listado; saldo e histórico corretos | | | | |
| F2 | Pedido e atendimento parcial | Fluxo do pedido | Solicitante e Operador | Pedir material; atender parcialmente com motivo | Saldos físico, reservado e disponível separados; motivo registrado | | | | |
| F3 | Previsão de entrega | Data e justificativa | Operador com Almoxarifado | Informar previsão; depois alterar | Alteração exige justificativa; solicitante vê só a data; histórico interno preservado | | | | |
| F4 | Entrega | Previsão não é entrega | Operador com Almoxarifado | Registrar a entrega | Só o registro conclui; data efetiva visível ao solicitante | | | | |
| F5 | Inventário e controle interno | Conferência | Operador com Almoxarifado | Abrir conferência, informar contagem, fechar; registrar controle interno | Divergência exige justificativa; controle interno não cria pedido | | | | |

### G. Controle de Demandas

| ID | Funcionalidade | Objetivo | Perfil | Passo a passo | Resultado esperado | Resultado obtido | Erro | Classificação | Situação |
|---|---|---|---|---|---|---|---|---|---|
| G1 | Cadastro de demanda | Demanda com prazo e responsável | Integrante do setor | Nova demanda "HOMOLOG –" com colaborador | Número `DEM-…`; responsável notificado | | | | |
| G2 | Etapas e anexo por etapa 🔒 | Acompanhamento | Responsável | Criar etapa; anexar arquivo escolhendo a etapa | Anexo aparece com "Etapa: …"; progresso atualiza | | | | |
| G3 | Recorrência | Série mensal | Responsável | Criar demanda mensal | Próximas datas previstas na agenda; série gerenciável | | | | |
| G4 | Restrita | Sigilo | Responsável e pessoa de outro setor | Marcar como restrita; a outra pessoa pesquisa | Não aparece para quem não foi autorizado, em nenhuma tela | | | | |
| G5 | Relatórios | PDF e Excel | Diretoria ou gestor | Exportar relatório | Arquivos abrem com os dados corretos | | | | |

### H. Plataforma

| ID | Funcionalidade | Objetivo | Perfil | Passo a passo | Resultado esperado | Resultado obtido | Erro | Classificação | Situação |
|---|---|---|---|---|---|---|---|---|---|
| H1 | Configurações e cadastros auxiliares | Setores, andares, tipos de serviço | Administrador | Criar "Setor Homologação" e um tipo de serviço | Aparecem nos formulários; alteração registrada | | | | |
| H2 | Formulários | Rascunho e publicação | Quem tem a permissão | Tornar "Sala" obrigatória em rascunho; depois publicar | Rascunho não muda nada; publicado, a regra vale também pela API | | | | |
| H3 | Modelos de e-mail | Edição e prévia | Quem tem a permissão | Editar um modelo e ver a prévia | Prévia correta; publicação com versão | | | | |
| H4 | E-mails automáticos 🔒 | Comunicação ao solicitante | Operador | Agendar uma solicitação de teste | E-mail chega ao solicitante de teste com protocolo, pedido, agendado e motivo | | | | |
| H5 | Agenda interna | Calendário da SLM | Operador | Agenda: filtrar, abrir detalhes, reagendar | Mostra os agendamentos de Manutenção e Frota | | | | |
| H6 | Google Calendar 🔒 | Evento no calendário institucional | Operador | Agendar e depois cancelar | Evento criado e removido no calendário configurado | | | | |
| H7 | Central SLM | Filas e prazos | Operador com Central SLM | Abrir a Central | Filas, atrasos e alertas; sem a concessão, a Central não aparece | | | | |
| H8 | Auditoria | Registros de segurança | Administrador | Auditoria: filtrar por ação | Logins, aprovações, acessos negados, CPF e mudanças aparecem com usuário, data e hora | | | | |
| H9 | Relatórios e monitoramento | Indicadores | Quem tem a permissão | Abrir Relatórios e Monitoramento | Dados reais da homologação; nada inventado | | | | |
| H10 | Celular | Uso em tela pequena | Qualquer | Repetir A1, B1 e B8 no celular | Sem rolagem lateral; botões acessíveis | | | | |

## Encerramento

| Item | Resultado |
|---|---|
| Casos aprovados | |
| Reprovados críticos / altos / médios / baixos | |
| Pendentes por dependência externa | |
| Decisão da responsável | |
| Data e assinaturas | |

Um caso reprovado como crítico ou alto impede a publicação até ser corrigido e testado de novo.
