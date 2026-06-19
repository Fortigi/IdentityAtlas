export default {
  id: 'custom-connector',
  name: 'Custom Connector',
  description: 'Build your own crawler using the Ingest API — register an API key, download the OpenAPI spec, start pushing data',
  // This type is push-mode (data arrives via the Ingest API, authenticated by
  // the API key registered here) rather than a scheduled pull job, so the
  // generic card actions that assume a CrawlerConfigs-driven job don't apply.
  supportsRun: false,
  supportsConfigure: false,
  supportsExport: false,
};
