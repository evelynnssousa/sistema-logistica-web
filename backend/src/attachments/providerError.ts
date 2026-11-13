/**
 * Erro de um serviço externo de armazenamento (SharePoint, Supabase Storage). A mensagem e o
 * código nunca carregam segredo nem URL. Os códigos ENOENT, EEXIST e ENOSPC têm o mesmo sentido
 * do disco local, para as rotas tratarem todos os armazenamentos do mesmo jeito.
 */
export class StorageProviderError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly status: number | null,
    message: string,
  ) {
    super(message)
    this.name = 'StorageProviderError'
  }
}
