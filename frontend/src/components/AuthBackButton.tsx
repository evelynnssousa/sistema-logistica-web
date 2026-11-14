import Icon from './ui/Icon'

/** "Voltar" no topo das telas de acesso: login e cadastro voltam à página inicial; recuperação, ao login. */
function AuthBackButton({ onClick, disabled, label }: { onClick: () => void; disabled?: boolean; label: string }) {
  return (
    <button type="button" className="auth-back-button" onClick={onClick} disabled={disabled} aria-label={label}>
      <Icon name="back" size={18} />
      Voltar
    </button>
  )
}

export default AuthBackButton
