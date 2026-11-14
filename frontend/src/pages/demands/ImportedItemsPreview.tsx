import { formatBRL } from '../../api/instrumentsApi'
import type { ImportedItem } from '../../api/instrumentsApi'
import { Alert } from '../../components/ui/Feedback'

/** Itens lidos da planilha, para conferir antes de salvar, e os avisos do robô. */
function ImportedItemsPreview({ items, warnings, total }: { items: readonly ImportedItem[]; warnings: readonly string[]; total: number }) {
  return (
    <div className="ui-stacked">
      {warnings.length > 0 && (
        <Alert tone="warning">
          <strong>Confira antes de salvar:</strong>
          <ul>
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </Alert>
      )}
      <p className="demand-muted">
        {items.length} {items.length === 1 ? 'item lido' : 'itens lidos'} da planilha, somando {formatBRL(total)}.
      </p>
      {items.length > 0 && (
        <div className="data-table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>Linha</th>
                <th>Item</th>
                <th>Descrição</th>
                <th>Unidade</th>
                <th>Quantidade</th>
                <th>Valor unitário</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.row}>
                  <td>{item.row}</td>
                  <td>{item.itemNumber ?? '—'}</td>
                  <td>{item.description}</td>
                  <td>{item.unit}</td>
                  <td>{item.registered.toLocaleString('pt-BR')}</td>
                  <td>{formatBRL(item.unitPrice)}</td>
                  <td>{formatBRL(Math.round(item.registered * item.unitPrice * 100) / 100)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export default ImportedItemsPreview
