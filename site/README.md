# Identity Atlas — marketing website

A single, self-contained static landing page (issue #677). No build step, no
dependencies — `index.html` inlines all CSS/JS; assets live in `assets/`.

- **Sections:** Watch (explainer video) · Why · What · How to start · Trust (the four required sections plus the video).
- **Copy source of truth:** [`docs/marketing/`](../docs/marketing/) — keep it in sync.
- **Brand:** blue-600 interactive, lime brand accent, light/dark aware — mirrors the app and docs.

## Assets

`assets/mark.png`, `assets/favicon.png`, `assets/og-image.png` are generated from
`app/ui/public/logo-dark.png` (the transparent logo). To regenerate, re-run the
crop/resize used in issue #677 (System.Drawing / sharp) against that source.

`assets/explainer.mp4` is the one-minute explainer ("Trust starts with clarity"),
self-hosted so the page needs no third-party player. It is the original export
remuxed with `ffmpeg -c copy -movflags +faststart` so playback can start before the
whole file is downloaded. `assets/explainer-poster.jpg` is its opening title card
(`ffmpeg -ss 0 -frames:v 1 -vf scale=1280:-1`). If you replace the video, use a new
file name: `/assets/*` is served with a one-year immutable cache.

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

## Deploy — production

The public site is served the same way as the build above: static files behind nginx.
There is no GitHub Actions deploy workflow. An Azure Static Web Apps workflow
(`deploy-site.yml`) was drafted early on, never enabled, and has been removed.
`staticwebapp.config.json` stays in the folder: it holds the security headers and
asset-caching rules, should the site ever move to Azure Static Web Apps. If it does,
add a new workflow with SHA-pinned actions and an explicit `permissions:` block.
