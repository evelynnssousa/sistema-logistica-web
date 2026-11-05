import type { ReactNode } from 'react'

type PageHeaderProps = {
  title: string
  description?: ReactNode
  // Contexto específico do registro aberto. O nome do sistema nunca é repetido aqui.
  eyebrow?: string
  actions?: ReactNode
}

function PageHeader({ title, description, eyebrow, actions }: PageHeaderProps) {
  return (
    <section className="ui-page-header">
      <div className="ui-page-header-text">
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="ui-page-header-actions">{actions}</div>}
    </section>
  )
}

export default PageHeader
