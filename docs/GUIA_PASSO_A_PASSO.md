# Guia passo a passo: do que falta até o sistema funcionar por completo

Escrito em 11/11/2026 para a responsável pelo projeto, sem linguagem técnica. Cada etapa diz
**quem faz**, **quanto tempo leva** e **o que muda**. Faremos uma etapa por vez: quando quiser
começar uma, me avise ("vamos fazer a etapa X") e eu acompanho cada clique.

**Regra de ouro:** senhas e chaves nunca são coladas na conversa comigo, em e-mail ou em chat.
Elas vão só nos painéis dos serviços e no cofre de senhas da TI.

## Onde estamos

O sistema está pronto e testado (todos os testes automáticos passam). A homologação já tem banco
próprio, separado do banco real, com 3 contas. O que falta agora é **colocar a homologação no ar**
para os operadores acessarem, **ligar os serviços externos** (e-mail e anexos) e
**obter algumas decisões da instituição**.

Pense assim:

| Peça | O que é | Situação |
|---|---|---|
| Banco de dados | Onde ficam os registros | Homologação pronta. Banco real intocado |
| Servidor (Render) | O "motor" do sistema | Configuração pronta, conta ainda não criada |
| Telas (Cloudflare) | O endereço que as pessoas abrem no navegador | Configuração pronta, conta ainda não criada |
| E-mail (Resend) | Quem envia os e-mails do sistema | Programado, desligado |
| Anexos (SharePoint) | Onde ficam os arquivos anexados | Programado, desligado, depende da TI |

## Etapa 1 — Guardar as melhorias de hoje no GitHub

- **Quem:** eu, com o seu "pode enviar".
- **Tempo:** 5 minutos.
- **O que muda:** nada no funcionamento. É só guardar o trabalho, como "salvar na nuvem".

## Etapa 2 — Colocar a homologação no ar

- **Quem:** você, comigo guiando. A TI só precisa saber que será feito.
- **Tempo:** cerca de 1 hora, numa sessão só.
- **Custo:** zero (planos gratuitos). Não cadastre cartão de crédito, assim nunca há cobrança.

Passos, que faremos juntas:

1. **Decidir com que e-mail criar as contas.** O ideal é um e-mail institucional da equipe (não
   pessoal), para a conta não depender de uma pessoa só. Pergunte à TI se existe um.
2. **Criar a conta no Render** (render.com) e importar o projeto do GitHub. Eu digo exatamente
   onde clicar e o que preencher.
3. **Gerar as chaves secretas.** Você abre o terminal do Codespace e roda um comando que eu
   passo. Ele mostra um código aleatório que você copia direto para o painel do Render. Eu não
   vejo esse código.
4. **Criar a conta no Cloudflare** (cloudflare.com) e ligar as telas ao mesmo projeto.
5. **Testar juntas:** você abre o endereço novo, entra com a conta de administradora e confere.

Ao final, existe um endereço do tipo `https://slm-homologacao.pages.dev`, que os operadores
abrem de qualquer computador.

## Etapa 3 — Manter o sistema "acordado" no expediente

- **Quem:** você, comigo guiando.
- **Tempo:** 5 minutos, depois da Etapa 2 e do envio à branch principal.
- **Por quê:** no plano gratuito, o servidor "dorme" depois de 15 minutos sem uso. Dormindo, ele
  não envia e-mails nem lembretes, e o primeiro acesso demora cerca de 1 minuto. Já deixei pronto
  um "despertador" que o acorda a cada 10 minutos, de segunda a sexta, das 7h às 19h.
- **O que fazer:** no GitHub, cadastrar o endereço do servidor numa configuração chamada
  `SLM_API_HEALTH_URL`. Eu mostro onde fica.

## Etapa 4 — Cadastrar os operadores

- **Quem:** cada operador se cadastra, e você aprova pela tela.
- **Tempo:** 15 minutos.
- **Como:** está em `docs/PLANO_HOMOLOGACAO.md`, seção C. Resumo: cada operador clica em "Criar
  conta"; você vai em Administração → Cadastros pendentes e aprova como "Operador SLM". Agendar
  e Almoxarifado já vêm junto. Um dos operadores deve ficar **sem** agendar, para os testes
  negativos (o passo a passo está no plano).

## Etapa 5 — Ligar os e-mails

- **Quem:** você cria a conta no Resend; **a TI** precisa incluir 3 registros no domínio
  (é o que prova ao mundo que os e-mails do sistema são legítimos e não vão para o spam).
- **Tempo:** 30 minutos seus e o prazo da TI.
- **Ordem segura, já programada:** primeiro só a recuperação de senha, e só para os e-mails da
  lista de teste. Depois os demais avisos. Por último, a liberação para todos.
- **Mensagem pronta para a TI:**

  > Precisamos verificar um domínio (ou subdomínio, como `slm.jucesp.sp.gov.br`) no serviço de
  > e-mail Resend, para o Sistema de Logística enviar e-mails automáticos. O Resend vai indicar
  > registros DNS (SPF, DKIM e, se desejado, DMARC) para incluir no domínio. Podem nos dizer qual
  > domínio usar e quem pode incluir os registros?

## Etapa 6 — Executar o roteiro de testes com os operadores

- **Quem:** os 4 operadores, com você acompanhando.
- **Tempo:** alguns dias, no ritmo da equipe.
- **Como:** `docs/ROTEIRO_HOMOLOGACAO_SLM.md` tem 51 casos. Cada pessoa marca "OK" ou anota o
  problema. O que der errado, você me traz e eu corrijo.

## Etapa 7 — Passagens aéreas (CPF dos passageiros)

- **Quem:** você gera a chave (como na Etapa 2) e **a TI guarda uma cópia no cofre**.
- **Por quê é sério:** essa chave protege os CPFs. **Se ela se perder, os CPFs gravados não podem
  mais ser lidos.** Por isso a cópia no cofre é obrigatória antes de cadastrar passageiros.

## Etapa 8 — Anexos de arquivos

**Caminho rápido (você, cerca de 10 minutos): Supabase Storage.** Crie um bucket **privado**
chamado `slm-anexos` no projeto do Supabase e coloque no Render `ATTACHMENTS_STORAGE=supabase`,
`SUPABASE_URL` e `SUPABASE_SECRET_KEY`. O passo a passo, com o que conferir no fim, está em
`docs/ARMAZENAMENTO_SUPABASE.md`. O plano gratuito não faz backup dos arquivos: faça a cópia
semanal descrita no mesmo guia.

**Caminho institucional (TI): SharePoint.** Pode substituir o Supabase depois.

- **Quem:** **a TI** (exige acesso de administrador ao Microsoft 365 da instituição).
- **Mensagem pronta para a TI:**

  > O Sistema de Logística precisa gravar anexos numa biblioteca do SharePoint. Pedimos: (1) o
  > registro de um aplicativo no Entra ID com a permissão `Sites.Selected`, com escrita
  > concedida só ao site escolhido; (2) o identificador do drive (biblioteca); (3) um
  > certificado para o aplicativo; (4) a política de backup ou retenção dessa biblioteca. Os
  > detalhes técnicos estão em `docs/ARMAZENAMENTO_SHAREPOINT.md`.

  Até lá, o sistema funciona normalmente, só sem anexar arquivos.

## Etapa 9 — Decisões da instituição

Não são técnicas. São regras de trabalho que só a JUCESP pode definir. Para cada uma, o sistema já
funciona de um jeito seguro enquanto não houver resposta.

| Pergunta | Hoje |
|---|---|
| O solicitante pode cancelar o próprio pedido antes do agendamento? | Já é possível por pessoa (permissão "Cancelar as próprias solicitações antes do atendimento"). Se a resposta for "todos podem", eu incluo no perfil |
| Depois de quantos dias um pedido parado gera lembrete? | Sem lembrete. Decidido o prazo, você mesma preenche em **Configurações → Notificações por perfil → "Avisar a equipe sobre solicitações paradas há (dias)"**, sem programação |
| O sistema passa a controlar o saldo oficial do Almoxarifado? E se o saldo não cobrir a entrega: bloqueia ou deixa entregar? | A entrega não altera o saldo |
| Pessoas do mesmo setor devem ver os pedidos umas das outras? Inclusive de Passagens, que têm dados de passageiros? | Cada pessoa vê só os seus |
| Quais domínios de e-mail podem se cadastrar? | Qualquer domínio pede cadastro, sempre com aprovação |
| Por quanto tempo guardar os dados e registros (LGPD)? | Nada é apagado |
| Os anexos precisam passar por antivírus? | Sem antivírus |
| Qual é a jornada oficial dos motoristas (dias, horário, intervalo)? | A planilha da Frota calcula horas extras e a menos pela jornada que estiver em **Configurações → Configurações do Portal do Motorista → Jornada de trabalho**. Confira se ela está igual à oficial |
| ~~Os motoristas devem bater ponto no portal?~~ | **Decidido em 12/11/2026: não.** As horas da planilha continuam sendo uma estimativa feita a partir das viagens |

## Etapa 10 — Produção (o sistema "de verdade")

- **Quando:** só depois de a homologação terminar bem.
- **O que envolve:** atualizar o banco real (com cópia de segurança antes, num procedimento em
  duas etapas já pronto e ensaiado), criar os serviços de produção e trocar o endereço.
- **Quem:** você roda os comandos que eu preparo. Eu não tenho permissão para alterar o banco
  real, e isso é proposital.

## Se algo der errado

Nada do que fizermos nas etapas 2 a 6 toca o banco real. Se a homologação apresentar problema,
basta me contar o que apareceu na tela (um print ajuda) e o horário.
