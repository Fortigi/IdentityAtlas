// Per-worker databases for the contract suite.
//
// The contract files were written to run one at a time against one shared
// database: they race on global constraints (uq_RA_principal isn't
// systemId-scoped) and shared tables (ContextAlgorithms) when two run at once.
// Instead of serialising the whole suite on one database, globalSetup migrates
// ONE database and clones it, cheaply, once per Vitest worker
// (CREATE DATABASE … TEMPLATE). Each worker runs its files strictly one after
// another against its own clone, so every database still sees exactly the
// sequential stream of files the suite was written for — just a shorter one.

// How many workers (and so clones). The GitHub runner has 4 vCPUs.
export const CONTRACT_WORKERS = 4;

export const workerDbName = (poolId) => `contract_w${poolId}`;

// The connection URL of worker `poolId`'s database, derived from the URL of the
// migrated template. Vitest numbers pool slots 1..maxWorkers (VITEST_POOL_ID).
export function workerDbUrl(templateUrl, poolId, workers = CONTRACT_WORKERS) {
  const id = Number(poolId);
  if (!Number.isInteger(id) || id < 1 || id > workers) {
    throw new Error(
      `VITEST_POOL_ID=${poolId} has no contract database: globalSetup cloned ` +
      `${workers} (contract_w1..contract_w${workers}). Keep maxWorkers in ` +
      'vitest.contract.config.js equal to CONTRACT_WORKERS.');
  }
  const url = new URL(templateUrl);
  url.pathname = `/${workerDbName(id)}`;
  return url.toString();
}

// Clone the (migrated, now idle) template database once per worker. Per-database
// settings are NOT copied by TEMPLATE, so the statement timeout is re-applied.
export async function cloneWorkerDatabases(pool, templateDb, workers = CONTRACT_WORKERS) {
  for (let id = 1; id <= workers; id++) {
    const name = workerDbName(id);
    await pool.query(`CREATE DATABASE "${name}" TEMPLATE "${templateDb}"`);
    await pool.query(`ALTER DATABASE "${name}" SET statement_timeout = '10s'`);
  }
}
