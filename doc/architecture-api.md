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

MongoDB collections: `users`, `sessions`, `friendRequests`, `friendships`, `posts`, `comments`, `likes`, `shares`, `messages`, `passwordResets`, `socketTickets`, and `rateLimits`. Use the native MongoDB driver; store document IDs as BSON ObjectIds and dates as BSON Dates, then serialize IDs as opaque strings and dates as UTC ISO 8601 values in HTTP responses. Normalize emails to trimmed lowercase before storing them. Represent each friendship and friend request with lexicographically ordered scalar `userIdLow` and `userIdHigh` ObjectId fields; do not use a unique multikey index on an array of friend IDs. Friend requests retain `senderId`, `recipientId`, `status`, and `createdAt`; a partial unique index on the canonical pair where status is `pending` prevents duplicate or opposite-direction pending requests. Store Likes with `userId` and `postId`, and make message idempotency unique on `senderId` and `clientId`. Create unique indexes for normalized email, friendship pair, one pending friend request per pair, user/post Like, sender/client message ID, and one outstanding password reset per user before the API starts listening. Expiring records in `sessions`, `passwordResets`, `socketTickets`, and `rateLimits` use a BSON Date field named `expiresAt` with a TTL index (`expireAfterSeconds: 0`). TTL cleanup runs asynchronously, so every authorization or token check must also compare `expiresAt` with the current time. Store Cloudinary public IDs and ownership in records, not image bytes. The `avatarId` and `coverId` values are Cloudinary `public_id` values used in delivery URLs, not the immutable `asset_id`. [Cloudinary identifiers](https://cloudinary.com/documentation/upload_parameters).

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
| `GET /api/users?query=<1-80 chars>&cursor=&limit=` | `{ items: User[], nextCursor }`, newest first; cursor pagination defaults to 20 results and caps at 50 | Signed in; searches display names, excludes the current user, and returns public profile fields only. Invalid search parameters return `400`. |
| `GET /api/users/:userId` | `{ user, friendshipStatus }`, where the status is `self`, `friends`, or `none`; `user` includes `avatarUrl`/`coverUrl` when media IDs and the Cloudinary cloud name are configured | Signed in; `friends` requires an accepted friendship record for the viewer and profile owner. |
| `PATCH /api/users/me` | `{ displayName?, bio?, info?: { location?, website? } }` -> profile | Owner only; all fields are length-limited text, and `website` must be a valid HTTPS URL. |
| `PUT /api/users/me/avatar`, `PUT /api/users/me/cover` | One image file -> updated profile | Owner only; replaces the previous asset. |
| `POST /api/friend-requests` | `{ recipientId }` -> `{ request: FriendRequest }` with `201` | Signed in; self is `400`, unknown recipient is `404`, and existing friendship or either-direction duplicate pending request is `409`. |
| `GET /api/friend-requests` | `{ incoming: FriendRequest[], outgoing: FriendRequest[] }` | Signed in; returns only the current user's pending requests. |
| `PATCH /api/friend-requests/:requestId` | `{ action: "accept" | "decline" }` -> `{ request: FriendRequest }` | Recipient only; only pending requests can be resolved. The pending-to-resolved transition is conditional, so concurrent responses have one winner; acceptance creates one canonical mutual-friendship record. |
| `GET /api/friends?cursor=&limit=` | `{ items: User[], nextCursor }`, newest friendships first; defaults to 20 and caps at 50 | Current user; returns public profile fields only. |
| `DELETE /api/friends/:userId` | `204` | Either friend may remove the canonical friendship record; repeated removal is safe. |
| `GET /api/posts` | Paged feed of visible posts and shares, including `likeCount` and `isLikedByViewer` for each post | Signed in; filter in the database and recheck before returning. |
| `GET /api/users/:userId/posts` | Paged visible posts and shares by user, including `likeCount` and `isLikedByViewer` | Signed in; apply current audience. |
| `GET /api/posts/:postId` | Post detail with Like count and viewer state | Viewer must pass current audience check. |
| `POST /api/posts` | JSON `{ text, visibility }` or multipart `text`, `visibility`, and optional `file` -> post | Signed in; derives the author from the current session. Multipart photos are inspected and uploaded as authenticated assets before inserting the post; failed inserts clean up the uploaded asset. |
| `PATCH /api/posts/:postId` | `{ visibility }` -> post | Author only; requires an allowed Origin and persists the new audience. Feed, direct reads, and photo reads apply it immediately. |
| `PUT /api/posts/:postId/photo` | One multipart `file` -> post | Author only; one JPEG, PNG, or WebP up to 5 MB, inspected on the server and stored as an authenticated Cloudinary asset. |
| `GET /api/posts/:postId/photo` | Image byte stream | Signed in; rechecks the post's current audience and streams protected Cloudinary media without revealing a provider URL. Response is `private, no-store`. |
| `PUT /api/posts/:postId/like`, `DELETE /api/posts/:postId/like` | `{ likeCount, isLikedByViewer }` | Signed in; exact allowed Origin and current post visibility required. A unique user/post index makes repeated Like requests idempotent; repeated unlike is also safe. |
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

The friendship utility `server/src/friends/are-friends.ts` checks the canonical `friendships` record and is shared by profile visibility and future post/chat authorization. A friendship is mutual: one record stores the ordered `userIdLow` and `userIdHigh` IDs, and either account can remove that record.
