import { useEffect, useState } from 'react'
import { errorMessage } from '../api/modulesApi'
import { getPublicHome } from '../api/configApi'
import type { PublicHome } from '../api/configApi'
import { ContactBlock, FaqList, ManualList, NewsList, TeamList } from '../components/PublicContent'
import { Alert, EmptyState, Loading } from '../components/ui/Feedback'
import PageHeader from '../components/ui/PageHeader'

/** Ajuda dentro do sistema: as mesmas perguntas, novidades, equipe e contato da página inicial. */
function HelpPage() {
  const [home, setHome] = useState<PublicHome | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    getPublicHome()
      .then((result) => {
        if (active) setHome(result)
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err, 'Não foi possível carregar a ajuda.'))
      })
    return () => {
      active = false
    }
  }, [])

  if (error) return <Alert tone="error">{error}</Alert>
  if (!home) return <Loading label="Carregando a ajuda..." />
  const { page } = home
  const manuals = page.manuals ?? []
  const empty = manuals.length === 0 && page.faq.length === 0 && page.news.length === 0 && page.team.length === 0 && !page.contactEmail

  return (
    <div className="admin-module-page help-page">
      <PageHeader title="Ajuda" description="Manuais, perguntas frequentes, novidades do sistema e como falar com a SLM." />
      {empty && <EmptyState title="Ainda não há conteúdo de ajuda">A equipe da SLM publica as perguntas e o contato em Configurações.</EmptyState>}
      {manuals.length > 0 && (
        <section className="ui-card ui-stacked">
          <h2>Manuais</h2>
          <ManualList items={manuals} />
        </section>
      )}
      {page.news.length > 0 && (
        <section className="ui-card ui-stacked">
          <h2>Novidades</h2>
          <NewsList items={page.news} />
        </section>
      )}
      {page.faq.length > 0 && (
        <section className="ui-card ui-stacked">
          <h2>Perguntas frequentes</h2>
          <FaqList items={page.faq} />
        </section>
      )}
      {(page.contactEmail || page.serviceHours || page.location) && (
        <section className="ui-card ui-stacked">
          <h2>Fale com a SLM</h2>
          <ContactBlock page={page} />
        </section>
      )}
      {page.team.length > 0 && (
        <section className="ui-card ui-stacked">
          <h2>Equipe da SLM</h2>
          <TeamList members={page.team} />
        </section>
      )}
    </div>
  )
}

export default HelpPage
