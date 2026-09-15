# Dokploy Desktop architecture

## Current boundary

- `apps/dokploy/pages` and `apps/dokploy/components` are the legacy Next.js UI. 52 of 68 pages use server-side props and cannot be copied into a standalone renderer unchanged.
- `apps/dokploy/pages/api`, `apps/dokploy/server/api`, and `apps/dokploy/server/wss` are the HTTP, tRPC, auth, and WebSocket boundary.
- `packages/server` owns Drizzle/PostgreSQL access and the Docker, deployment, backup, SSL, and Traefik domain logic.
- `apps/dokploy/server/server.ts` currently starts Next.js, WebSockets, queues, schedules, and host initialization in one Node.js process.

## Minimal split

1. Keep `apps/dokploy` as the backend while the desktop migration is in progress. Do not move routers or service logic.
2. Build the new UI in `apps/desktop`. Keep a small typed facade for the API calls already migrated; all execution stays on the remote Dokploy server.
3. Use the Electron loopback gateway for `/api/*` and WebSocket upgrades. This preserves Better Auth cookies without weakening Chromium CORS or `webSecurity`.
4. Migrate one complete feature slice at a time: auth and projects, applications, Compose, databases, domains/SSL, logs/terminal, settings.
5. Once the feature matrix is complete, remove non-API pages from the backend production build. Keep Next.js for API handlers and the Node bootstrap; do not replace it with NestJS or Go.
6. Measure RSS before and after the API-only build. Split queues/schedules into the existing workspace services only if measurement shows that they, rather than Next page code, dominate memory.

## Implemented first slice

- Configurable Dokploy server connection persisted by Electron.
- Better Auth email/password session through the existing `/api/auth` handler.
- Thin tRPC client using the existing router paths, without importing backend runtime code into Electron.
- Project/environment navigation.
- Application and Compose deploy, redeploy, start, and stop.
- Environment variable editing and domain/SSL visibility.
- Application log snapshots.
- WebSocket tunneling foundation for live deployment, container logs, stats, and terminals.
- Remote backend installation from the desktop app using a one-time root password.
- SSH host fingerprint confirmation, local Ed25519 key generation, `authorized_keys` installation, and key-only verification.
- API-only runtime mode through `DOKPLOY_DESKTOP_ONLY=true`.
- Multi-architecture backend image publishing to `ghcr.io/<owner>/<repository>-backend` from `.github/workflows/desktop-backend-image.yml`.

## Fork image delivery

Pushes to the default branch publish `ghcr.io/<owner>/<repository>-backend:latest`; tags such as `v0.31.0` publish the matching immutable tag, and every build also gets a `sha-*` tag. Pull requests build both architectures without publishing.

The Docker build argument `DOKPLOY_DESKTOP_ONLY=true` removes every non-API Next.js page before `next build` and sets the same flag in the runtime image. The desktop installer accepts any public Docker image reference and tells Docker Swarm on the remote server to pull that exact image. GHCR creates new packages as private, so make the package public before installing it on a server that has not logged in to GHCR.

## Remaining migration slices

- Compose container discovery and live logs.
- Create/edit flows for projects, applications, Compose, domains, SSL, ports, mounts, and sources.
- Database service screens and backups.
- Deployment history, live deployment output, Docker dashboard, and terminals.
- Organization, user, server, registry, notification, and security settings.
- Passkey/2FA/SSO and external OAuth callback handling.
- Desktop packaging, signing, auto-update, and release CI.
- Measured memory baseline and dependency pruning after the API-only build.
