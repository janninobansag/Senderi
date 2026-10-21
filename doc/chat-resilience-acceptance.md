# Chat resilience acceptance

Use this record during acceptance. Automated checks cover socket exchange, friendship revocation, multi-socket delivery, and MongoDB restart persistence. A browser server-restart check completes M6-L4.1. The M6-L4.4 recording captures end-to-end recovery on Render Free; it does not isolate the time spent waking Render from session restoration and page navigation.

## Free-tier reconnect observation

The screen recording shows about 38 seconds from opening the deployed app to the Messages page showing Connected. This is an end-to-end client recovery time that includes session restoration and navigation; the recording does not show the exact idle period or when Render entered sleep.

| Date and time (with time zone) | Render plan | Idle period | Reconnect began | UI showed Connected | Measured delay | Browser history matched records? | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-10-21 22:51:22-22:52:00 SGT (approx) | Render Free | Exact idle duration not visible in recording | 22:51:22 SGT (video +16s) | 22:52:00 SGT (video +54s) | About 38 seconds end-to-end | Yes - earlier messages reappeared once and in order | Measured from app navigation to Messages Connected; includes session restoration/navigation. Exact Render sleep start is not shown. |

### Browser check for M6-L4.1

1. From the repository root, run `npm run dev:server` and `npm run dev:client` in separate terminals so the client stays open when the server restarts.
2. Sign in as two friends in separate browser profiles and exchange messages. Confirm they appear in both conversations and in the `messages` collection for the database configured by `MONGODB_URI`.
3. Stop and restart only the server process. Watch the Messages screen change from **Reconnecting** to **Connected**.
4. Confirm both conversations reload the stored messages in the same order and the UI shows each message once. Record the check below.

| Date and time | Environment | Server restart | UI reconnected | UI matched stored history | Notes |
| --- | --- | --- | --- | --- | --- |
| 2026-10-21 ~22:51:22 SGT | Deployed Vercel client + Render Free API | Session restored after idle period | Yes - Connected at ~22:52:00 SGT | Yes - earlier "hi" and "hello" messages remained visible once and in order | Screen recording confirms recovery; exact idle period is not visible. |

### Render Free delay check for M6-L4.4

The recorded run documents the observed end-to-end recovery. To isolate Render's wake-up time in a future run, capture the first request or socket reconnect attempt separately from the time Messages shows **Connected**.

1. Sign in as two friends and exchange messages on the deployed Render Free service.
2. Let the service sleep according to its current free-tier behavior. Record when the first request or socket reconnect attempt wakes it.
3. Record when the Messages screen shows **Connected**. Subtract the timestamps and add the measured delay and history result to the table above.

## Automated evidence

Run `npm test --prefix server` from the repository root. The suite includes:

- An open-socket test that removes a friendship and verifies both send and history denial.
- A multiple-socket test that represents two tabs for one user and checks single delivery and persistence on retry.
- An opt-in MongoDB test that exchanges messages, recreates the API and database connections, and compares each user's history response with the stored records. Set `MONGODB_TEST_URI` to a dedicated test database; this test uses `senderi_m6_l4_test` and cleans up its uniquely identified records.

The automated restart test verifies the history data consumed by the Messages screen. It does not substitute for the deployed browser and Render timing observation above.
