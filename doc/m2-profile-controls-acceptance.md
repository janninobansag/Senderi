# M2-L4 profile image controls acceptance

The branch has been reconciled with upstream main. Shared avatarUrl/coverUrl fields, server URL generation, friendship status, upload cleanup tests, and the MongoDB persistence test are retained. The client uses server image URLs while preserving local previews and progress.

## Automated ownership checks

server/test/users.test.ts includes separate avatar and cover tests using two accounts. An upload targeting the other account's ID returns 404 without calling storage. An upload to /me changes only the session user's image; the other account's image IDs remain unchanged and its assets are not deleted.

Run: npm test --prefix server. The existing MongoDB persistence test requires MONGODB_TEST_URI and otherwise skips. These API tests do not establish browser acceptance.

## Browser checks still required

1. Start the API and client following setup-deployment.md, with MongoDB and Cloudinary configured.
2. Sign in as account A. Upload an avatar and cover, then replace both with visibly different images. Confirm previews, progress, success messages, and the saved images.
3. Refresh the page. Confirm both replacement images remain and the old images do not return. Record the API image IDs/URLs before and after refresh; each replacement should have a new ID.
4. Sign in as account B in a separate browser session. Visit /profile/<account-A-id>. Confirm account A's saved images are visible and no edit/upload controls appear.
5. Check at narrow and wide viewport widths. Confirm cover crop and avatar overlap, with no blocked controls.
6. Try an unsupported file and an oversized image. Confirm an error and that the saved image remains displayed. Check a failed upload likewise.

Record the tested commit, browser, viewport widths, results, and screenshots in the PR. Keep M2-L4.3 and M2-L4.4 unchecked until their browser checks pass. Do not report unexecuted checks as passed.