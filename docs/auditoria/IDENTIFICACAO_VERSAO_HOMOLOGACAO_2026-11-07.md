# Identificação da versão da API de homologação — 07/11/2026

Primeiro registro formal da versão de código executada pela API de homologação do Sistema SLM. **Não foi localizada nenhuma identificação anterior**: em 07/11/2026 foram consultados o roteiro e o plano de homologação, os demais documentos de `docs/` e `docs/auditoria/` e os scripts de `scripts/`, e nenhum continha registro ou procedimento de identificação de versão. Este documento é, portanto, o ponto de partida para comparações futuras.

## Registro

| Item | Valor |
|---|---|
| Data | 07/11/2026 |
| Branch | `integracao/cadastro-e-permissoes` |
| Commit-base | `efb75488f5588f6ecaf73bad0f85c00934822583` |
| Identificação A (commit) | `134fd6704fa7f4a58d12989c4776c71386fb87b273a681a9a4610af88cc33d79` (206 arquivos) |
| Identificação B (código em execução) | `e80467f47a085b89864fde3ee884f1555dc1eaa1c33ad24697439f726c7c0c8b` (217 arquivos) |
| Identificação C (alterações sem commit) | `d759f7106066b0edba66ea5a04d8838967ca54c3b14ebce34146bdac0c6a16bf` (24 arquivos modificados, 11 novos, nenhum removido) |
| API | Porta 3100, iniciada às 01:45:59 com `npm run homolog -- -- npm run dev:backend` (`tsx watch backend/src/server.ts`) |
| Health check | `GET /api/health` → HTTP 200 |
| Banco | Exclusivamente o de homologação (projeto `rrqulhpnghoetgrdswqr`), conforme a saída de `scripts/homologacao.cjs`; o banco de produção não foi acessado |

A API executa os arquivos diretamente da pasta de trabalho (o `tsx` não usa `dist/`). Por isso a identificação que corresponde ao que está em execução é a **B**, e não a A: o código rodando inclui as alterações ainda sem commit.

## Diferença entre A, B e C

- **A — commit.** Calculada sobre o conteúdo dos arquivos como está gravado no commit-base, lido dos objetos do Git. Não depende da pasta de trabalho: qualquer pessoa com o commit `efb7548` obtém o mesmo valor.
- **B — código em execução.** Calculada sobre os arquivos como estão na pasta de trabalho: os rastreados (com as alterações locais) mais os novos ainda não rastreados e não ignorados pelo `.gitignore`. É a versão que a API carregou.
- **C — só as alterações sem commit.** Calculada sobre as linhas que diferem entre as listas de A e B: o hash antigo de cada arquivo alterado (marcado `HEAD`) e o novo (marcado `WT`). Identifica o conjunto de alterações locais independentemente do restante do código.

Se não houver alterações locais, A e B são iguais e C é o SHA-256 de uma lista vazia (`e3b0c442…b855`).

## Método de cálculo

1. Para cada arquivo do escopo, calcula-se o SHA-256 do conteúdo exato, em bytes.
2. Monta-se uma lista com uma linha por arquivo, no formato do `sha256sum`: `<sha256>␠␠<caminho>` seguido de quebra de linha.
3. As linhas são ordenadas pelo caminho, em ordem de bytes (equivalente a `LC_ALL=C sort`), o que torna o resultado independente de idioma, sistema e ordem de leitura.
4. A identificação é o SHA-256 dessa lista.

Para C, a lista contém as linhas exclusivas de A (prefixo `HEAD `) e as exclusivas de B (prefixo `WT   `), ordenadas pelo caminho e, no mesmo caminho, `HEAD` antes de `WT`.

### Caminhos incluídos

O código que a API carrega e o que determina como ela é executada:

- `backend/src/` (inclusive os arquivos de teste, que ficam junto do código)
- `backend/database/` (estrutura e reversões do banco)
- `backend/testing/`
- `backend/tsconfig.json`
- `package.json` e `package-lock.json` (versões das dependências)
- `scripts/homologacao.cjs` (o wrapper que inicia a API de homologação)

### Caminhos excluídos

- `.env*` em qualquer pasta: segredos e configuração local. Nem o conteúdo nem os valores são lidos.
- `node_modules/`: dependências instaladas (já representadas pelo `package-lock.json`).
- `dist/`: arquivos gerados, não usados pela API de homologação.
- `backups/`: cópias de banco.
- Arquivos ignorados pelo `.gitignore` e tudo fora da lista de incluídos — em particular o frontend, a documentação, `backend/certificates/` e os demais scripts, inclusive o próprio `scripts/identificacao-versao.cjs`. Por isso criar ou alterar este documento e o script não muda nenhuma das identificações.

## Como reproduzir

```bash
node scripts/identificacao-versao.cjs
node scripts/identificacao-versao.cjs --esperado-b=e80467f47a085b89864fde3ee884f1555dc1eaa1c33ad24697439f726c7c0c8b
node scripts/identificacao-versao.cjs --lista=atual        # ou commit, alteracoes
```

O script só lê: não grava arquivos, não acessa banco e não lê variáveis de ambiente. Com `--esperado-b`, sai com código 1 se B divergir. Em caso de divergência, **não substitua este registro**: compare a lista de `--lista=atual` com a de uma pasta na versão registrada e identifique os arquivos que mudaram.

**Validação em 07/11/2026:** o script reproduziu A, B e C exatamente, e as três listas são idênticas, byte a byte, às do cálculo original (feito com `sha256sum` e `LC_ALL=C sort`).

## Cuidados

- A API roda com `tsx watch`, que recarrega sozinho quando um arquivo do backend muda. Qualquer edição no escopo durante a homologação muda o código em execução e a identificação B deixa de valer; nesse caso, recalcule e registre uma nova identificação, sem apagar esta.
- Alterar a lista de caminhos ou o método muda todas as identificações. Se for necessário, registre um novo procedimento em outro documento, com a data, mantendo este como histórico.
- Quando as alterações locais forem gravadas em commit, A passa a ser calculada sobre o novo commit. Se o conteúdo for o mesmo, o novo A deve ser igual a este B.
