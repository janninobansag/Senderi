# Milestones and assignments

Every milestone is required before the first usable release. Each feature owner handles its client, server, documentation updates, and meaningful tests. The other developer reviews the pull request. Milestones are ordered by dependency; no calendar dates are assumed.

Each numbered task below is a reviewable work item. For implementation or documentation tasks, use one pull request, put its ID in the title (for example, `M1-J2: Sessions and login`), and follow [Branch workflow](branch-workflow.md). A task is complete only after its stated check passes, its contract changes are documented, and the other developer approves it. The final release-tag task follows the reviewed implementation.

Use the [task checklist](task-checklist.md) for smaller steps within each task. Checklist items inherit the owner and dependency of their parent task; they can be completed within the same branch and pull request.

| Milestone | Owner | Tasks | Exit check |
| --- | --- | --- | --- |
| M0 — Foundation | Jan and Laica | Jan: Express TypeScript app, MongoDB connection, shared contracts, API validation and error handling. Laica: Vite React TypeScript app, Tailwind, routing, API client, base responsive layout. Together: environment examples, local proxy, CI checks. | Both apps start locally, the client reaches `/api/health`, and CI runs on a pull request. |
| M1 — Accounts | Jan | Registration, login/logout, session storage, password hashing, failed-login limits, forgot/reset flow, Brevo template and send limits. | Two users can register and sign in; reset works once; repeated attempts are throttled; unknown email receives the same reset-request response. |
| M2 — Profiles | Laica | Profile view/edit, bio and information fields, avatar and cover upload/replace, Cloudinary asset cleanup. | Owner edits persist; another user can view; non-owner edits fail. |
| M3 — Friends | Jan | User search, request send/list, accept/decline, friend list, remove, mutual-friend checks. | Pending requests grant no access; accepted friends do; removal revokes access. |
| M4 — Timeline | Laica | Text/photo composer, chronological feed, author timeline, Public/Friends/Only me visibility, post audience edit, protected photo delivery. | All three audiences work for feed, direct links, and photo bytes before and after audience changes. |
| M5 — Interactions | Jan | Like/unlike, comment list/add, Public-post share creation and display, source-visibility recheck. | Only visible posts accept interactions; duplicate Likes are prevented; a now-hidden source disappears from shares. |
| M6 — Chat | Laica | One-to-one Socket.IO text messaging, MongoDB history, ticket auth, friend checks on send, reconnect and missed-history load. | Two friends exchange persistent live messages; duplicates are avoided; non-friends and removed friends cannot send. |
| M7 — Release integration | Jan and Laica | Jan: Render, Atlas, Brevo, secrets, security checks. Laica: Vercel, Cloudinary, responsive interface, upload checks. Both: end-to-end acceptance and release review. | Every product acceptance journey passes on the deployed free-tier stack; tag `v1.0.0`. |

## M0 — Foundation

| Task | Owner | Work | Done when |
| --- | --- | --- | --- |
| M0-J1 | Jan | Create `server/` with Express and TypeScript, validation and error middleware, `/api/health`, and development scripts. | The API starts locally; health and malformed-input responses match the API contract. |
| M0-L1 | Laica | Create `client/` with React, Vite, Tailwind, routing, and a responsive page shell. | The app builds and renders on desktop and mobile widths. |
| M0-J2 | Jan | Add `shared/` request/response types, MongoDB connection, model/index conventions, server environment example, and safe startup failure on missing config. Depends on M0-J1. | Server type-checks, connects to a development database, and reports a clear configuration error when required values are absent. |
| M0-L2 | Laica | Add the typed API client, same-origin `/api` calls, local Vite proxy, loading/error UI, and client environment example. Depends on M0-L1 and M0-J2. | The client reaches `/api/health` locally without a hard-coded backend URL. |
| M0-J3 | Jan | Add pull-request CI for type checks, lint, builds, and available tests; document commands and update the variable table. Depends on M0-J2 and M0-L2. | A pull request receives a passing CI result for both apps. |

## M1 — Accounts

| Task | Owner | Work | Done when |
| --- | --- | --- | --- |
| M1-J1 | Jan | Add the user model, normalized unique email, input validation, Argon2id hashing, and signup endpoint. Depends on M0. | A valid signup creates one account; duplicate email and invalid input are rejected; no plaintext password is stored. |
| M1-J2 | Jan | Add MongoDB-backed sessions, secure cookie handling, login, logout, and `/api/auth/me`. Depends on M1-J1. | A user stays signed in after refresh, and logout or expiry removes access. |
| M1-J3 | Jan | Add MongoDB-backed failed-login counters and retry responses from the [security policy](security.md). Depends on M1-J2. | Repeated failures are limited per email and IP; a successful login remains possible after cooldown. |
| M1-J4 | Jan | Add single-use, 15-minute reset tokens, Brevo sending, generic forgot-password responses, reset limits, and session invalidation. Depends on M1-J2. | A known account can reset once; unknown emails have the same request response; limits prevent excess sends. |
| M1-J5 | Jan | Build signup, login, logout, forgot-password, and reset screens with validation and error states. Depends on M1-J2 through M1-J4. | A user completes the full account journey in the browser, including an expired-link state and a login-limit response. |

## M2 — Profiles

| Task | Owner | Work | Done when |
| --- | --- | --- | --- |
| M2-L1 | Laica | Add profile read/edit data and routes for display name, bio, location, and HTTPS website. Depends on M1-J2. | A signed-in user can read profiles; only the owner can edit; invalid fields are rejected. |
| M2-L2 | Laica | Build the profile page and edit form with loading, validation, and save states. Depends on M2-L1. | Edited text appears after refresh and to another signed-in user. |
| M2-L3 | Laica | Add validated avatar and cover uploads to Cloudinary, persist asset IDs, and clean up replaced or failed uploads. Depends on M2-L1. | Images survive a server restart; replacing one removes the old asset without affecting other profile data. |
| M2-L4 | Laica | Add avatar/cover controls and responsive display; verify owner-only upload behavior. Depends on M2-L3. | Both images can be changed in the browser; another user cannot replace them. |

## M3 — Friends

| Task | Owner | Work | Done when |
| --- | --- | --- | --- |
| M3-J1 | Jan | Add paged user search and send/list friend requests with duplicate, self, and existing-friend checks. Depends on M1-J2. | Two users can exchange one pending request; invalid or duplicate requests fail predictably. |
| M3-J2 | Jan | Add accept/decline, mutual friendship records, friend listing/removal, and a shared accepted-friend check. Depends on M3-J1. | Only the recipient acts on a request; acceptance grants friendship and removal revokes it. |
| M3-J3 | Jan | Build search, incoming/outgoing request, and friend-list UI with status and error states. Depends on M3-J2. | Users can complete the full request-to-removal journey in the browser. |

## M4 — Timeline and privacy

| Task | Owner | Work | Done when |
| --- | --- | --- | --- |
| M4-L1 | Laica | Add post records, Public/Friends/Only me authorization, paged feed, author timeline, and direct post read. Depends on M1-J2 and M3-J2. | Author, friend, and non-friend each see exactly the posts allowed by the current audience. |
| M4-L2 | Laica | Add text-post creation and the timeline composer, feed cards, loading, and pagination. Depends on M4-L1. | A signed-in user publishes text and sees it in the correct feeds after refresh. |
| M4-L3 | Laica | Add one-photo upload, file inspection, Cloudinary authenticated storage, API-authorized photo streaming, and cleanup on failed writes. Depends on M4-L1. | Photo bytes survive Render restart and cannot be fetched by a viewer denied access to the post. |
| M4-L4 | Laica | Add photo composer, audience selector/edit control, and privacy regression checks for feed, direct post, and image requests. Depends on M4-L2 and M4-L3. | Changing audience immediately changes access for all three paths, including an old photo link. |

## M5 — Interactions

| Task | Owner | Work | Done when |
| --- | --- | --- | --- |
| M5-J1 | Jan | Add idempotent Like/unlike routes, count and viewer state, and the Like button. Depends on M4-L1. | One user contributes at most one Like and cannot Like a hidden post. |
| M5-J2 | Jan | Add paged text comments, comment creation, and the comment UI. Depends on M4-L1. | Visible posts accept and show comments; hidden posts reveal no comments. |
| M5-J3 | Jan | Add shares with their own audience, a Public-only source rule, and share cards in feed/profile views. Depends on M4-L1. | A share displays the original only while the source is Public and the share viewer is allowed. |
| M5-J4 | Jan | Test interaction authorization after friendship removal and source audience changes. Depends on M5-J1 through M5-J3. | Old links, Likes, comments, and shares do not expose a post after access is revoked. |

## M6 — Realtime chat

| Task | Owner | Work | Done when |
| --- | --- | --- | --- |
| M6-L1 | Laica | Add persisted message records, ordered paged history, and friend-only history authorization. Depends on M3-J2. | Friends can reload conversation history; non-friends cannot fetch it. |
| M6-L2 | Laica | Add one-use socket tickets, authenticated Socket.IO connections, friend check on each send, persistence before emit, and idempotent client IDs. Depends on M6-L1. | Two connected friends receive a live text message once; an invalid ticket or removed friend cannot send. |
| M6-L3 | Laica | Build friend conversation list, text composer, connection state, retry/ack handling, and history reload after reconnect. Depends on M6-L2. | The browser recovers missed messages after a disconnect without duplicates. |
| M6-L4 | Laica | Verify chat after Render restart and friendship removal, including multiple tabs. Depends on M6-L3. | History remains complete and revoked users lose send and history access. |

## M7 — Deployment and release

| Task | Owner | Work | Done when |
| --- | --- | --- | --- |
| M7-J1 | Jan | Deploy Express/Socket.IO to Render; configure Atlas, Brevo, exact client origins, secrets, and health monitoring. Depends on M1 through M6. | Deployed API serves authenticated routes and can send a real reset email without exposing secrets. |
| M7-L1 | Laica | Deploy the Vite client to Vercel; configure the `/api` rewrite, Cloudinary flow, socket URL, and responsive layout. Depends on M7-J1. | The deployed browser completes image upload and realtime chat on mobile and desktop widths. |
| M7-J2 | Jan | Run security checks for sessions, rate limits, reset-token reuse, friend authorization, and media access on the deployed stack. Depends on M7-J1 and M7-L1. | Each denied path returns the expected response and no private photo URL bypasses authorization. |
| M7-L2 | Laica | Run the full [product acceptance journey](product-requirements.md#product-acceptance-journey), including idle/reconnect behavior and error states. Depends on M7-J1 and M7-L1. | The journey passes on Vercel, Render, Atlas, Cloudinary, and Brevo. |
| M7-B1 | Jan and Laica | Review open defects, confirm both checks, update setup docs, and tag `v1.0.0` from `main`. Depends on M7-J2 and M7-L2. | No release-blocking defect remains and the tag points to the verified commit. |

## Dependency and review order

M0 precedes all feature work. M1 provides identities and sessions for M2–M6. M3 precedes Friends audience and chat acceptance. M4 precedes M5. Jan and Laica can work concurrently on tasks whose listed dependencies are on `main`.

For each pull request, the owner records the user-visible behavior, API or schema changes, test evidence, and any deployment variables. The reviewer checks authorization paths and the matching client/server contract before approval. Update the relevant documents in `doc/` whenever behavior changes.
