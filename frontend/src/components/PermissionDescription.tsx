import { permissionKindLabels } from '../auth/usersApi'
import type { PermissionEntry } from '../auth/usersApi'

/** Nome, natureza, explicação e restrições de uma permissão, como o servidor as descreve. */
function PermissionDescription({ permission }: { permission: PermissionEntry }) {
  return (
    <span className="permission-description">
      <span className="permission-description-title">
        <strong>{permission.label}</strong>
        <span className={`permission-kind permission-kind-${permission.kind}`}>
          {permissionKindLabels[permission.kind] ?? permission.kind}
        </span>
      </span>
      <span className="permission-description-text">{permission.description}</span>
      {permission.note && <span className="permission-description-note">{permission.note}</span>}
    </span>
  )
}

/** Aviso comum às telas de acesso: a permissão não dispensa as demais regras do servidor. */
export function PermissionScopeNotice() {
  return (
    <p className="permission-scope-notice" role="note">
      Conceder uma permissão não elimina as demais regras verificadas pelo servidor: setor, equipe SLM, vínculos
      institucionais, propriedade do registro e autorizações específicas continuam valendo em cada operação.
    </p>
  )
}

export default PermissionDescription
