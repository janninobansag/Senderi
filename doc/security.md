# Security and abuse controls

These rules are part of the first-release acceptance criteria and apply to the API and Socket.IO server, not only to client controls.

## Passwords, sessions, and reset

- Hash passwords with Argon2id and a per-password salt; never store reversible passwords or log submitted passwords. Enforce 12–128 characters to prevent resource abuse while allowing long passphrases.
- Issue a cryptographically random, opaque session token in an `HttpOnly`, `Secure`, `SameSite=Lax` cookie for the Vercel same-origin `/api` path. Store only its hash in MongoDB; expire sessions after seven days. For local HTTP development, omit `Secure` while keeping `HttpOnly` and `SameSite=Lax`.
- Require a session for profile, social, media, and chat-history routes. Reject state-changing requests whose `Origin` is not in the exact `CLIENT_ORIGINS` allowlist. Socket.IO connections use one-use, 60-second tickets issued to an authenticated session; check the client origin as well.
- Forgot-password returns the same generic `202` response for a known or unknown email. Apply the email and IP counters before account lookup; their `429` response is also independent of account existence. For a known account, generate a cryptographically random token, store only its hash, expire it in 15 minutes, send one Brevo email, and atomically consume it on reset. Keep at most one outstanding token per account and invalidate that user's existing sessions. Do not place raw tokens in logs.

## Rate limits

Use MongoDB-backed, expiring counters so limits survive a Render restart. Counter IDs contain a SHA-256 digest of the email or IP rather than the raw value. Login failures use fixed UTC 15-minute windows; a fifth failed attempt also starts a separate 15-minute cooldown for that normalized email and source IP. Check cooldowns before account lookup and password verification, and return `429` with the remaining cooldown in `Retry-After`. Successful login attempts do not consume failure quota. Forgot-password limits use fixed UTC-hour windows, the development send cap uses a UTC-day window, and reset-token failures use fixed UTC 15-minute windows. Configure Express's trusted proxy hop count for the actual deployment path before relying on source-IP limits; never trust forwarded headers from unverified hops. Apply limits before expensive password verification or Brevo calls. Run forgot-password counters before account lookup so its status never reveals whether an account exists. MongoDB TTL cleanup is asynchronous, so reject only while a stored cooldown's `expiresAt` is still in the future.

| Action | Application limit |
| --- | --- |
| Login | Five failed attempts per normalized email **and** per source IP in a fixed 15-minute window; the fifth failure starts a 15-minute cooldown. Limited attempts return `429 rate_limited` with `Retry-After`. |
| Forgot-password request | Three requests per normalized email **and** per source IP per hour, plus a global cap of 100 Brevo reset emails per day for the development deployment. |
| Reset-token verification | Five failed token submissions per source IP in 15 minutes. |

The exact counters and cap are initial development defaults. Review them before a wider launch. Brevo's provider limits and daily plan quota are separate controls; handle provider `429` and send failures without exposing account existence. [Brevo API limits](https://developers.brevo.com/docs/api-limits), [Brevo free-plan quota](https://help.brevo.com/hc/en-us/articles/208589409-About-Brevo-s-pricing-plans).

## Authorization and media

- Centralize `canViewPost(viewer, post)` and use it for feed queries, direct post reads, Likes, comments, shares, and photo delivery. Only the author changes audience. Check share visibility and the original post's current Public status on every share read.
- Friendship is accepted and mutual before it grants access. Recheck it for each chat send and history request. Treat IDs from the browser as lookup targets, never as proof of identity.
- Upload post photos as Cloudinary `authenticated` assets. The API validates session and audience, then streams the image; never return a permanent provider URL for restricted media. Ordinary Cloudinary `upload` assets are public by default. [Cloudinary media access](https://cloudinary.com/documentation/control_access_to_media).
- Inspect image type and size on the server, allow JPEG/PNG/WebP up to 5 MB, and reject other content. Keep Cloudinary and Brevo credentials only on the server. Delete superseded assets and remove an uploaded asset if its database write fails.
- Do not cache private API or image responses in a shared CDN or service worker. Avoid logging message text, reset tokens, session values, or private image URLs.
