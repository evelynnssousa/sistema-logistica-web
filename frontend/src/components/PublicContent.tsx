import type { PublicHome } from '../api/configApi'
import Icon from './ui/Icon'
import type { IconName } from './ui/Icon'

/**
 * Partes da página inicial pública que também aparecem na Ajuda, para quem já entrou: perguntas
 * frequentes, novidades, equipe e contato. Tudo vem de Configurações → Página inicial, como texto.
 */

const formatDay = (value: string) => value.split('-').reverse().join('/')

function initials(name: string) {
  const parts = name.trim().split(/\s+/)
  return `${parts[0]?.[0] ?? ''}${parts.length > 1 ? parts[parts.length - 1][0] : ''}`.toUpperCase()
}

export function FaqList({ items }: { items: PublicHome['page']['faq'] }) {
  if (items.length === 0) return null
  return (
    <div className="public-faq">
      {items.map((item) => (
        <details key={item.question}>
          <summary>{item.question}</summary>
          <p>{item.answer}</p>
        </details>
      ))}
    </div>
  )
}

export function NewsList({ items }: { items: PublicHome['page']['news'] }) {
  if (items.length === 0) return null
  return (
    <ul className="public-news">
      {items.slice(0, 6).map((item) => (
        <li key={`${item.date}-${item.title}`}>
          <time dateTime={item.date}>{formatDay(item.date)}</time>
          <strong>{item.title}</strong>
          {item.text && <p>{item.text}</p>}
        </li>
      ))}
    </ul>
  )
}

export function TeamList({ members }: { members: PublicHome['page']['team'] }) {
  if (members.length === 0) return null
  return (
    <ul className="public-team">
      {members.map((member) => (
        <li key={`${member.name}-${member.role}`}>
          {member.photoUrl ? (
            <img src={member.photoUrl} alt="" loading="lazy" width={96} height={96} />
          ) : (
            <span className="public-team-initials" aria-hidden="true">
              {initials(member.name)}
            </span>
          )}
          <strong>{member.name}</strong>
          {member.role && <span>{member.role}</span>}
        </li>
      ))}
    </ul>
  )
}

export function ContactBlock({ page }: { page: PublicHome['page'] }) {
  if (!page.contactEmail && !page.serviceHours && !page.location) return null
  const rows: { icon: IconName; label: string; value: React.ReactNode }[] = []
  if (page.contactEmail) {
    rows.push({ icon: 'mail', label: 'E-mail', value: <a href={`mailto:${page.contactEmail}`}>{page.contactEmail}</a> })
  }
  if (page.serviceHours) rows.push({ icon: 'calendar', label: 'Atendimento', value: page.serviceHours })
  if (page.location) rows.push({ icon: 'overview', label: 'Onde estamos', value: page.location })
  return (
    <dl className="public-contact">
      {rows.map((row) => (
        <div key={row.label}>
          <dt>
            <Icon name={row.icon} size={20} /> {row.label}
          </dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </dl>
  )
}
