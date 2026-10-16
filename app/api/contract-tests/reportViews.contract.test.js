// Contract test — saved report views against a real PostgreSQL schema.
//
// The unit tests mock the database, so they cannot say whether migration 090
// and the store's statements agree: column names, the JSONB round trip of the
// params, and the case-insensitive unique name that turns into a 409. This runs
// the whole path — save a view of the Entitlement Pivot, list it in /api/reports,
// run it, change it, delete it.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootContractApp } from '../test-utils/contractApp.js';

const NAME = 'Contract Ledger view';
let agent;
let pool;

beforeAll(async () => {
  ({ agent, pool } = await bootContractApp());
});

afterAll(async () => {
  await pool.query(`DELETE FROM "ReportViews" WHERE lower("name") LIKE 'contract %'`);
  await pool.end();
  delete process.env.USE_SQL; // singleFork — env mutations leak across files
});

describe('/api/report-views', () => {
  let view;

  it('saves a view of a standard report, keeping only the parameters it declares', async () => {
    const res = await agent.post('/api/report-views').send({
      reportName: 'application-access-review', name: NAME, description: 'For the owner',
      params: { contexts: ['No Such Context'], fields: ['entitlement.type'], junk: 'dropped' },
    });
    expect(res.status).toBe(201);
    view = res.body;
    expect(view).toMatchObject({
      report: `view-${view.id}`, reportName: 'application-access-review', name: NAME, description: 'For the owner',
      params: { contexts: ['No Such Context'], fields: ['entitlement.type'] },
    });
  });

  it('refuses a second view with the same name in other capitals', async () => {
    const res = await agent.post('/api/report-views')
      .send({ reportName: 'application-access-review', name: NAME.toUpperCase() });
    expect(res.status).toBe(409);
  });

  it('lists the view as a report and runs it with the saved parameters', async () => {
    const list = await agent.get('/api/reports');
    const listed = list.body.data.find(r => r.name === view.report);
    expect(listed).toMatchObject({ displayName: NAME, source: 'view', view: { id: view.id, reportName: 'application-access-review' } });
    expect(listed.parametersSchema.required).toEqual([]);

    const run = await agent.get(`/api/reports/${view.report}/rows`);
    expect(run.status).toBe(200);
    // The saved context name reached the report: it says it found nothing by that name.
    expect(run.body.notices.map(n => n.text).join('\n')).toMatch(/No context of resources matches "No Such Context"/);
    expect(run.body.columns.map(c => c.key)).toContain('entitlement.type');
  });

  it('changes the name and parameters, and reads them back', async () => {
    const res = await agent.put(`/api/report-views/${view.id}`)
      .send({ name: `${NAME} renamed`, params: { contexts: 'Other' } });
    expect(res.status).toBe(200);
    const got = await agent.get(`/api/report-views/${view.id}`);
    expect(got.body).toMatchObject({ name: `${NAME} renamed`, description: null, params: { contexts: 'Other' } });
  });

  it('deletes it, after which it is gone from the reports too', async () => {
    expect((await agent.delete(`/api/report-views/${view.id}`)).status).toBe(204);
    expect((await agent.get(`/api/reports/${view.report}/rows`)).status).toBe(404);
    expect((await agent.delete(`/api/report-views/${view.id}`)).status).toBe(404);
  });
});
