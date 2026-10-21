# M7-J2 Deployed Security Acceptance

## Status

The automated local security regressions pass. Deployed acceptance is in progress. The test post `6ad8daed1671e2da5a065336` was changed from Public to Friends and then Only me for the live privacy checks; per the user's instruction, it remains Only me. No account password or reset token has been changed. A reset-link deep-link routing defect was found in Vercel and fixed in the local client config; deployment and live verification are pending.

The target deployment is the Vercel client at `https://senderi.vercel.app`, using the Render API. Local tests verify the route behavior and privacy controls in the current source, but do not establish that the deployed environment has the same configuration or commit.

## Local regression results

| Requirement | Automated evidence | Result |
| --- | --- | --- |
| M7-J2.1: Session expiry and logout | `server/test/auth.test.ts`: expired sessions are denied before MongoDB TTL cleanup; logout revokes the session and clears its cookie. A cross-origin logout regression now confirms a disallowed Origin receives `403` without clearing the cookie or revoking the session. | Pass |
| M7-J2.2: Login/reset abuse controls | `server/test/auth.test.ts`: login email and IP cooldowns; generic known/unknown forgot-password responses; email/IP forgot limits; invalid reset throttling; token reuse and concurrent consumption. | Pass |
| M7-J2.3: Private content access | `server/test/posts.test.ts`: author/friend/outsider audience matrix, current-audience photo bytes, comments after access changes, and denial of hidden-post interactions. `server/test/messages.test.ts` and `server/test/socket.test.ts`: non-friend history denial and friendship-removal denial. | Pass |
| M7-J2.4: Secret exposure and defect review | `server/test/app.test.ts`: exception details are omitted from server logs. `server/test/auth.test.ts`: reset-email delivery failures log only a generic message, without the recipient or reset token. No access-control or secret-logging defect was exposed by these automated checks. | Pass locally; deployed review pending |

The complete server test suite passed after the cross-origin logout and reset-log assertions: 88 tests passed, with no failures. Server lint and typecheck also passed.

## Deployed acceptance still required

Use disposable accounts and an inbox controlled for testing. Login lockouts last 15 minutes, and repeated forgot-password requests can send real reset emails. Do not use an account that someone needs during the test.

| Check | Deployed procedure | Result |
| --- | --- | --- |
| Expiry and logout | Verify logout clears the browser cookie and the same session is denied afterward. Expiry is seven days; an already-expired session can be verified with a disposable session after its expiry or a dedicated test deployment. | Partial pass: Bansag signed out, returned to the login screen, and the same browser received `401 unauthorized` from `/api/auth/me`. The deployed seven-day expiry is not yet measured. The response confirms the session is no longer accepted; the browser cookie itself was not inspected. |
| Cross-origin mutation | Send a state-changing request with an Origin outside the configured client allowlist. Confirm it returns `403` and causes no account, session, or post change. | Partial pass: the live API returned `403 origin_not_allowed` for a cookie-free logout request; see live probe record below. |
| Login and reset limits | With a disposable account and test IP, confirm the fifth failed login triggers `429` and `Retry-After`; verify cooldown recovery. Confirm forgot-password has the same response for known and unknown addresses, rate limits by email/IP, and reset tokens work only once. | Partial: five failed sign-in submissions showed the same generic invalid-credentials message, and one authorized sixth request displayed the login rate-limit response with about 12 minutes to retry. Source defaults are five failures per email/IP in 15 minutes; the fifth failure arms the cooldown, and the sixth observes it. Forgot-password returned the same generic `Check your inbox` message for one unknown address and three known-account submissions. A fourth known-account request showed `Please wait before requesting another password reset` with about seven minutes to retry. After the Vercel fix deployed, the account owner confirmed a fresh reset email link opened the reset form, changed the password, and allowed login with the new password. Reset-token reuse remains pending. |
| Unauthorized viewer | With an author, accepted friend, and outsider, check Friends and Only me posts, direct photo bytes, comments, and chat history. Confirm denial after friendship removal or an audience change. | Pass for current audience checks: a confirmed friend could read the Friends post and photo; Bansag, confirmed not a friend, was denied the Friends and Only me posts, photos, comments, and chat history. Friendship-removal behavior is covered by local regressions. See signed-in follow-ups below. |
| Logs | Review Render logs for the test interval. Confirm no passwords, cookies, reset tokens, reset URLs, or private photo URLs appear. | Partial pass: in Render's Application logs, Last hour view, searches for `secret`, `token`, `cookie`, `password`, and `reset` returned no matching logs during a review at approximately 2026-10-21 16:49-16:54 UTC. The visible startup entries contained routine build/startup messages only. This is limited to that selected log stream and time window; older logs and other log streams were not audited. |

Record the deployment commit, UTC test time, disposable account roles, observed status codes, and any fixes here when those checks are run. Avoid recording passwords, cookies, or raw reset tokens.

## Live API probes

Run against `https://senderi.onrender.com` on 2026-10-21 at approximately 16:03 UTC. These checks did not use a session cookie or modify account data.

| Request | Observed result | Meaning |
| --- | --- | --- |
| `GET /api/health` | `200`, `{"status":"ok"}` | API health endpoint responded. |
| `POST /api/auth/logout` with `Origin: https://attacker.example` and no cookie | `403`, `origin_not_allowed` | Disallowed Origin was rejected by the deployed API before authentication. |
| `GET /api/auth/me` with no cookie | `401` | Session is required. |
| `GET /api/posts/000000000000000000000011/comments` with no cookie | `401` | Session is required before comment lookup. |
| `GET /api/posts/000000000000000000000011/photo` with no cookie | `401` | Session is required before photo lookup or streaming. |
| `GET /api/chats/000000000000000000000012/messages` with no cookie | `401` | Session is required before conversation history lookup. |

The post and user IDs above are synthetic, valid-format IDs. These anonymous probes do not verify access to existing Friends or Only me records as a signed-in outsider. The signed-in audience checks and logout session denial were performed later and are recorded below. Deployed seven-day session expiry, login/reset limits, reset email/token reuse, and Render log review remain untested.

## Signed-in account and outsider probes

Run against the Vercel deployment on 2026-10-21 between approximately 16:18 and 16:33 UTC. Brave exposed three Senderi tabs under the `Personal` browser entry. Their initial page headers showed jan nino bansag, JN bansag, and Bansag.

| Initial account label | Observed result | Meaning |
| --- | --- | --- |
| JN bansag | The Public post showed author audience controls. `My friends` was empty. | This is the author session; there is no accepted-friend account among these three at the time checked. |
| jan nino bansag | JN’s profile displayed `Not friends`; `GET /api/chats/{authorId}/messages?limit=20` returned `conversation_not_found` (route status `404`). | At that point this session was a non-friend and could not read JN’s chat history. |
| Bansag | JN’s profile displayed `Not friends`; the same chat-history request returned `conversation_not_found` (route status `404`). | At that point this session was also a non-friend and could not read JN’s chat history. |

After returning the first two tabs to the app home page, all three tab headers displayed Bansag. Because the tabs are grouped under one Brave Personal browser entry and the account labels changed on re-navigation, separate-session isolation is not confirmed; the initial labels may have reflected changing shared session state. Do not treat these tabs as three stable concurrent roles until each account remains distinct after navigation.

`GET /api/posts?limit=20` as Bansag returned a Public post, its API photo path, and a Public share. At the time of this initial probe, no Friends or Only me post ID was available and no audience had yet been changed. The later role-confirmed Friends and Only me checks below supersede that initial limitation. Firefox is still not exposed as a controllable browser in this session.

## Follow-up: friend access to a Friends post

Run against the Vercel deployment on 2026-10-21 at approximately 16:35-16:40 UTC. The test post `6ad8daed1671e2da5a065336` (`Hello my friends!`) was changed from Public to Friends in the JN author session for this acceptance check. In the connected Brave tab, `GET /api/auth/me` confirmed the signed-in account was jan nino bansag (`6ad8be215b55bd9e466976c9`), and the JN profile displayed Friendship status `Friends` for that viewer. This resolves the earlier uncertainty for this specific session; jan nino bansag is a friend, not an outsider.

| Request as jan nino bansag | Observed result | Meaning |
| --- | --- | --- |
| `GET /api/posts/6ad8daed1671e2da5a065336` | `200`; response contained the post text, `visibility: "friends"`, and photo path. | Expected friend access. |
| `GET /api/posts/6ad8daed1671e2da5a065336/photo` | `200`; browser loaded the image (736 x 473). | Expected friend access to photo bytes. |
| `GET /api/posts/6ad8daed1671e2da5a065336/comments?limit=20` | `200`; `{"items":[],"nextCursor":null}`. | Expected friend access; the post had no comments. |

These results are not outsider-denial evidence. The confirmed non-friend checks for Friends and Only me audiences are recorded in the follow-up sections below; M7-J2.3 is complete based on that combined evidence.

## Follow-up: outsider denial for a Friends post

Run against the Vercel deployment on 2026-10-21 at approximately 16:40-16:42 UTC. The connected Brave tab was manually switched to Bansag. `GET /api/auth/me` confirmed Bansag (`6ad8e482f68ab3be6204a6e0`); the Friends page showed zero friends, and searching for JN bansag showed an `Add friend` action. This confirms Bansag was not JN's friend during the check. The test post remained set to Friends.

| Request as Bansag | Observed result | Meaning |
| --- | --- | --- |
| Home feed | `No posts yet`; JN's Friends post was absent. | Expected feed filtering for an outsider. |
| `GET /api/posts/6ad8daed1671e2da5a065336` | Error `not_found` (`404` from the route). | Direct post read denied. |
| `GET /api/posts/6ad8daed1671e2da5a065336/photo` | Error `not_found` (`404` from the route); no image bytes were returned. | Direct photo request denied before streaming. |
| `GET /api/posts/6ad8daed1671e2da5a065336/comments?limit=20` | Error `not_found` (`404` from the route). | Comments denied with the same current post-view check. |
| `GET /api/chats/6ad8be835b55bd9e466976cb/messages?limit=20` | Error `conversation_not_found` (`404` from the route). | Non-friend chat history denied. |

No access-control defect was exposed by these requests. The Only me non-owner check was completed afterward, as recorded below. Session expiry/logout, deployed login/reset limits and reset-token reuse, and Render log review remain pending.

After these requests, the JN author session changed the same test post from Friends to Only me. The browser confirmed `Audience updated` and the owner control showed `Only me`; Bansag's non-owner checks for this audience are recorded below.

## Follow-up: outsider denial for an Only me post

Run against the Vercel deployment on 2026-10-21 at approximately 16:42-16:44 UTC. The same test post remained owned by JN and was changed to Only me in the JN author session. The connected Brave tab was switched back to Bansag; the page header confirmed Bansag, whose account had zero friends and an `Add friend` action for JN in the preceding check.

| Request as Bansag | Observed result | Meaning |
| --- | --- | --- |
| Home feed | `No posts yet`; JN's Only me post was absent. | Expected owner-only feed visibility. |
| `GET /api/posts/6ad8daed1671e2da5a065336` | Error `not_found` (`404` from the route). | Direct post read denied to a non-owner. |
| `GET /api/posts/6ad8daed1671e2da5a065336/photo` | Error `not_found` (`404` from the route); no image bytes were returned. | Direct photo request denied before streaming. |
| `GET /api/posts/6ad8daed1671e2da5a065336/comments?limit=20` | Error `not_found` (`404` from the route). | Comments denied with the same current post-view check. |

No access-control defect was exposed in the friend, outsider, or Only me checks. M7-J2.3 is complete. Per the user's instruction, the test post remains Only me after the acceptance check.

## Follow-up: logout revokes the deployed session

Run against the Vercel deployment on 2026-10-21 at approximately 16:44 UTC. The signed-in disposable Bansag session used the app's `Sign out` control and returned to `/login`. A subsequent request in the same browser to `GET /api/auth/me` returned `401 unauthorized`. This confirms the logged-out session was no longer accepted. The browser cookie was not inspected, and the deployed seven-day expiry duration was not measured.

## Follow-up: deployed login and forgot-password limits

Run against the Vercel deployment on 2026-10-21 at approximately 16:51-16:55 UTC using the authorized Bansag test account. No real password, reset link, or reset token was entered.

| Check | Observed result | Meaning |
| --- | --- | --- |
| Failed sign-in limit | Five deliberately incorrect sign-in submissions each displayed `Email or password is incorrect.` One authorized sixth submission displayed `Too many login attempts. Please try again later. Try again in about 12 minute(s).` | The current source defaults to five failed attempts per email and IP in 15 minutes, then starts both cooldowns on the fifth failure while returning the ordinary invalid-credentials response. The sixth request confirmed the cooldown. The login cooldown was not bypassed or retried. |
| Unknown-address recovery | One synthetic address not belonging to a Senderi account displayed the generic `Check your inbox` response. | The UI does not reveal whether the address belongs to an account. |
| Known-address recovery | Three authorized known-account submissions displayed the same `Check your inbox` response. | Same user-visible response as the unknown address. Email delivery was not independently verified; the submissions may have sent reset emails. No inbox or reset link was opened. |
| Recovery rate limit | The fourth known-account submission displayed `Please wait before requesting another password reset. Try again in about 7 minute(s).` | The recovery request was rate limited. No further recovery requests were submitted. |
| Reset-token reuse | Not tested. | The account owner must complete one reset and then verify the used link is rejected; no reset token was opened or handled here. |

The account email and all credentials/tokens are intentionally omitted from this record. The test post remains Only me per the user's instruction.

## Follow-up: reset link deep-link routing

On 2026-10-22, the user opened a reset email and showed that its `/reset-password` link returned Vercel's `404 NOT_FOUND` page before the reset form loaded. The link included a reset token; it is intentionally not recorded and should not be reused.

`client/src/App.tsx` already defines the `/reset-password` route. The deployed Vercel configuration in `client/vercel.json` only rewrote `/api/:path*`, so a direct browser request for the client route was handled as a missing static file. A SPA fallback rewrite from `/(.*)` to `/index.html` was added after the API rewrite so API requests keep their existing destination. The client production build and rewrite JSON/order checks passed locally. After deployment, the account owner confirmed a fresh reset email's link loaded the form, changed the password, and allowed login with the new password. The previously exposed token is not recorded. Reuse of the consumed token has not been tested; verify that used link is rejected to complete the reset-token acceptance check.
