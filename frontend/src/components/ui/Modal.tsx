import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import Icon from './Icon'

type ModalProps = {
  title: string
  children: ReactNode
  actions?: ReactNode
  onClose: () => void
}

/** Usa o <dialog> nativo: prende o foco, fecha com Esc e devolve o foco ao botão de origem. */
function Modal({ title, children, actions, onClose }: ModalProps) {
  const dialog = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const element = dialog.current
    if (element && !element.open) element.showModal()
    return () => element?.close()
  }, [])

  return (
    <dialog
      ref={dialog}
      className="ui-modal"
      aria-labelledby="ui-modal-title"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <header>
        <h2 id="ui-modal-title">{title}</h2>
        <button type="button" className="ui-modal-close" aria-label="Fechar" onClick={onClose}>
          <Icon name="close" size={18} weight="bold" />
        </button>
      </header>
      <div className="ui-modal-body">{children}</div>
      {actions && <footer>{actions}</footer>}
    </dialog>
  )
}

export default Modal
