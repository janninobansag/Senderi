# Architecture and API contract

This is the implementation contract for the planned app, not a description of existing code.

## Services and data flow

```text
Browser -> Vercel (React/Vite/Tailwind)
        -> /api/* rewrite -> Render (Express REST + Socket.IO server)
                              -> MongoDB Atlas (records, sessions, limits)
                              -> Cloudinary (image bytes)
                              -> Brevo (reset email)
Browser -> Render Socket.IO endpoint using a short-lived socket ticket
```

The repository will use `client/` for React, `server/` for Express, and `shared/` for TypeScript request and response types. The server owns authorization and all provider secrets. The browser calls REST at same-origin `/api/*`; Vercel rewrites it to Render. Vite's development proxy provides the same `/api/*` behavior locally. Socket.IO connects directly to Render with a one-use ticket obtained over authenticated REST. Vercel supports external-origin rewrites for API traffic: [Vercel rewrites](https://vercel.com/docs/routing/rewrites).

Use an opaque session cookie set through the same-origin API path. Store only a hash of its random value in MongoDB; invalidate the session on logout and password reset. Keep REST responses containing private data and photos uncached (`Cache-Control: private, no-store`).

MongoDB collections: `users`, `sessions`, `friendRequests`, `friendships`, `posts`, `comments`, `likes`, `shares`, `messages`, `passwordResets`, `socketTickets`, and `rateLimits`. Use the native MongoDB driver; store document IDs as BSON ObjectIds and dates as BSON Dates, then serialize IDs as opaque strings and dates as UTC ISO 8601 values in HTTP responses. Normalize emails to trimmed lowercase before storing them. Represent each friendship with lexicographically ordered scalar `userIdLow` and `userIdHigh` ObjectId fields; do not use a unique multikey index on an array of friend IDs. Store Likes with `userId` and `postId`, and make message idempotency unique on `senderId` and `clientId`. Create unique indexes for normalized email, friendship pair, user/post Like, sender/client message ID, and one outstanding password reset per user before the API starts listening. Expiring records in `sessions`, `passwordResets`, `socketTickets`, and `rateLimits` use a BSON Date field named `expiresAt` with a TTL index (`expireAfterSeconds: 0`). TTL cleanup runs asynchronously, so every authorization or token check must also compare `expiresAt` with the current time. Store Cloudinary public IDs and ownership in records, not image bytes. The `avatarId` and `coverId` values are Cloudinary `public_id` values used in delivery URLs, not the immutable `asset_id`. [Cloudinary identifiers](https://cloudinary.com/documentation/upload_parameters).

## Shared HTTP rules

- All routes use `/api`. JSON is the default; image uploads use `multipart/form-data`. Dates are UTC ISO 8601 strings; IDs are opaque strings. Errors use `{ "error": { "code": string, "message": string } }` and appropriate HTTP status (`400`, `401`, `403`, `404`, `409`, `413`, `429`, `500`).
- Visibility values in API and database records are `public`, `friends`, or `onlyMe`; the client presents these as Public, Friends, and Only me.
- All routes except registration, login, forgot password, reset password, and the health check require a valid session. Use generic `404` responses where revealing a hidden post or media record would leak its existence.
- List routes accept `cursor` and `limit` (default 20, maximum 50), ordered newest first, and return `{ items, nextCursor }`. Cursor values are opaque and stable for pagination.
- Mutations check the `Origin` header against the configured client origin and validate input on the server. No browser-provided user ID is trusted as an actor ID.

## REST endpoints

| Endpoint | Input and result | Authorization |
| --- | --- | --- |
| `POST /api/auth/register` | `{ email, password, displayName }` -> session and `{ user }`; trim and lowercase email, trim display name (1–80 characters), require a 12–128 character password | Public; unique normalized email. |
| `POST /api/auth/login` | `{ email, password }` -> session and `{ user }`; unknown email and wrong password share a generic `401`; throttled requests return `429 rate_limited` and `Retry-After` | Public; five failed attempts per normalized email and source IP in a fixed 15-minute window, followed by a 15-minute cooldown. Check limits before account lookup and password verification. |
| `POST /api/auth/logout` | Deletes the current session and clears its cookie -> `204` | Current user. |
| `GET /api/auth/me` | `{ user }` | Current user. |
| `POST /api/auth/forgot-password` | `{ email }` -> generic `202` | Public; normalized-email and source-IP limits run before account lookup. Known and unknown emails get the same `202` body; email/IP throttles return the same `429` for either. |
| `POST /api/auth/reset-password` | `{ token, newPassword }` -> `204` | Valid, unused, unexpired token; atomically consumes the token, hashes the new password, and invalidates existing sessions. Invalid/expired/reused token returns generic `400`; failed-token IP limits return `429`. |
| `POST /api/auth/socket-ticket` | Empty body -> `{ ticket, expiresAt }` | Current user; ticket expires after 60 seconds and is consumed once. |
| `GET /api/users?query=` | Paged user search | Signed in; returns public profile fields only. |
| `GET /api/users/:userId` | `{ user, friendshipStatus }`, where the status is `self`, `friends`, or `none`; `user` includes `avatarUrl`/`coverUrl` when media IDs and the Cloudinary cloud name are configured | Signed in; `friends` requires an accepted friendship record for the viewer and profile owner. |
| `PATCH /api/users/me` | `{ displayName?, bio?, info?: { location?, website? } }` -> profile | Owner only; all fields are length-limited text, and `website` must be a valid HTTPS URL. |
| `PUT /api/users/me/avatar`, `PUT /api/users/me/cover` | One image file -> updated profile | Owner only; replaces the previous asset. |
| `POST /api/friend-requests` | `{ recipientId }` -> request | Signed in; cannot request self, an existing friend, or duplicate pending request. |
| `GET /api/friend-requests` | `{ incoming, outgoing }` | Current user's requests only. |
| `PATCH /api/friend-requests/:requestId` | `{ action: "accept" | "decline" }` -> status | Recipient only; accepted request creates mutual friendship. |
| `GET /api/friends` | Paged accepted friends | Current user. |
| `DELETE /api/friends/:userId` | `204` | Either friend may remove the friendship. |
| `GET /api/posts` | Paged feed of visible posts and shares | Signed in; filter in the database and recheck before returning. |
| `GET /api/users/:userId/posts` | Paged visible posts and shares by user | Signed in; apply current audience. |
| `GET /api/posts/:postId` | Post detail | Viewer must pass current audience check. |
| `POST /api/posts` | Multipart `text?`, `photo?`, `visibility` -> post | Current user; at least text or one photo. Image is uploaded as authenticated Cloudinary media. |
| `PATCH /api/posts/:postId` | `{ visibility }` -> post | Author only; audience changes take effect on all reads. |
| `GET /api/posts/:postId/photo` | Image response | Same current audience check as post; API streams protected Cloudinary media without revealing a reusable provider URL. |
| `PUT /api/posts/:postId/like`, `DELETE /api/posts/:postId/like` | Like/unlike -> count and viewer state | Viewer must pass post audience check; idempotent. |
| `GET /api/posts/:postId/comments` | Paged comments | Viewer must pass post audience check. |
| `POST /api/posts/:postId/comments` | `{ text }` -> comment | Viewer must pass post audience check. |
| `POST /api/posts/:postId/shares` | `{ visibility }` -> share | Source post must currently be Public; share author is current user. |
| `GET /api/chats/:friendId/messages` | Paged message history | Current accepted friends only. |
| `GET /api/health` | `{ status: "ok" }` | Public; no secrets or account data. |

Profile and cover photos are ordinary profile media; post photos use authenticated Cloudinary delivery because audience can change. Profile image delivery URLs use the configured Cloudinary cloud name with optimized `f_auto`/`q_auto` transformations. The client shows a default avatar or cover if an image ID or usable URL is absent. Uploads accept JPEG, PNG, or WebP up to 5 MB after server-side file inspection. Delete replaced assets and abandoned uploads. Cloudinary documents that default `upload` delivery is public, whereas `authenticated` protects originals and derivatives: [Cloudinary access control](https://cloudinary.com/documentation/control_access_to_media).

## Socket.IO contract

The client obtains a socket ticket from `POST /api/auth/socket-ticket`, connects to Render with `auth: { ticket }`, and fetches history through REST after connecting or reconnecting. The server consumes the ticket, binds the connection to its user, and rejects an invalid or expired ticket.

| Event | Payload | Server behavior |
| --- | --- | --- |
| Client `message:send` | `{ friendId, clientId, text }` | Validate accepted friendship and text, persist once using `senderId + clientId`, then acknowledge. |
| Server `message:ack` | `{ clientId, message }` | Sent to sender after persistence; retrying the same client ID returns the same message. |
| Server `message:new` | `{ message }` | Sent to the recipient's active connections after persistence. |
| Server `message:error` | `{ clientId?, code, message }` | Denied, invalid, or failed send; no message is persisted. |

`message` contains `{ id, senderId, recipientId, text, createdAt }`. The server checks friendship on every send, so a removed friend cannot keep sending through an old connection. Message history is the source of truth after disconnects; realtime events are delivery hints, not the only copy of a message.
