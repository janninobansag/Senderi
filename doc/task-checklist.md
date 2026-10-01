# Detailed task checklist

This checklist breaks down the 34 reviewable tasks in [Milestones and assignments](milestones.md). The ID before the decimal identifies the parent task and its owner. Complete the small steps in order where one depends on another; keep the parent task's acceptance check as the merge gate. Checkboxes start empty because the application has not been implemented.

## M0 — Foundation

### M0-J1 — Jan: Express foundation

- [x] **M0-J1.1** Create the `server/` package, TypeScript configuration, and development/build/start scripts.
- [x] **M0-J1.2** Create the Express app and `/api/health` route with JSON output.
- [x] **M0-J1.3** Add request validation and a single error-response format from the [API contract](architecture-api.md#shared-http-rules).
- [x] **M0-J1.4** Verify health success and malformed-request errors locally.

### M0-L1 — Laica: React foundation

- [x] **M0-L1.1** Create the `client/` package with React, Vite, and TypeScript scripts.
- [x] **M0-L1.2** Configure Tailwind and establish colors, spacing, and typography used by the page shell.
- [x] **M0-L1.3** Add routes and a responsive navigation/page layout with placeholder views.
- [x] **M0-L1.4** Verify the client build and layouts at narrow and wide viewport widths.

### M0-J2 — Jan: Shared contracts and data connection

- [x] **M0-J2.1** Create `shared/` with common user, API error, pagination, and visibility types.
- [x] **M0-J2.2** Add MongoDB connection startup and shutdown handling; fail startup clearly if connection or required configuration fails.
- [x] **M0-J2.3** Set model/index conventions, including unique and TTL indexes called for in [Architecture and API](architecture-api.md#services-and-data-flow).
- [x] **M0-J2.4** Add `server/.env.example` with variable names and no credentials; verify type checking.

### M0-L2 — Laica: Client API connection

- [x] **M0-L2.1** Configure Vite to proxy `/api` to the local Express server.
- [x] **M0-L2.2** Add a typed fetch wrapper that sends cookies and parses the shared API error format.
- [x] **M0-L2.3** Add reusable loading, empty, and request-error states for feature pages.
- [x] **M0-L2.4** Add `client/.env.example` and verify the client can show a response from `/api/health`.

### M0-J3 — Jan: Pull-request checks

- [x] **M0-J3.1** Add scripts for client/server type checks, lint, builds, and available tests.
- [x] **M0-J3.2** Add a GitHub Actions pull-request workflow that runs those scripts.
- [x] **M0-J3.3** Update [Setup and deployment](setup-deployment.md) with exact local commands and any new variables.
- [x] **M0-J3.4** Open a test pull request and confirm CI reports success or a clear failure. *(GitHub Actions passed: Client and server quality.)*

## M1 — Accounts

### M1-J1 — Jan: Registration

- [x] **M1-J1.1** Define user fields and the unique normalized-email index.
- [x] **M1-J1.2** Validate signup input, including display name and the password rules in [Security](security.md#passwords-sessions-and-reset).
- [x] **M1-J1.3** Hash the password with Argon2id and implement `POST /api/auth/register` without returning the hash.
- [x] **M1-J1.4** Check successful signup, duplicate email, invalid input, and stored-record contents.

### M1-J2 — Jan: Sessions and login

- [x] **M1-J2.1** Define the session record, random cookie token, token hash, and seven-day expiry.
- [x] **M1-J2.2** Implement password verification and `POST /api/auth/login`; set the HTTP-only session cookie.
- [x] **M1-J2.3** Implement session middleware, `GET /api/auth/me`, and `POST /api/auth/logout`.
- [x] **M1-J2.4** Check refresh persistence, expired session denial, logout invalidation, and wrong-password behavior.

### M1-J3 — Jan: Login abuse limits

- [x] **M1-J3.1** Define MongoDB-backed counters for normalized email and source IP, with expiry.
- [x] **M1-J3.2** Apply the five-failure/15-minute policy before expensive password verification.
- [x] **M1-J3.3** Return the documented limit response and `Retry-After`; clear or expire counters after cooldown.
- [x] **M1-J3.4** Check both email and IP limits and successful login after cooldown.

### M1-J4 — Jan: Forgot and reset password

- [x] **M1-J4.1** Create a 15-minute reset-token record storing only a hash; make consumption atomic.
- [x] **M1-J4.2** Add forgot-password counters per email/IP and the development-wide Brevo send cap.
- [x] **M1-J4.3** Configure the Brevo sender/template and send a reset link only for a known account, while returning the same outward response for known and unknown emails.
- [x] **M1-J4.4** Implement reset-token verification, new password hashing, token consumption, and session invalidation.
- [x] **M1-J4.5** Check expired, reused, and invalid tokens; provider failure; and rate limits without account-existence leakage.

### M1-J5 — Jan: Account screens

- [x] **M1-J5.1** Add signup and login forms with field validation and server-error display.
- [x] **M1-J5.2** Restore user state through `/api/auth/me` on page load and add logout.
- [x] **M1-J5.3** Add forgot-password and reset-password forms with sent, expired, invalid, and throttled states.
- [x] **M1-J5.4** Complete the browser journey from signup through logout, login, reset, and login with the new password. *(Manually verified: registered an account, logged in, received the reset email, reset the password, and logged in with the new password.)*

## M2 — Profiles

### M2-L1 — Laica: Profile data and API

- [ ] **M2-L1.1** Add display name, bio, location, website, avatar ID, and cover ID to the profile model and shared response type.
- [ ] **M2-L1.2** Implement signed-in profile read and owner-only text edit routes.
- [ ] **M2-L1.3** Validate field lengths and require an HTTPS URL for website.
- [ ] **M2-L1.4** Check owner success, non-owner denial, and invalid-field responses.

### M2-L2 — Laica: Profile screens

- [ ] **M2-L2.1** Show profile name, bio, information, avatar, cover, and friendship status.
- [ ] **M2-L2.2** Show edit controls only for the current user's profile.
- [ ] **M2-L2.3** Save text changes with loading, validation, and failure feedback.
- [ ] **M2-L2.4** Check edits after refresh and from another signed-in account.

### M2-L3 — Laica: Profile image storage

- [ ] **M2-L3.1** Validate avatar and cover file type/content and the 5 MB size limit on the server.
- [ ] **M2-L3.2** Upload the accepted image to Cloudinary and save its asset ID to the correct profile field.
- [ ] **M2-L3.3** Delete the old asset after successful replacement and the new asset if the database update fails.
- [ ] **M2-L3.4** Check upload, replacement, invalid file, and persistence after server restart.

### M2-L4 — Laica: Profile image controls

- [ ] **M2-L4.1** Add avatar and cover pickers, previews, progress, and error messages.
- [ ] **M2-L4.2** Render both images in the profile layout at mobile and desktop widths.
- [ ] **M2-L4.3** Hide controls from non-owners and verify the API also rejects their upload attempts.
- [ ] **M2-L4.4** Check replacement in the browser without stale images after refresh.

## M3 — Friends

### M3-J1 — Jan: Search and requests

- [ ] **M3-J1.1** Add paged user search returning public profile fields, excluding secrets.
- [ ] **M3-J1.2** Add friend-request records and send route with self, duplicate, and existing-friend checks.
- [ ] **M3-J1.3** Add incoming and outgoing request listing for the current user.
- [ ] **M3-J1.4** Check search pagination and request creation/denial with two accounts.

### M3-J2 — Jan: Friendship state

- [ ] **M3-J2.1** Add recipient-only accept and decline actions with a single mutual-friendship record.
- [ ] **M3-J2.2** Add friend listing and removal by either friend.
- [ ] **M3-J2.3** Expose a reusable `areFriends` check for post access and chat.
- [ ] **M3-J2.4** Check pending, declined, accepted, and removed states, including concurrent duplicate acceptance.

### M3-J3 — Jan: Friend screens

- [ ] **M3-J3.1** Add user search results with the correct request/friend status control.
- [ ] **M3-J3.2** Add incoming and outgoing request views with accept/decline actions.
- [ ] **M3-J3.3** Add a friend list and remove action with success/error feedback.
- [ ] **M3-J3.4** Complete send, accept, view, and remove in the browser using two accounts.

## M4 — Timeline and privacy

### M4-L1 — Laica: Posts and audience checks

- [ ] **M4-L1.1** Define post records, visibility values, author relationship, and newest-first pagination.
- [ ] **M4-L1.2** Implement central post-view authorization for Public, Friends, and Only me.
- [ ] **M4-L1.3** Add paged feed, author timeline, and direct-post read using that check.
- [ ] **M4-L1.4** Check all three viewer roles against all three audiences and direct URLs.

### M4-L2 — Laica: Text posts and feed

- [ ] **M4-L2.1** Add text-only post creation with server validation and author attribution.
- [ ] **M4-L2.2** Add the composer with text input and an audience selector.
- [ ] **M4-L2.3** Render posts in feed and author timeline with loading, empty, and next-page states.
- [ ] **M4-L2.4** Check create and refresh across two accounts with different visibility settings.

### M4-L3 — Laica: Protected post photos

- [ ] **M4-L3.1** Accept one JPEG/PNG/WebP photo up to 5 MB after server-side inspection.
- [ ] **M4-L3.2** Upload as a Cloudinary `authenticated` asset and save only its asset ID in MongoDB.
- [ ] **M4-L3.3** Stream photo bytes from the API only after the same current post-view check; disable shared caching.
- [ ] **M4-L3.4** Clean up failed uploads and check blocked direct photo requests and restart persistence.

### M4-L4 — Laica: Photo composer and privacy edits

- [ ] **M4-L4.1** Add a photo picker, preview, upload feedback, and text-plus-photo publishing.
- [ ] **M4-L4.2** Add an author-only audience edit control and persist changes.
- [ ] **M4-L4.3** Refresh feed and post cards after an audience change.
- [ ] **M4-L4.4** Recheck feed, direct post, and old photo URL access after switching each audience.

## M5 — Interactions

### M5-J1 — Jan: Like

- [ ] **M5-J1.1** Create a unique user/post Like record and idempotent add/remove routes.
- [ ] **M5-J1.2** Return Like count and current-viewer state with visible post responses.
- [ ] **M5-J1.3** Add a Like/unlike button with pending and failure feedback.
- [ ] **M5-J1.4** Check duplicate clicks, two-user counts, and hidden-post denial.

### M5-J2 — Jan: Comments

- [ ] **M5-J2.1** Define text comment records, length validation, and newest-first pagination.
- [ ] **M5-J2.2** Add list/create routes that call the current post-view check.
- [ ] **M5-J2.3** Add comment list, composer, and loading/error states on post cards or detail.
- [ ] **M5-J2.4** Check pagination and denial after a post changes from Public to Only me.

### M5-J3 — Jan: Shares

- [ ] **M5-J3.1** Define share records with author, source post, audience, and timestamp.
- [ ] **M5-J3.2** Add a share route that accepts only a currently Public source.
- [ ] **M5-J3.3** Include share cards in feed/profile reads only when both share audience and source Public status pass.
- [ ] **M5-J3.4** Add the share UI and check source-audience changes do not leak content.

### M5-J4 — Jan: Interaction authorization regression

- [ ] **M5-J4.1** Check Likes and comments on a Friends post before and after friend removal.
- [ ] **M5-J4.2** Check direct interaction routes on a post changed to Only me.
- [ ] **M5-J4.3** Check a share after its source changes from Public to Friends.
- [ ] **M5-J4.4** Record the tested viewer matrix and any fixed defects in the pull request.

## M6 — Realtime chat

### M6-L1 — Laica: Stored messages

- [ ] **M6-L1.1** Define message records with sender, recipient, text, creation time, and client ID.
- [ ] **M6-L1.2** Add indexed, paged conversation history in stable message order.
- [ ] **M6-L1.3** Require current accepted friendship before returning history.
- [ ] **M6-L1.4** Check friend history and non-friend denial with two accounts.

### M6-L2 — Laica: Socket server

- [ ] **M6-L2.1** Add one-use, 60-second socket-ticket issuance and consumption tied to a session user.
- [ ] **M6-L2.2** Authenticate socket connections and bind them to that user; reject invalid origin or ticket.
- [ ] **M6-L2.3** On `message:send`, validate text and current friendship, persist once by sender/client ID, then send ack/new events.
- [ ] **M6-L2.4** Check invalid ticket, duplicate send, offline recipient, and friend removal during an open socket.

### M6-L3 — Laica: Chat client

- [ ] **M6-L3.1** Add a friend conversation list and paged message view.
- [ ] **M6-L3.2** Add text compose/send with stable client IDs and pending, acknowledged, and failed states.
- [ ] **M6-L3.3** Renew a socket ticket and reconnect after interruption, then reload missed history.
- [ ] **M6-L3.4** Check no duplicate messages after a retry or reconnect.

### M6-L4 — Laica: Chat resilience

- [ ] **M6-L4.1** Exchange messages, restart or let Render sleep, reconnect, and compare stored history with the UI.
- [ ] **M6-L4.2** Remove friendship while chat is open and check send and history are denied.
- [ ] **M6-L4.3** Open multiple tabs for one user and check delivery without duplicate persisted messages.
- [ ] **M6-L4.4** Document any free-tier reconnect delay seen during acceptance.

## M7 — Deployment and release

### M7-J1 — Jan: API deployment

- [ ] **M7-J1.1** Create/configure the Atlas database user and Render web service with build/start commands.
- [ ] **M7-J1.2** Set server secrets, exact client origins, Brevo sender/template, and Cloudinary credentials in Render.
- [ ] **M7-J1.3** Confirm health, signup/login, a real reset email, and Socket.IO connection on the deployed API.
- [ ] **M7-J1.4** Confirm logs omit secrets and that the service recovers from an idle start.

### M7-L1 — Laica: Client deployment

- [ ] **M7-L1.1** Deploy the Vite build to Vercel and configure the versioned `/api` rewrite to Render.
- [ ] **M7-L1.2** Configure the public socket endpoint and verify cookie-based REST through the Vercel origin.
- [ ] **M7-L1.3** Verify profile and protected post image flows against Cloudinary from the deployed browser.
- [ ] **M7-L1.4** Check primary screens on mobile and desktop widths and fix blocked interactions.

### M7-J2 — Jan: Deployed security checks

- [ ] **M7-J2.1** Check session expiry/logout and cross-origin mutation rejection.
- [ ] **M7-J2.2** Check login and reset limits, generic forgot-password behavior, and reset-token reuse.
- [ ] **M7-J2.3** Check friend-only and Only me posts, direct photo bytes, comments, and chat history as an unauthorized viewer.
- [ ] **M7-J2.4** Record results and fix any access or secret-exposure defects before release.

### M7-L2 — Laica: Deployed product journey

- [ ] **M7-L2.1** Register three accounts and complete profile, friend request, acceptance, and removal flows.
- [ ] **M7-L2.2** Publish text/photo posts at every audience and try Like, comment, and Public share.
- [ ] **M7-L2.3** Exchange messages, interrupt the connection, and confirm missed-history recovery.
- [ ] **M7-L2.4** Repeat error states and critical paths on narrow and wide viewports; record defects.

### M7-B1 — Jan and Laica: Release gate

- [ ] **M7-B1.1** Review and close release-blocking defects from M7-J2 and M7-L2.
- [ ] **M7-B1.2** Update setup/deployment instructions to match the running services and environment names.
- [ ] **M7-B1.3** Confirm the verified commit is merged to `main` with required review and CI.
- [ ] **M7-B1.4** Create annotated tag `v1.0.0` on that commit and record the release checks.
