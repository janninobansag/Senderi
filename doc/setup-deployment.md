# Local setup and deployment

The repository has a React/Vite client in `client/`, an Express API in `server/`, and shared TypeScript contracts in `shared/`. The client uses Vite's `/api` proxy to reach the local API.

## Prerequisites

- Node.js 22.13 or newer in the 22.x line, or Node.js 24 or newer, and npm.
- A local MongoDB instance or MongoDB Atlas database for running the API.

## Install and run locally

Run these commands from the repository root to install the locked client and server dependencies:

```sh
npm ci --prefix client
npm ci --prefix server
```

Create `server/.env` from `server/.env.example` and set `MONGODB_URI` to your local MongoDB or Atlas connection string. Keep real credentials in ignored `.env` files or deployment settings; never commit them. On PowerShell, copy the example with `Copy-Item server/.env.example server/.env`; on macOS/Linux, use `cp server/.env.example server/.env`.

Start the API in one terminal from the repository root:

```sh
npm run dev --prefix server
```

The API connects to MongoDB and creates its indexes before listening on port 3000 by default. Verify it at `http://localhost:3000/api/health`. Press Ctrl+C to stop the API and close its database connection cleanly.

Start the client in a second terminal:

```sh
npm run dev --prefix client
```

Vite serves the client at `http://localhost:5173` and proxies `/api/*` to `http://localhost:3000`. The current `client/.env.example` contains the public `VITE_SOCKET_URL` placeholder for the later Socket.IO feature; local REST requests do not need a backend URL variable.

In Windows PowerShell, if the `npm` command is blocked by its script execution policy, use `npm.cmd` in the commands above (for example, `npm.cmd run dev --prefix server`).

## Local checks and CI

Run the same checks used by the pull-request workflow from the repository root:

```sh
npm run lint --prefix client
npm run typecheck --prefix client
npm run build --prefix client
npm run lint --prefix server
npm run typecheck --prefix server
npm run build --prefix server
npm test --prefix server
```

The current automated test suite is in `server/test/`; there are no client tests yet. GitHub Actions runs the lint, type-check, build, and available server tests for every pull request. M0-J3.4 is complete only after a pull request has triggered the workflow and its check reports success or a clear failure. M0-J3 adds no environment variables.

For Atlas, create a MongoDB Atlas Free cluster and database user. Keep the connection string in `server/.env` or the deployment environment; do not commit it. Atlas Free has a 0.5 GB data limit, so keep image bytes in Cloudinary. [Atlas Free limits](https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/)

Create a Cloudinary account for M2/M4 image work. The server signs uploads and handles protected post-photo delivery; the browser does not receive the API secret.

Create a Brevo API key, verify the sender address, and create and activate a transactional reset-email template. Use a template link that reads the dynamic `resetUrl` parameter (for example, `{{params.resetUrl}}`). Configure `BREVO_API_KEY`, `BREVO_SENDER_EMAIL`, and the numeric `BREVO_RESET_TEMPLATE_ID` in `server/.env` locally and in Render's server environment. The server sends the template through [Brevo's transactional email endpoint](https://developers.brevo.com/docs/send-a-transactional-email) and passes `resetUrl` in the template parameters. Keep the API key only on the server. Senderi enforces a development-wide cap of 100 attempted reset-email sends per UTC day.

## Environment-variable contract

The committed `server/.env.example` and `client/.env.example` contain placeholders only. Add a variable only when a feature needs it and update this table.

| Variable | Service | Purpose |
| --- | --- | --- |
| `NODE_ENV` | Server | Development or production behavior. |
| `PORT` | Server | Render-provided listening port; local default documented by M0. |
| `MONGODB_URI` | Server | Atlas connection string. |
| `CLIENT_ORIGINS` | Server | Comma-separated exact Vercel or local client origins allowed for mutation and socket checks. Add a preview URL only while testing that preview. |
| `TRUST_PROXY_HOPS` | Server | Number of trusted reverse-proxy hops before Express; `0` locally. Set the Render value to the verified request path's hop count so per-IP limits use the client address. |
| `SESSION_SECRET` | Server | Random secret for session-token hashing or signing support. |
| `CLOUDINARY_CLOUD_NAME` | Server | Cloudinary environment name. |
| `CLOUDINARY_API_KEY` | Server | Signed upload credential. |
| `CLOUDINARY_API_SECRET` | Server | Signed upload and media credential. |
| `BREVO_API_KEY` | Server | Transactional email credential. |
| `BREVO_SENDER_EMAIL` | Server | Verified sender address. |
| `BREVO_RESET_TEMPLATE_ID` | Server | Numeric ID of the active reset-email template. Its link must use the `resetUrl` template parameter. |
| `PUBLIC_APP_URL` | Server | Base URL for reset links. |
| `VITE_SOCKET_URL` | Client | Public Render Socket.IO endpoint; not a secret. |

Do not put secrets in `VITE_*` variables: Vite embeds them in browser assets. The Vercel rewrite and Vite local proxy should keep REST calls at `/api/*`; the client uses `VITE_SOCKET_URL` only for the direct Socket.IO connection.

## Free-tier deployment

- Deploy the Express HTTP and Socket.IO server as one Render web service. It must listen on `0.0.0.0` and Render's `PORT`. Configure the server variables above in Render.
- Deploy the Vite client to Vercel. Build from `client/` and put the public Render API URL in the versioned `/api/:path*` rewrite configuration. Keep authenticated API and media responses uncached. Add the exact Vercel preview origin to `CLIENT_ORIGINS` while verifying cookies and the rewrite on that preview. [Vercel external rewrites](https://vercel.com/docs/routing/rewrites)
- Connect the server to Atlas and Cloudinary; avoid writing images or state to Render's local disk. Render Free can spin down after 15 minutes without inbound traffic and loses local files on restart. A new HTTP request or WebSocket connection wakes it; the client must show a reconnecting state and reload chat history. [Render free-tier behavior](https://render.com/docs/free), [Render WebSockets](https://render.com/docs/websocket)
- Use separate development credentials where practical. Check Atlas storage, Cloudinary usage, Brevo sends, and Render logs during M7. A free-tier deployment is for development and acceptance testing, not a guarantee of uninterrupted service.

## Deployment acceptance

On the deployed URLs, register two accounts, reset one password, upload profile and post images, verify all post audiences through direct media requests, accept and remove a friendship, interact with a Public post, and exchange chat messages. Repeat chat after Render has restarted or slept to verify ticket renewal and history recovery.
