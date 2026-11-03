import { config } from 'dotenv'
import { resolve } from 'node:path'
import { isTestRuntime } from './database/databaseSafety.js'

// Em teste, as credenciais do arquivo .env nunca entram no processo.
if (!isTestRuntime()) {
  config({ path: resolve(__dirname, '../.env') })
}
