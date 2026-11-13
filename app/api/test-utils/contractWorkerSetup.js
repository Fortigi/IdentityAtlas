// Vitest setupFile for the contract suite: runs in each worker before each test
// file is imported, and points CONTRACT_DB_URL at THIS worker's own database.
// Every helper and test reads CONTRACT_DB_URL, so none of them needs to know.
import { workerDbUrl } from './contractWorkerDb.js';

process.env.CONTRACT_DB_URL = workerDbUrl(
  process.env.CONTRACT_DB_TEMPLATE_URL,
  process.env.VITEST_POOL_ID,
);
