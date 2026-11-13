import { useState } from 'react'
import { uploadTeamPhoto } from '../api/configApi'
import { errorMessage } from '../api/modulesApi'
import { saveParameters } from '../api/operationsApi'
import type { SystemSettings } from '../api/operationsApi'
import { Card } from './AdminSettingsSection'
import { Alert } from './ui/Feedback'

/**
 * Configurações → Página inicial: textos sobre a JUCESP e a SLM, contato, perguntas frequentes,
 * equipe (com foto) e novidades. A página é pública: só o que pode ser visto por qualquer pessoa.
 */

type PageValue = NonNullable<SystemSettings['publicPage']>
type Member = PageValue['team'][number] & { photoUrl?: string | null }

/** Reduz a foto para no máximo 400x400 em JPEG, no navegador, antes de enviar. */
async function shrinkPhoto(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, 400 / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Não foi possível ler a foto.'))), 'image/jpeg', 0.85),
  )
}

const emptyPage: PageValue = {
  heroTitle: '', heroText: '', aboutOrgan: '', aboutSlm: '', serviceHours: '', location: '', contactEmail: '',
  faq: [], team: [], news: [],
}

function move<T>(list: readonly T[], index: number, offset: number) {
  const next = [...list]
  const target = index + offset
  if (target < 0 || target >= next.length) return next
  ;[next[index], next[target]] = [next[target], next[index]]
  return next
}

export function PublicPageCard({ value, canManage }: { value: PageValue | undefined; canManage: boolean }) {
  const [form, setForm] = useState<PageValue>(value ?? emptyPage)
  const [team, setTeam] = useState<Member[]>(
    (value?.team ?? []).map((member) => ({ ...member, photoUrl: member.photoId ? `/api/public/team-photos/${member.photoId}` : null })),
  )
  const [photoError, setPhotoError] = useState('')
  const [uploading, setUploading] = useState<number | null>(null)
  const text = (key: 'heroTitle' | 'heroText' | 'aboutOrgan' | 'aboutSlm' | 'serviceHours' | 'location' | 'contactEmail') =>
    (event: { target: { value: string } }) => setForm((current) => ({ ...current, [key]: event.target.value }))

  async function choosePhoto(index: number, file: File | undefined) {
    if (!file) return
    setPhotoError('')
    setUploading(index)
    try {
      const uploaded = await uploadTeamPhoto(await shrinkPhoto(file))
      setTeam((current) => current.map((member, position) => (position === index ? { ...member, photoId: uploaded.photoId, photoUrl: uploaded.photoUrl } : member)))
    } catch (err) {
      setPhotoError(errorMessage(err, 'Não foi possível enviar a foto.'))
    } finally {
      setUploading(null)
    }
  }

  return (
    <Card
      title="Página inicial e Ajuda"
      description="A primeira tela do site, antes de entrar, e a página Ajuda. É pública: qualquer pessoa vê. Para a equipe, tenha a concordância de cada integrante com nome, função e foto."
      canManage={canManage}
      onSave={() =>
        saveParameters('publicPage', {
          ...form,
          team: team.map(({ name, role, photoId }) => ({ name, role, photoId })),
        })
      }
    >
      <h4>Abertura</h4>
      <label className="maintenance-form-field">
        <span>Título</span>
        <input maxLength={120} value={form.heroTitle} onChange={text('heroTitle')} />
      </label>
      <label className="maintenance-form-field">
        <span>Frase de apresentação</span>
        <textarea rows={2} maxLength={400} value={form.heroText} onChange={text('heroText')} />
      </label>

      <h4>Quem somos e contato</h4>
      <label className="maintenance-form-field">
        <span>Sobre a JUCESP</span>
        <textarea rows={3} maxLength={2000} value={form.aboutOrgan} onChange={text('aboutOrgan')} />
      </label>
      <label className="maintenance-form-field">
        <span>Sobre a SLM</span>
        <textarea rows={3} maxLength={2000} value={form.aboutSlm} onChange={text('aboutSlm')} />
      </label>
      <div className="robot-columns">
        <label className="maintenance-form-field">
          <span>E-mail da SLM para dúvidas</span>
          <input type="email" maxLength={160} placeholder="slm@..." value={form.contactEmail} onChange={text('contactEmail')} />
        </label>
        <label className="maintenance-form-field">
          <span>Horário de atendimento</span>
          <input maxLength={200} value={form.serviceHours} onChange={text('serviceHours')} />
        </label>
        <label className="maintenance-form-field">
          <span>Onde fica a SLM</span>
          <input maxLength={300} placeholder="Ex.: Prédio sede, 3º andar" value={form.location} onChange={text('location')} />
        </label>
      </div>

      <h4>Perguntas frequentes</h4>
      {form.faq.map((item, index) => (
        <div className="public-settings-item" key={index}>
          <label className="maintenance-form-field">
            <span>Pergunta {index + 1}</span>
            <input
              maxLength={200}
              required
              value={item.question}
              onChange={(event) => setForm({ ...form, faq: form.faq.map((entry, position) => (position === index ? { ...entry, question: event.target.value } : entry)) })}
            />
          </label>
          <label className="maintenance-form-field">
            <span>Resposta</span>
            <textarea
              rows={2}
              maxLength={2000}
              required
              value={item.answer}
              onChange={(event) => setForm({ ...form, faq: form.faq.map((entry, position) => (position === index ? { ...entry, answer: event.target.value } : entry)) })}
            />
          </label>
          <div className="robot-actions">
            <button type="button" className="maintenance-secondary-button" onClick={() => setForm({ ...form, faq: move(form.faq, index, -1) })}>
              Subir
            </button>
            <button type="button" className="maintenance-secondary-button" onClick={() => setForm({ ...form, faq: move(form.faq, index, 1) })}>
              Descer
            </button>
            <button type="button" className="maintenance-secondary-button" onClick={() => setForm({ ...form, faq: form.faq.filter((_, position) => position !== index) })}>
              Remover
            </button>
          </div>
        </div>
      ))}
      <button type="button" className="maintenance-secondary-button" disabled={form.faq.length >= 40} onClick={() => setForm({ ...form, faq: [...form.faq, { question: '', answer: '' }] })}>
        Acrescentar pergunta
      </button>

      <h4>Equipe</h4>
      {photoError && <Alert tone="error">{photoError}</Alert>}
      {team.map((member, index) => (
        <div className="public-settings-item public-settings-member" key={index}>
          {member.photoUrl ? <img src={member.photoUrl} alt="" width={72} height={72} /> : <span className="public-team-initials">?</span>}
          <div className="robot-columns">
            <label className="maintenance-form-field">
              <span>Nome</span>
              <input required maxLength={120} value={member.name} onChange={(event) => setTeam(team.map((entry, position) => (position === index ? { ...entry, name: event.target.value } : entry)))} />
            </label>
            <label className="maintenance-form-field">
              <span>Função</span>
              <input maxLength={120} value={member.role} onChange={(event) => setTeam(team.map((entry, position) => (position === index ? { ...entry, role: event.target.value } : entry)))} />
            </label>
            <label className="maintenance-form-field">
              <span>{uploading === index ? 'Enviando a foto...' : 'Foto (opcional)'}</span>
              <input type="file" accept="image/jpeg,image/png,image/webp" disabled={uploading !== null} onChange={(event) => void choosePhoto(index, event.target.files?.[0])} />
            </label>
          </div>
          <div className="robot-actions">
            {member.photoId && (
              <button type="button" className="maintenance-secondary-button" onClick={() => setTeam(team.map((entry, position) => (position === index ? { ...entry, photoId: null, photoUrl: null } : entry)))}>
                Tirar a foto
              </button>
            )}
            <button type="button" className="maintenance-secondary-button" onClick={() => setTeam(move(team, index, -1))}>
              Subir
            </button>
            <button type="button" className="maintenance-secondary-button" onClick={() => setTeam(move(team, index, 1))}>
              Descer
            </button>
            <button type="button" className="maintenance-secondary-button" onClick={() => setTeam(team.filter((_, position) => position !== index))}>
              Remover
            </button>
          </div>
        </div>
      ))}
      <button type="button" className="maintenance-secondary-button" disabled={team.length >= 40} onClick={() => setTeam([...team, { name: '', role: '', photoId: null, photoUrl: null }])}>
        Acrescentar integrante
      </button>

      <h4>Novidades</h4>
      {form.news.map((item, index) => (
        <div className="public-settings-item" key={index}>
          <div className="robot-columns">
            <label className="maintenance-form-field">
              <span>Data</span>
              <input type="date" required value={item.date} onChange={(event) => setForm({ ...form, news: form.news.map((entry, position) => (position === index ? { ...entry, date: event.target.value } : entry)) })} />
            </label>
            <label className="maintenance-form-field">
              <span>Título</span>
              <input required maxLength={160} value={item.title} onChange={(event) => setForm({ ...form, news: form.news.map((entry, position) => (position === index ? { ...entry, title: event.target.value } : entry)) })} />
            </label>
          </div>
          <label className="maintenance-form-field">
            <span>Texto</span>
            <textarea rows={2} maxLength={1500} value={item.text} onChange={(event) => setForm({ ...form, news: form.news.map((entry, position) => (position === index ? { ...entry, text: event.target.value } : entry)) })} />
          </label>
          <button type="button" className="maintenance-secondary-button" onClick={() => setForm({ ...form, news: form.news.filter((_, position) => position !== index) })}>
            Remover
          </button>
        </div>
      ))}
      <button
        type="button"
        className="maintenance-secondary-button"
        disabled={form.news.length >= 30}
        onClick={() => setForm({ ...form, news: [{ date: new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date()), title: '', text: '' }, ...form.news] })}
      >
        Acrescentar novidade
      </button>
      <p className="management-hint">
        Veja como ficou: <a href="/" target="_blank" rel="noreferrer">abrir a página inicial</a> numa janela anônima, ou a página Ajuda no menu.
      </p>
    </Card>
  )
}
