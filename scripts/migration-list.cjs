'use strict'

/**
 * Migrações posteriores à estrutura inicial (001), em ordem. A presença da tabela marcadora é o único
 * registro de migração que estes bancos têm. Usada por apply-migrations.cjs e homologacao.cjs.
 */
const migrations = [
  { file: '002_password_recovery', marker: 'password_recovery_codes' },
  { file: '003_user_access', marker: 'auth_user_access' },
  { file: '004_flight_passengers', marker: 'flight_request_passengers' },
  { file: '005_operational_modules', marker: 'catalog_options' },
  { file: '006_integrations', marker: 'integration_events' },
  { file: '007_operations_center', marker: 'system_settings' },
  { file: '008_attachments', marker: 'request_attachments' },
  { file: '009_module_extensions', marker: 'vehicles' },
  { file: '010_monitoring', marker: 'technical_events' },
  { file: '011_delivery_forecast', marker: 'material_delivery_history' },
  { file: '012_operational_transparency', marker: 'config_versions' },
  { file: '013_communications', marker: 'manual_emails' },
  { file: '014_demands', marker: 'demands' },
  { file: '015_organizational_structure', marker: 'user_directorate_links' },
  { file: '016_driver_portal', marker: 'fleet_drivers' },
  { file: '017_driver_portal_settings', marker: 'driver_occurrence_types' },
  // Não cria tabela: vale como aplicada quando a 017 existe e nada de public está aberto à API pública.
  { file: '018_public_api_privileges', marker: 'driver_occurrence_types', closesPublicApi: true },
  { file: '019_email_quota', marker: 'email_daily_usage' },
  { file: '020_warehouse_finance', marker: 'warehouse_price_agreements' },
  { file: '021_contract_instruments', marker: 'contract_instruments' },
  // Só acrescenta colunas: o marcador é uma coluna.
  { file: '022_forms_and_links', marker: 'contract_instrument_usages.stock_movement_id' },
  { file: '023_patrimony', marker: 'patrimony_assets' },
]

module.exports = { migrations }
