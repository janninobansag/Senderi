# Repository Guidelines

## Project Structure

Senderi is a TypeScript MERN application split into three areas:

- `client/` contains the React/Vite browser app, pages, components, API client, and styles.
- `server/src/` contains the Express API, authentication, MongoDB access, routes, middleware, and media integrations.
- `server/test/` contains Node's built-in test-runner tests using Supertest; `shared/` contains shared TypeScript contracts.
- `doc/` contains the architecture, API, security, deployment, milestone, and branch-workflow requirements.

## Build, Test, and Development Commands

Run commands from the repository root. Install dependencies with `npm ci --prefix client` and `npm ci --prefix server`.

- `npm run dev` starts the API and Vite client together; `npm run dev:server` and `npm run dev:client` start them separately.
- `npm run lint --prefix client` and `npm run lint --prefix server` run ESLint with zero warnings allowed.
- `npm run typecheck --prefix client` and `npm run typecheck --prefix server` run strict TypeScript checks.
- `npm run build --prefix client` and `npm run build --prefix server` produce deployable builds.
- `npm test --prefix server` runs the server and profile-image tests. Set `MONGODB_TEST_URI` for the persistence test; use a dedicated test database.

## Coding Style and Naming

Use strict TypeScript, two-space indentation, semicolons, and the existing ESLint configuration. Use `camelCase` for functions and variables, `PascalCase` for React components and types, and descriptive kebab-case filenames such as `error-handler.ts`. Keep shared request/response contracts in `shared/index.ts`; keep secrets in ignored `.env` files.

## Testing Guidelines

Add focused tests under `server/test/` with descriptive `test("...")` names. Cover success, validation, authorization, persistence, and cleanup behavior. Run lint, type checks, builds, and `npm test` before opening a pull request. There are currently no client test scripts.

## Commits and Pull Requests

Use concise Conventional Commit-style subjects, for example `feat(profile): add image upload` or `test(auth): cover expired sessions`. Open one short-lived task branch from current `main`, use the exact branch in `doc/branch-map.md`, and target `main`. Describe behavior and contract changes, link the milestone or task, include test evidence, and attach browser screenshots when UI behavior changes. Keep credentials out of commits, PRs, and CI logs. Merge only after review approval and passing CI.
