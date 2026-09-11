export default {
  id: 'scim',
  name: 'SCIM 2.0',
  description: 'Sync users, groups and group members from any SCIM 2.0 endpoint — objects and attributes are discovered live from the service provider',
  // Experimental: proven against the SCIM spec and a mock provider, but only
  // lightly exercised against real service providers. Offered in the
  // Add-Crawler picker only while Admin → Experimental → Experimental crawlers
  // is on. Must match "experimental" in crawler.json (the server-side gate).
  experimental: true,
};
