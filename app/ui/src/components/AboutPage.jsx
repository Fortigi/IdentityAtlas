const MIT_LICENSE = `MIT License

Copyright (c) 2025 Wim van den Heijkant / Fortigi

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

const SBOM_SECTIONS = [
  {
    title: 'Infrastructure',
    rows: [
      { name: 'PostgreSQL',  version: '16-alpine',         purpose: 'Database server',                        license: 'PostgreSQL License' },
      { name: 'PowerShell',  version: '7.4 (ubuntu-22.04)',purpose: 'Crawler runtime and scripting engine',    license: 'MIT' },
      { name: 'Node.js',     version: 'Latest LTS',        purpose: 'API server runtime',                     license: 'MIT' },
      { name: 'Docker',      version: '20.10+',            purpose: 'Container orchestration',                license: 'Apache 2.0' },
    ],
  },
  {
    title: 'API Backend (Node.js)',
    rows: [
      { name: 'express',            version: '^4.21.0',       purpose: 'Web application framework',                    license: 'MIT' },
      { name: 'pg',                 version: '^8.13.1',       purpose: 'PostgreSQL client',                             license: 'MIT' },
      { name: 'pg-copy-streams',    version: '^7.0.0',        purpose: 'High-performance bulk import',                  license: 'MIT' },
      { name: 'helmet',             version: '^8.1.0',        purpose: 'Security headers middleware',                   license: 'MIT' },
      { name: 'express-rate-limit', version: '^8.2.1',        purpose: 'Rate limiting protection',                     license: 'MIT' },
      { name: 'cors',               version: '^2.8.5',        purpose: 'Cross-Origin Resource Sharing',                 license: 'MIT' },
      { name: 'jsonwebtoken',       version: '^9.0.2',        purpose: 'JWT token validation',                          license: 'MIT' },
      { name: 'jwks-rsa',           version: '^3.1.0',        purpose: 'JWKS key retrieval for Entra ID',               license: 'MIT' },
      { name: 'multer',             version: '^1.4.5-lts.1',  purpose: 'CSV upload handling',                           license: 'MIT' },
      { name: 'swagger-ui-express', version: '^5.0.1',        purpose: 'API documentation UI',                          license: 'Apache 2.0' },
      { name: 'yamljs',             version: '^0.3.0',        purpose: 'YAML parsing for OpenAPI specs',                license: 'MIT' },
    ],
  },
  {
    title: 'Frontend (React)',
    rows: [
      { name: 'react',                   version: '^19.2.0',   purpose: 'UI framework',                               license: 'MIT' },
      { name: 'react-dom',               version: '^19.2.0',   purpose: 'React DOM renderer',                         license: 'MIT' },
      { name: 'vite',                    version: '^7.3.1',    purpose: 'Build tool and dev server',                   license: 'MIT' },
      { name: 'tailwindcss',             version: '^4.1.18',   purpose: 'Utility-first CSS framework',                 license: 'MIT' },
      { name: '@azure/msal-browser',     version: '^4.12.0',   purpose: 'Microsoft Authentication Library',            license: 'MIT' },
      { name: '@dnd-kit/core',           version: '^6.3.1',    purpose: 'Drag-and-drop core',                          license: 'MIT' },
      { name: '@tanstack/react-virtual', version: '^3.13.18',  purpose: 'Virtual scrolling for large tables',          license: 'MIT' },
      { name: 'exceljs',                 version: '^4.4.0',    purpose: 'Excel spreadsheet generation',                license: 'MIT' },
    ],
  },
];

function SbomTable({ rows }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b border-gray-200 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
            <th className="py-2 pr-4 w-48">Package</th>
            <th className="py-2 pr-4 w-36">Version</th>
            <th className="py-2 pr-4">Purpose</th>
            <th className="py-2 w-32">License</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.name} className="border-b border-gray-100 hover:bg-gray-50">
              <td className="py-2 pr-4 font-mono text-gray-800">{row.name}</td>
              <td className="py-2 pr-4 font-mono text-gray-500 text-xs">{row.version}</td>
              <td className="py-2 pr-4 text-gray-600">{row.purpose}</td>
              <td className="py-2 text-gray-500">{row.license}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function AboutPage() {
  return (
    <div className="max-w-4xl mx-auto space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">About Identity Atlas</h1>
        <p className="mt-2 text-gray-500">
          Identity Atlas is an open-source role-mining and identity governance platform built by{' '}
          <a href="https://fortigi.nl" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">Fortigi</a>.
          It pulls authorization data from Microsoft Graph and other systems into a PostgreSQL database and
          surfaces it through a React role-mining UI.
        </p>
        <div className="mt-3 flex gap-3 text-sm">
          <a
            href="https://github.com/Fortigi/IdentityAtlas"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-blue-600 hover:underline"
          >
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
            </svg>
            GitHub
          </a>
          <a
            href="https://github.com/Fortigi/IdentityAtlas/blob/main/LICENSE"
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 hover:underline"
          >
            MIT License
          </a>
          <a
            href="https://github.com/Fortigi/IdentityAtlas/blob/main/docs/reference/sbom.md"
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 hover:underline"
          >
            Full SBOM (Markdown)
          </a>
        </div>
      </div>

      {/* License */}
      <div className="bg-white border border-gray-200 rounded-lg p-6">
        <h2 className="text-lg font-semibold text-gray-800 mb-4">License</h2>
        <pre className="text-xs text-gray-600 whitespace-pre-wrap font-mono bg-gray-50 rounded p-4 border border-gray-100 leading-relaxed">
          {MIT_LICENSE}
        </pre>
      </div>

      {/* Software BOM */}
      <div className="bg-white border border-gray-200 rounded-lg p-6">
        <h2 className="text-lg font-semibold text-gray-800 mb-1">Software Bill of Materials</h2>
        <p className="text-sm text-gray-500 mb-6">
          All direct dependencies use permissive open-source licenses (MIT, Apache 2.0, or PostgreSQL License).
        </p>
        <div className="space-y-8">
          {SBOM_SECTIONS.map((section) => (
            <div key={section.title}>
              <h3 className="text-sm font-semibold text-gray-700 mb-3 pb-1 border-b border-gray-100">
                {section.title}
              </h3>
              <SbomTable rows={section.rows} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
