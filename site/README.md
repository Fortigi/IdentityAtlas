# Identity Atlas — marketing website

A single, self-contained static landing page (issue #677). No build step, no
dependencies — `index.html` inlines all CSS/JS; assets live in `assets/`.

- **Sections:** Why · What · How to start · Trust (the four required sections).
- **Copy source of truth:** [`docs/marketing/`](../docs/marketing/) — keep it in sync.
- **Brand:** blue-600 interactive, lime brand accent, light/dark aware — mirrors the app and docs.

## Assets

`assets/mark.png`, `assets/favicon.png`, `assets/og-image.png` are generated from
`app/ui/public/logo-dark.png` (the transparent logo). To regenerate, re-run the
crop/resize used in issue #677 (System.Drawing / sharp) against that source.

## Preview locally

Any static server works, e.g.:

```bash
npx serve site        # or: python3 -m http.server -d site 8080
```

## Deploy — SK2 (internal feedback build)

Served by a throwaway nginx container on sidekick-2 (`10.12.0.166:8080`):

```bash
rsync -az --delete site/ sidekick-2:~/ia-site/
ssh sidekick-2 'docker rm -f ia-site 2>/dev/null; \
  docker run -d --name ia-site --restart unless-stopped -p 8080:80 \
  -v ~/ia-site:/usr/share/nginx/html:ro nginx:alpine'
# → http://10.12.0.166:8080
```

## Deploy — production (Azure Static Web Apps)

Final home is **Azure Static Web Apps** (free tier, custom domain). `staticwebapp.config.json`
sets the security headers and asset caching. Deploy via the
`Azure/static-web-apps-deploy` GitHub Action (`.github/workflows/deploy-site.yml`)
using an `AZURE_STATIC_WEB_APPS_API_TOKEN` secret, with `app_location: "site"`.

Custom domain: point **identityatlas.io** at the SWA default hostname (CNAME, or
A/ALIAS for the apex) in the Azure portal → Custom domains, then validate. Add
**identityatlas.ai** as a second custom domain that redirects to `.io`.
