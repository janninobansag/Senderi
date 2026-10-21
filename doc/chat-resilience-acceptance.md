# Chat resilience acceptance

Use this record during acceptance. Automated checks cover socket exchange, friendship revocation, multi-socket delivery, and MongoDB restart persistence. A browser server-restart check completes M6-L4.1. A deployed Render Free run is needed only to measure the free-tier wake-up delay for M6-L4.4.

## Free-tier reconnect observation

No Render free-tier reconnect delay has been measured for this branch yet. Do not estimate the delay from the configured idle period. Record the actual timestamps from one acceptance run:

| Date and time (with time zone) | Render plan | Idle period | Reconnect began | UI showed Connected | Measured delay | Browser history matched records? | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Pending deployed acceptance | Render Free | - | - | - | Not measured | - | - |

### Browser check for M6-L4.1

1. From the repository root, run `npm run dev:server` and `npm run dev:client` in separate terminals so the client stays open when the server restarts.
2. Sign in as two friends in separate browser profiles and exchange messages. Confirm they appear in both conversations and in the `messages` collection for the database configured by `MONGODB_URI`.
3. Stop and restart only the server process. Watch the Messages screen change from **Reconnecting** to **Connected**.
4. Confirm both conversations reload the stored messages in the same order and the UI shows each message once. Record the check below.

| Date and time | Environment | Server restart | UI reconnected | UI matched stored history | Notes |
| --- | --- | --- | --- | --- | --- |
| Pending browser check | Local or deployed | - | - | - | - |

### Render Free delay check for M6-L4.4

1. Sign in as two friends and exchange messages on the deployed Render Free service.
2. Let the service sleep according to its current free-tier behavior. Record when the first request or socket reconnect attempt wakes it.
3. Record when the Messages screen shows **Connected**. Subtract the timestamps and add the measured delay and history result to the table above.

## Automated evidence

Run `npm test --prefix server` from the repository root. The suite includes:

- An open-socket test that removes a friendship and verifies both send and history denial.
- A multiple-socket test that represents two tabs for one user and checks single delivery and persistence on retry.
- An opt-in MongoDB test that exchanges messages, recreates the API and database connections, and compares each user's history response with the stored records. Set `MONGODB_TEST_URI` to a dedicated test database; this test uses `senderi_m6_l4_test` and cleans up its uniquely identified records.

The automated restart test verifies the history data consumed by the Messages screen. It does not substitute for the deployed browser and Render timing observation above.
