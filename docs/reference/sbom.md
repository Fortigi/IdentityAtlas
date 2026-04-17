# Software Bill of Materials (SBOM)

This document lists all major software components, dependencies, and infrastructure elements that comprise Identity Atlas.

---

## Infrastructure Components

| Component | Version | Purpose | License |
|-----------|---------|---------|---------|
| PostgreSQL | 16-alpine | Database server | PostgreSQL License |
| PowerShell | 7.4 (ubuntu-22.04) | Crawler runtime and scripting engine | MIT |
| Node.js | Latest LTS (via Docker base image) | API server runtime | MIT |
| Docker | 20.10+ (required) | Container orchestration | Apache 2.0 |

---

## API Backend (Node.js)

### Core Dependencies

| Package | Version | Purpose | License |
|---------|---------|---------|---------|
| express | ^4.21.0 | Web application framework | MIT |
| pg | ^8.13.1 | PostgreSQL client | MIT |
| pg-copy-streams | ^7.0.0 | High-performance bulk import | MIT |

### Security & Authentication

| Package | Version | Purpose | License |
|---------|---------|---------|---------|
| helmet | ^8.1.0 | Security headers middleware | MIT |
| express-rate-limit | ^8.2.1 | Rate limiting protection | MIT |
| cors | ^2.8.5 | Cross-Origin Resource Sharing | MIT |
| jsonwebtoken | ^9.0.2 | JWT token validation | MIT |
| jwks-rsa | ^3.1.0 | JWKS key retrieval for Entra ID | MIT |

### File Handling & Documentation

| Package | Version | Purpose | License |
|---------|---------|---------|---------|
| multer | ^1.4.5-lts.1 | CSV upload handling | MIT |
| swagger-ui-express | ^5.0.1 | API documentation UI | Apache 2.0 |
| yamljs | ^0.3.0 | YAML parsing for OpenAPI specs | MIT |

### Development & Testing

| Package | Version | Purpose | License |
|---------|---------|---------|---------|
| vitest | ^2.0.0 | Unit testing framework | MIT |

---

## Frontend (React)

### Core Framework

| Package | Version | Purpose | License |
|---------|---------|---------|---------|
| react | ^19.2.0 | UI framework | MIT |
| react-dom | ^19.2.0 | React DOM renderer | MIT |
| vite | ^7.3.1 | Build tool and dev server | MIT |

### Styling

| Package | Version | Purpose | License |
|---------|---------|---------|---------|
| tailwindcss | ^4.1.18 | Utility-first CSS framework | MIT |
| @tailwindcss/vite | ^4.1.18 | Vite plugin for Tailwind | MIT |

### Authentication & Authorization

| Package | Version | Purpose | License |
|---------|---------|---------|---------|
| @azure/msal-browser | ^4.12.0 | Microsoft Authentication Library | MIT |

### UI Interactions

| Package | Version | Purpose | License |
|---------|---------|---------|---------|
| @dnd-kit/core | ^6.3.1 | Drag-and-drop core | MIT |
| @dnd-kit/modifiers | ^9.0.0 | DnD position modifiers | MIT |
| @dnd-kit/sortable | ^10.0.0 | Sortable list implementation | MIT |
| @dnd-kit/utilities | ^3.2.2 | DnD utility functions | MIT |
| @tanstack/react-virtual | ^3.13.18 | Virtual scrolling for large tables | MIT |

### Data Export

| Package | Version | Purpose | License |
|---------|---------|---------|---------|
| exceljs | ^4.4.0 | Excel spreadsheet generation | MIT |

### Development & Testing

| Package | Version | Purpose | License |
|---------|---------|---------|---------|
| @vitejs/plugin-react | ^5.1.1 | Vite React plugin | MIT |
| eslint | ^9.39.1 | JavaScript linter | MIT |
| eslint-plugin-react-hooks | ^7.0.1 | React hooks linting rules | MIT |
| eslint-plugin-react-refresh | ^0.4.24 | React refresh linting | MIT |
| @playwright/test | ^1.58.2 | End-to-end testing framework | Apache 2.0 |
| @axe-core/playwright | ^4.11.1 | Accessibility testing | MPL 2.0 |
| @eslint/js | ^9.39.1 | ESLint JavaScript rules | MIT |
| globals | ^16.5.0 | Global variable definitions | MIT |
| @types/react | ^19.2.7 | TypeScript type definitions for React | MIT |
| @types/react-dom | ^19.2.3 | TypeScript type definitions for React DOM | MIT |

---

## PowerShell Module

### Module Information

| Property | Value |
|----------|-------|
| Module Name | IdentityAtlas (formerly FortigiGraph) |
| Version | 5.0.20260415.1015 |
| Author | Wim van den Heijkant |
| Company | Fortigi |
| License | MIT |
| Repository | [github.com/Fortigi/IdentityAtlas](https://github.com/Fortigi/IdentityAtlas) |
| Distribution | [PowerShell Gallery](https://www.powershellgallery.com) |

### Runtime Requirements

- PowerShell 7.0 or later (recommended: 7.4+)
- No external PowerShell module dependencies (all functionality is self-contained)

### Function Categories

| Category | Count | Purpose |
|----------|-------|---------|
| Base | 22 | Authentication, HTTP operations, token management |
| Generic | 49 | Microsoft Graph API CRUD operations |
| Sync | 32 | High-performance data synchronization |
| SQL | 31 | Database operations (legacy, not used in Docker) |
| Specific | 9 | High-level idempotent helpers |
| RiskScoring | 17 | LLM-assisted risk profiling and scoring |

---

## External API Dependencies

Identity Atlas integrates with the following external services:

| Service | Purpose | Authentication | Optional/Required |
|---------|---------|----------------|-------------------|
| Microsoft Graph API | Entra ID data synchronization | Service Principal (OAuth 2.0) | Optional (configured per crawler) |
| Anthropic Claude API | LLM-based risk profiling | API key | Optional (for risk scoring) |
| OpenAI API | LLM-based risk profiling | API key | Optional (for risk scoring) |
| Azure OpenAI | LLM-based risk profiling | API key + endpoint | Optional (for risk scoring) |

---

## Docker Images

Identity Atlas distributes pre-built Docker images via GitHub Container Registry:

| Image | Base | Size (approx) | Purpose |
|-------|------|---------------|---------|
| `ghcr.io/fortigi/identity-atlas:latest` | node:lts-alpine | ~500 MB | Web server (API + frontend) |
| `ghcr.io/fortigi/identity-atlas-worker:latest` | mcr.microsoft.com/powershell:7.4-ubuntu-22.04 | ~350 MB | PowerShell crawler worker |

---

## Security Considerations

### Credential Storage

- **Secrets vault**: All sensitive credentials (LLM API keys, scraper credentials) are stored encrypted in the PostgreSQL `Secrets` table using AES-256-GCM with envelope encryption
- **Master key**: The `IDENTITY_ATLAS_MASTER_KEY` environment variable controls the root encryption key; if unset, a key is auto-generated and persisted to the `job_data` volume
- **PostgreSQL password**: Default password is for local evaluation only; production deployments must set `POSTGRES_PASSWORD` explicitly

### Network Exposure

- **Default ports**: PostgreSQL (5432), Web UI/API (3001)
- **Production recommendations**: 
  - Use TLS termination proxy (nginx, Traefik) in front of the web container
  - Restrict PostgreSQL port to localhost or internal network only
  - Set `AUTH_ENABLED=true` for Entra ID authentication in multi-user environments

### Data Privacy

- **LLM risk profiling**: Only organizational context (public domain information) is sent to external LLM providers during profile generation; no user identities, group names, or permission data leaves the environment
- **Local scoring**: After profile generation, all risk scoring runs locally against the PostgreSQL database

---

## License Summary

All direct dependencies use permissive open-source licenses:

- **MIT License**: 95%+ of dependencies
- **Apache 2.0**: swagger-ui-express, @playwright/test
- **MPL 2.0**: @axe-core/playwright
- **PostgreSQL License**: PostgreSQL server

Identity Atlas itself is licensed under the **MIT License**. See the repository `LICENSE` file for full terms.

---

## Version Information

This SBOM reflects Identity Atlas version **5.0.20260415.1015** (April 2026).

For the most current dependency versions, see:

- API backend: [`app/api/package.json`](https://github.com/Fortigi/IdentityAtlas/blob/main/app/api/package.json)
- Frontend: [`app/ui/package.json`](https://github.com/Fortigi/IdentityAtlas/blob/main/app/ui/package.json)
- PowerShell module: [`setup/IdentityAtlas.psd1`](https://github.com/Fortigi/IdentityAtlas/blob/main/setup/IdentityAtlas.psd1)

---

## Updates and Maintenance

Identity Atlas follows semantic versioning with automated version bumping on every PR merge to `main`. The CI/CD pipeline automatically builds and publishes Docker images with updated dependency versions.

To check for updates:

```bash
# Pull latest images
docker compose -f docker-compose.prod.yml pull

# Restart with new images
docker compose -f docker-compose.prod.yml up -d
```

For security advisories and CVE notifications, monitor the [GitHub Security Advisories](https://github.com/Fortigi/IdentityAtlas/security/advisories) page.
