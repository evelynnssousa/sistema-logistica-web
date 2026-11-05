import Icon from './ui/Icon'

/** Baixa o relatório individual. A API aplica as permissões e registra a exportação. */
function ReportExport({ path }: { path: string }) {
  return (
    <div className="report-export no-print">
      <a className="maintenance-secondary-button" href={`/api${path}?format=pdf`} download>
        <Icon name="download" size={18} />
        Baixar relatório em PDF
      </a>
      <a className="maintenance-secondary-button" href={`/api${path}?format=csv`} download>
        <Icon name="download" size={18} />
        Baixar em CSV
      </a>
    </div>
  )
}

export default ReportExport
