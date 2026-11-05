# Auditoria: queda de sessão após o login

Sintoma relatado: o login é aceito, o sistema abre e, em seguida, volta à tela de login pedindo as credenciais.

## Causa comprovada no ambiente real

Registro temporário, sem dados sensíveis, durante uma queda real em 04/11/2026:

```
16:57:07 GET /auth/me                200  1 cookie
16:57:08 GET /dashboard/summary      401  2 cookies com o MESMO token; a resposta manda limpar o cookie
16:57:08 GET /auth/me                401  0 cookies; a tela volta ao login
```

Um pedido chegou à API com o cookie `slm_session` repetido, com o mesmo valor. `readSessionToken` recusava qualquer repetição, e a resposta 401 mandava o navegador apagar a sessão, que estava válida. O mesmo ocorreu na queda seguinte, às 16:57:12.

**Correção:** o mesmo valor repetido passa a valer como uma só sessão. Valores diferentes continuam recusados.

**Confirmação:** às 17:14, com a correção, um pedido chegou com o cookie repetido dentro de um único cabeçalho e foi aceito. A pessoa usuária passou por 8 telas sem nenhum 401 e sem novo login. O registro temporário foi removido em seguida.

**Ainda em aberto:** quem repete o cookie. Por vir em um só cabeçalho, a repetição ocorre antes da API, no navegador ou no encaminhamento. A correção não depende dessa resposta.

## Primeira investigação

As falhas abaixo também são reais e foram corrigidas, mas não eram a causa da queda relatada.

## Evidências

Leitura do banco real em 04/11/2026, em transação somente leitura, sem colunas pessoais e sem tocar em senhas, tokens ou cookies:

| Verificação | Resultado |
|---|---|
| Tabelas de usuários e sessões | Só `public.auth_users` e `public.auth_sessions`. O esquema `app_private` não existe, e o código não o cita |
| Criação e validação da sessão | Mesma tabela e mesma coluna (`session_token_hash`) |
| Gatilhos nessas tabelas | Nenhum |
| Sessões | 97 registradas, com validade de 8 h. Só 2 foram usadas mais de 5 minutos depois de criadas |
| Encerramentos pelo servidor em 48 h | 1 logout manual. Nenhum por expiração ou inatividade |
| Logins em 48 h | 98 com sucesso, da mesma conta. No último dia, 40 deles com intervalo de 1,3 a 1,9 s |

Conclusão dessas evidências: **o servidor não está encerrando as sessões**. Elas continuam válidas no banco, e o navegador deixa de usá-las. O intervalo de 1,3 a 1,9 s equivale à duração de um login e não permite redigitar a senha, o que indica reenvio automático do formulário, como o de um gerenciador de senhas. A origem desse reenvio não foi identificada: a API não registra o cliente.

## Reprodução

Em `e2e/session-persistence.e2e.cjs`, com banco descartável e portas próprias:

| Situação | Resultado antes da correção |
|---|---|
| Aba própria | Login, `/auth/me` 200, permanece no sistema |
| Resposta atrasada de `/auth/me`, pedida antes do login | **Entra, é expulso e o cookie novo é apagado** |
| Página embutida em outro site | Login 200, `/auth/me` 401, volta ao login sem nenhuma mensagem. O navegador recusa o cookie `SameSite=Strict` |
| Dois cookies `slm_session` com valores diferentes | Login 200, `/auth/me` 401. A API recusa por segurança, e continua recusando |
| Cookie antigo no mesmo caminho | Substituído, funciona |

## Causas

**Comprovadas por reprodução, no código:**

1. `middleware/requireAuthentication.ts` enviava `Set-Cookie` de limpeza em todo 401, mesmo quando a requisição não trazia cookie. Uma resposta atrasada, pedida antes do login, apagava o cookie recém-gravado.
2. `auth/AuthGate.tsx` consultava `/auth/me` ao receber foco mesmo na tela de login, e aplicava respostas antigas sem conferir a ordem. É isso que gera a requisição atrasada, e também faz uma resposta anterior ao login ou ao logout valer depois dele.
3. `auth/AuthGate.tsx` e `pages/LoginPage.tsx` não diziam nada quando o login era aceito e a sessão não se confirmava. A pessoa só via a tela de login de novo, e um preenchimento automático podia reenviar o formulário sem fim.


## Correção

Nenhuma regra de segurança foi afrouxada: `SameSite=Strict`, `HttpOnly`, a validade de 8 h, a inatividade de 2 h, a recusa de cookies com valores diferentes, a proteção das rotas e a aprovação de cadastros continuam iguais.

- A API só limpa o cookie quando a requisição trouxe um cookie de sessão.
- A tela só consulta `/auth/me` em segundo plano com a pessoa autenticada e ignora respostas de consultas anteriores ao último login ou logout.
- Login aceito sem sessão confirmada mostra o motivo e o que fazer, inclusive quando a página está embutida.
- Sessão encerrada durante o uso mostra um aviso na tela de login.

O sistema embutido em outro site continua sem funcionar, de propósito: aceitá-lo exigiria `SameSite=None`, o que enfraquece a proteção. Agora a tela explica como abrir em uma aba própria.

## Como confirmar no navegador

1. Abra o sistema em uma **aba própria do navegador**, fora da pré-visualização do editor.
2. Nas ferramentas do desenvolvedor, em Aplicativo → Cookies, confira se há um único `slm_session`. Se houver mais de um, apague-os e entre de novo.
3. Se os logins em sequência continuarem, desative o envio automático do gerenciador de senhas para este endereço.

## Outros pontos observados, sem alteração

- As sessões antigas se acumulam fora de produção, porque a limpeza automática só roda nela. Sessão vencida não dá acesso. As 97 linhas não foram apagadas.
- Cada login cria uma sessão nova sem encerrar as anteriores da conta, por isso as 84 ainda válidas no momento da leitura seguem utilizáveis até vencer, por quem tiver o cookie. Encerrá-las é possível em Minha conta.
- O banco real não tem as tabelas das migrações 003, 005, 006, 007 e 011, as que foram conferidas, então os módulos operacionais respondem 503. Isso não afeta o login, e foi testado com a estrutura atual do banco real.
