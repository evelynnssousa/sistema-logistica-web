import { useState } from 'react'
import type { InputHTMLAttributes } from 'react'
import Icon from './ui/Icon'

/**
 * Campo de senha com o botão de olho para mostrar ou esconder o que foi digitado. A senha volta a
 * ficar escondida ao enviar o formulário, para não ficar exposta na tela seguinte.
 */
function PasswordField(props: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const [visible, setVisible] = useState(false)
  return (
    <div className="password-field">
      <input {...props} type={visible ? 'text' : 'password'} />
      <button
        type="button"
        className="password-toggle"
        aria-label={visible ? 'Esconder a senha' : 'Mostrar a senha'}
        aria-pressed={visible}
        aria-controls={props.id}
        title={visible ? 'Esconder a senha' : 'Mostrar a senha'}
        disabled={props.disabled}
        onClick={() => setVisible((current) => !current)}
      >
        <Icon name={visible ? 'hide' : 'view'} size={20} weight="regular" />
      </button>
    </div>
  )
}

export default PasswordField
