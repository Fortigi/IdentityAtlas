// GET /analytics/v1/profiles/:id/metadata — what a Power BI model needs to
// label its visuals honestly: versions, the exact metric definitions behind
// each dataset, the history method, the supported combinations and the known
// limitations. Pure: built from the stored profile and the static catalog, so
// it is cheap enough to fetch on every refresh.

import { getMetric } from './metrics.js';
import { resolveField } from './fields.js';
import { iriFor } from './ontologyTerms.js';
import { API_VERSION } from './aggregator.js';

export const LIMITATIONS = Object.freeze([
  'Only the dimension combinations listed as datasets are supported. Totals from two datasets cannot be '
    + 'combined into a joint breakdown: a cross-filter between datasets is not a valid number.',
  'Cells with fewer members than the minimum group size have their measures withheld (suppressed: true). '
    + 'Suppression is per cell; it does not prevent differencing between datasets that share dimensions.',
  'Current metrics describe the latest sync. History is reconstructed only for account (Principal) attributes and only '
    + 'back to the oldest retained audit event; identity attributes and context membership have no history.',
  'Accounts of a system are counted from the moment that system was first loaded; earlier periods do not include them.',
  'All instants are UTC. The running month is measured now and marked periodComplete=false.',
]);

function datasetMetadata(definition, ds) {
  const metric = getMetric(ds.metric);
  return {
    id: ds.id,
    metric: metric.id,
    metricVersion: metric.version,
    kind: metric.kind,
    historyMethod: metric.historyMethod,
    grain: metric.grain,
    description: metric.description,
    measures: metric.measures,
    suppressionPopulation: metric.population,
    dimensions: ds.dimensions.map((fieldId) => {
      const dim = definition.dimensions.find(d => d.field === fieldId);
      return { field: fieldId, iri: iriFor(fieldId), label: dim.label, unknownLabel: dim.unknownLabel, entity: resolveField(fieldId).entity };
    }),
    ...(ds.periods ? { timeGrain: metric.timeGrain, periods: ds.periods } : {}),
  };
}

export function profileMetadata(profile) {
  const { definition } = profile;
  return {
    apiVersion: API_VERSION,
    profile: {
      id: profile.id, name: profile.name, version: profile.version, status: profile.status,
      updatedAt: profile.updatedAt, updatedBy: profile.updatedBy,
    },
    scope: definition.scope,
    privacy: definition.privacy,
    limits: definition.limits,
    timezone: 'UTC',
    datasets: definition.datasets.map(ds => datasetMetadata(definition, ds)),
    limitations: LIMITATIONS,
  };
}
