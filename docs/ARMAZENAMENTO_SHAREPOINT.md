# Anexos no SharePoint institucional

Situação em 2026-11-07: **implementado e testado só com o Microsoft Graph simulado.** Nenhuma
conta Microsoft foi conectada. O padrão continua sendo o disco local (`ATTACHMENTS_STORAGE=local`).

## Como funciona

- `backend/src/attachments/graphDriveStorage.ts` implementa `AttachmentStorage` sobre uma
  biblioteca de documentos, pelo Microsoft Graph v1.0. Rotas, permissões, histórico e auditoria
  não mudam: o armazenamento só é chamado depois de o backend conferir o acesso.
- Caminho na biblioteca: `<SHAREPOINT_ROOT_FOLDER>/<2 primeiros caracteres>/<chave UUID>`. O
  nome original, o SHA-256, o tamanho e os vínculos continuam só no banco.
- **Envio:** sempre por `createUploadSession`, em partes múltiplas de 320 KiB (5 MiB por padrão,
  máximo de 60 MiB), com `conflictBehavior: fail`. Um arquivo existente nunca é substituído. Se
  o envio é interrompido, a sessão é cancelada. Se o Graph informa um tamanho diferente do que
  foi enviado, o arquivo é retirado e o envio é recusado.
- **Download:** só pelo backend. A URL temporária do SharePoint é seguida no servidor, sem o
  token, e nunca chega ao navegador. Tamanho e SHA-256 são conferidos durante a transmissão: o
  último trecho só sai depois da conferência, e um conteúdo divergente resulta em 503.
- **Remoção física:** só para desfazer um envio cujo registro o banco recusou, como no disco
  local. A remoção pela tela continua lógica: o arquivo permanece no SharePoint.
- **Nada de compartilhamento:** nenhuma chamada a `createLink`, `invite` ou permissões.
- **Autenticação:** credenciais de aplicativo (client credentials), com segredo ou certificado.
  O token fica só na memória, é renovado cinco minutos antes do vencimento e, depois de um 401,
  uma única vez. Token, segredo e URLs temporárias não aparecem em erros nem em registros.
- **Limites do serviço:** 429, 500, 502, 503 e 504 são repetidos até 4 vezes, respeitando
  `Retry-After` (segundos ou data). Esperas acima de 30 s não são aguardadas: o pedido falha
  com 503 e pode ser repetido. Cada chamada tem limite de 30 s; a leitura é interrompida após
  30 s sem dados.

## Variáveis de ambiente

| Variável | Uso |
| --- | --- |
| `ATTACHMENTS_STORAGE` | `local` (padrão) ou `sharepoint`. Valor desconhecido desliga os anexos. |
| `GRAPH_TENANT_ID` | ID (GUID) ou domínio do locatário Microsoft 365. |
| `GRAPH_CLIENT_ID` | ID do aplicativo registrado no Entra ID. |
| `GRAPH_CLIENT_SECRET` | Segredo do aplicativo. **Ou** o par abaixo, nunca os dois. |
| `GRAPH_CERTIFICATE_PRIVATE_KEY` | Chave privada PEM do certificado (preferido em produção). |
| `GRAPH_CERTIFICATE_THUMBPRINT` | Impressão digital SHA-1 do certificado, 40 hexadecimais. |
| `SHAREPOINT_DRIVE_ID` | ID da biblioteca de documentos (`b!...`). |
| `SHAREPOINT_ROOT_FOLDER` | Pasta dentro da biblioteca. Padrão: `SLM-Anexos`. |

Com `ATTACHMENTS_STORAGE=sharepoint` e configuração incompleta, os anexos ficam indisponíveis
(503). Não há volta automática para o disco local. `npm run config:check` aponta o que falta,
sem mostrar valores.

## O que depende da TI e de autorização institucional

1. Registrar o aplicativo do SLM no Entra ID do locatário institucional.
2. Conceder a permissão de aplicativo **`Sites.Selected`** (consentimento de administrador) e,
   em seguida, conceder ao aplicativo acesso de **escrita** (`write`) **apenas** ao site da
   biblioteca. Essa concessão é feita pela TI. O SLM não pede `Sites.ReadWrite.All`.
3. Criar o site ou a biblioteca e informar o `SHAREPOINT_DRIVE_ID`.
4. Emitir o certificado, ou o segredo, e guardá-lo fora do repositório, com o prazo de
   validade acompanhado.
5. Definir a retenção, a lixeira e as cópias da biblioteca. `npm run backup:attachments` cobre
   só o disco local.
6. Fazer a homologação com a conta real: envio, download, falha de rede e verificação de saúde.

## Testes

- `backend/src/attachments/graphDriveStorage.test.ts` (em `npm run test:backend`): envio,
  arquivo existente, download, autenticação, token vencido, 429, 503, limite de tempo,
  integridade, falha no envio, reversão, configuração e o armazenamento local.
- `backend/src/database/graphStorageIntegration.test.ts` (em `npm run test:integration`): a
  API real com o Graph simulado. Cobre a permissão conferida antes de qualquer chamada, o
  download sem vazamento de endereço ou token, o 503, o SHA-256 divergente e a remoção lógica.
- `fakeGraph.testSupport.ts` simula o Graph em memória. Nenhuma conexão sai da máquina.
