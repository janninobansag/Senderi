import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type {
  CreateFriendRequestResponse,
  FriendListResponse,
  FriendRequest,
  FriendRequestsResponse,
  ProfileResponse,
  ProfileFriendshipStatus,
  RespondToFriendRequestResponse,
  User,
  UserSearchResponse,
} from "../../../shared";
import { ApiError, apiFetch } from "../api/client";
import { EmptyState, LoadingState, RequestErrorState } from "../components/AsyncState";

type FriendsView = "search" | "requests" | "friends";
type RequestView = "incoming" | "outgoing";
type SearchRelationship = "incoming" | "outgoing" | "friends" | "none" | "unknown";

const EMPTY_REQUESTS: FriendRequestsResponse = { incoming: [], outgoing: [] };

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

function userProfilePath(user: User): string {
  return `/profile/${encodeURIComponent(user.id)}`;
}

function UserAvatar({ user }: { user: User }) {
  const [imageFailed, setImageFailed] = useState(false);
  const initial = user.displayName.trim().charAt(0).toUpperCase() || "?";

  return (
    <span className="friend-avatar" aria-hidden="true">
      {user.avatarUrl && !imageFailed ? <img src={user.avatarUrl} alt="" onError={() => setImageFailed(true)} /> : initial}
    </span>
  );
}

function UserSummary({ user }: { user: User }) {
  return (
    <div className="friend-person">
      <UserAvatar user={user} />
      <div className="friend-person-copy">
        <Link className="friend-person-name" to={userProfilePath(user)}>{user.displayName}</Link>
        <p>{user.bio || user.info.location || "Senderi member"}</p>
      </div>
    </div>
  );
}

function FriendCard({ children, user }: { children: ReactNode; user: User }) {
  return (
    <li className="friend-card">
      <UserSummary user={user} />
      <div className="friend-card-actions">{children}</div>
    </li>
  );
}

function relationshipLabel(relationship: SearchRelationship): string {
  switch (relationship) {
    case "incoming": return "Sent you a request";
    case "outgoing": return "Request sent";
    case "friends": return "Friends";
    case "none": return "Not connected";
    case "unknown": return "Status unavailable";
  }
}

export function FriendsPage() {
  const [view, setView] = useState<FriendsView>("search");
  const [requestView, setRequestView] = useState<RequestView>("incoming");
  const [requests, setRequests] = useState<FriendRequestsResponse>(EMPTY_REQUESTS);
  const [requestsLoading, setRequestsLoading] = useState(true);
  const [requestsError, setRequestsError] = useState<string | null>(null);
  const [requestProfiles, setRequestProfiles] = useState<Record<string, User>>({});
  const [requestProfilesLoading, setRequestProfilesLoading] = useState(false);
  const [requestProfilesError, setRequestProfilesError] = useState<string | null>(null);
  const [requestProfilesRetry, setRequestProfilesRetry] = useState(0);
  const [requestActionId, setRequestActionId] = useState<string | null>(null);
  const [requestFeedback, setRequestFeedback] = useState<string | null>(null);
  const [requestFeedbackError, setRequestFeedbackError] = useState(false);

  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<User[]>([]);
  const [searchStatuses, setSearchStatuses] = useState<Record<string, ProfileFriendshipStatus | "unknown">>({});
  const [searchCursor, setSearchCursor] = useState<string | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchFeedback, setSearchFeedback] = useState<string | null>(null);
  const [searchFeedbackError, setSearchFeedbackError] = useState(false);
  const [requestingUserId, setRequestingUserId] = useState<string | null>(null);

  const [friends, setFriends] = useState<User[]>([]);
  const [friendsCursor, setFriendsCursor] = useState<string | null>(null);
  const [friendsLoading, setFriendsLoading] = useState(true);
  const [friendsError, setFriendsError] = useState<string | null>(null);
  const [removingFriendId, setRemovingFriendId] = useState<string | null>(null);
  const [friendsFeedback, setFriendsFeedback] = useState<string | null>(null);
  const [friendsFeedbackError, setFriendsFeedbackError] = useState(false);

  async function refreshRequests(): Promise<FriendRequestsResponse> {
    setRequestsLoading(true);
    setRequestsError(null);
    try {
      const response = await apiFetch<FriendRequestsResponse>("/api/friend-requests");
      setRequests(response);
      return response;
    } catch (error) {
      setRequestsError(errorMessage(error, "Could not load your friend requests."));
      throw error;
    } finally {
      setRequestsLoading(false);
    }
  }

  async function refreshFriends(): Promise<void> {
    setFriendsLoading(true);
    setFriendsError(null);
    try {
      const response = await apiFetch<FriendListResponse>("/api/friends?limit=20");
      setFriends(response.items);
      setFriendsCursor(response.nextCursor);
    } catch (error) {
      setFriendsError(errorMessage(error, "Could not load your friends."));
    } finally {
      setFriendsLoading(false);
    }
  }

  useEffect(() => {
    void refreshRequests().catch(() => undefined);
    void refreshFriends();
  }, []);

  useEffect(() => {
    if (view !== "requests" || requestsLoading) return;
    const targetIds = [...new Set([
      ...requests.incoming.map((request) => request.senderId),
      ...requests.outgoing.map((request) => request.recipientId),
    ])].filter((id) => !requestProfiles[id]);

    if (targetIds.length === 0) return;
    let active = true;
    setRequestProfilesLoading(true);
    setRequestProfilesError(null);
    void Promise.all(targetIds.map(async (id) => {
      const profile = await apiFetch<ProfileResponse>(`/api/users/${encodeURIComponent(id)}`);
      return [id, profile.user] as const;
    })).then((entries) => {
      if (active) setRequestProfiles((current) => ({ ...current, ...Object.fromEntries(entries) }));
    }).catch((error: unknown) => {
      if (active) setRequestProfilesError(errorMessage(error, "Could not load the profiles for these requests."));
    }).finally(() => {
      if (active) setRequestProfilesLoading(false);
    });
    return () => { active = false; };
  }, [view, requests, requestsLoading, requestProfiles, requestProfilesRetry]);

  function getSearchRelationship(user: User): SearchRelationship {
    if (requests.incoming.some((request) => request.senderId === user.id)) return "incoming";
    if (requests.outgoing.some((request) => request.recipientId === user.id)) return "outgoing";
    const status = searchStatuses[user.id];
    if (status === undefined || status === "unknown") return "unknown";
    return status === "friends" ? "friends" : "none";
  }

  async function fetchSearchStatuses(users: User[]): Promise<void> {
    const statuses = await Promise.all(users.map(async (user) => {
      try {
        const profile = await apiFetch<ProfileResponse>(`/api/users/${encodeURIComponent(user.id)}`);
        return [user.id, profile.friendshipStatus] as const;
      } catch {
        return [user.id, "unknown"] as const;
      }
    }));
    setSearchStatuses((current) => ({ ...current, ...Object.fromEntries(statuses) }));
  }

  async function loadSearchPage(query: string, cursor: string | null, append: boolean): Promise<void> {
    setSearchLoading(true);
    setSearchError(null);
    setSearchFeedback(null);
    try {
      await refreshRequests();
      const params = new URLSearchParams({ query, limit: "20" });
      if (cursor) params.set("cursor", cursor);
      const response = await apiFetch<UserSearchResponse>(`/api/users?${params.toString()}`);
      setSearchResults((current) => append ? [...current, ...response.items] : response.items);
      setSearchStatuses((current) => append ? current : {});
      setSearchCursor(response.nextCursor);
      setSearchQuery(query);
      await fetchSearchStatuses(response.items);
    } catch (error) {
      setSearchError(errorMessage(error, "Could not search for people. Please try again."));
    } finally {
      setSearchLoading(false);
    }
  }

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = searchInput.trim();
    if (!query) {
      setSearchError("Enter a name to search for people.");
      setSearchResults([]);
      setSearchCursor(null);
      setSearchQuery("");
      return;
    }
    setSearchResults([]);
    setSearchStatuses({});
    setSearchCursor(null);
    void loadSearchPage(query, null, false);
  }

  async function sendRequest(user: User): Promise<void> {
    setRequestingUserId(user.id);
    setSearchFeedback(null);
    setSearchFeedbackError(false);
    try {
      const response = await apiFetch<CreateFriendRequestResponse>("/api/friend-requests", {
        method: "POST",
        body: { recipientId: user.id },
      });
      setRequests((current) => ({ ...current, outgoing: [response.request, ...current.outgoing] }));
      setSearchFeedback(`Friend request sent to ${user.displayName}.`);
    } catch (error) {
      setSearchFeedback(errorMessage(error, `Could not send a request to ${user.displayName}.`));
      setSearchFeedbackError(true);
    } finally {
      setRequestingUserId(null);
    }
  }

  async function respondToRequest(request: FriendRequest, action: "accept" | "decline"): Promise<void> {
    setRequestActionId(request.id);
    setRequestFeedback(null);
    setRequestFeedbackError(false);
    setSearchFeedback(null);
    setSearchFeedbackError(false);
    try {
      await apiFetch<RespondToFriendRequestResponse>(`/api/friend-requests/${encodeURIComponent(request.id)}`, {
        method: "PATCH",
        body: { action },
      });
      setRequests((current) => ({
        ...current,
        incoming: current.incoming.filter((item) => item.id !== request.id),
        outgoing: current.outgoing.filter((item) => item.id !== request.id),
      }));
      const message = action === "accept" ? "Friend request accepted." : "Friend request declined.";
      if (view === "search") setSearchFeedback(message);
      else setRequestFeedback(message);
      if (action === "accept") {
        setSearchStatuses((current) => ({ ...current, [request.senderId]: "friends" }));
        await refreshFriends();
      }
    } catch (error) {
      const message = errorMessage(error, "Could not update this friend request.");
      if (view === "search") {
        setSearchFeedback(message);
        setSearchFeedbackError(true);
      } else {
        setRequestFeedback(message);
        setRequestFeedbackError(true);
      }
    } finally {
      setRequestActionId(null);
    }
  }

  async function loadMoreSearchResults(): Promise<void> {
    if (!searchCursor || !searchQuery || searchLoading) return;
    await loadSearchPage(searchQuery, searchCursor, true);
  }

  async function loadMoreFriends(): Promise<void> {
    if (!friendsCursor || friendsLoading) return;
    setFriendsLoading(true);
    setFriendsError(null);
    try {
      const params = new URLSearchParams({ limit: "20", cursor: friendsCursor });
      const response = await apiFetch<FriendListResponse>(`/api/friends?${params.toString()}`);
      setFriends((current) => {
        const knownIds = new Set(current.map((user) => user.id));
        return [...current, ...response.items.filter((user) => !knownIds.has(user.id))];
      });
      setFriendsCursor(response.nextCursor);
    } catch (error) {
      setFriendsError(errorMessage(error, "Could not load more friends."));
    } finally {
      setFriendsLoading(false);
    }
  }

  async function removeFriend(user: User): Promise<void> {
    setRemovingFriendId(user.id);
    setFriendsFeedback(null);
    setFriendsFeedbackError(false);
    try {
      await apiFetch<void>(`/api/friends/${encodeURIComponent(user.id)}`, { method: "DELETE" });
      setFriends((current) => current.filter((friend) => friend.id !== user.id));
      setFriendsFeedback(`${user.displayName} was removed from your friends.`);
      setSearchStatuses((current) => ({ ...current, [user.id]: "none" }));
    } catch (error) {
      setFriendsFeedback(errorMessage(error, `Could not remove ${user.displayName}.`));
      setFriendsFeedbackError(true);
    } finally {
      setRemovingFriendId(null);
    }
  }

  const incoming = requestView === "incoming";
  const visibleRequests = incoming ? requests.incoming : requests.outgoing;

  return (
    <div className="space-y-5">
      <section className="surface-card p-6 sm:p-8">
        <span className="eyebrow">Your circle</span>
        <div className="mt-3 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-[-0.04em] text-ink">Friends</h1>
            <p className="mt-2 max-w-xl text-sm leading-6 text-muted">Find people, respond to requests, and manage the connections you have made.</p>
          </div>
          <span className="friend-count">{friends.length} friends loaded</span>
        </div>

        <div className="friend-tabs" role="tablist" aria-label="Friend pages">
          {([
            ["search", "Find people"],
            ["requests", `Requests${requests.incoming.length ? ` · ${requests.incoming.length}` : ""}`],
            ["friends", "My friends"],
          ] as const).map(([tab, label]) => (
            <button key={tab} className={`friend-tab ${view === tab ? "friend-tab-active" : ""}`} type="button" role="tab" aria-selected={view === tab} onClick={() => { setView(tab); setSearchFeedback(null); setRequestFeedback(null); setFriendsFeedback(null); }}>
              {label}
            </button>
          ))}
        </div>
      </section>

      {view === "search" && (
        <section className="surface-card p-5 sm:p-7" aria-labelledby="find-people-title">
          <div className="mb-5">
            <h2 id="find-people-title" className="text-xl font-bold tracking-[-0.03em] text-ink">Find people</h2>
            <p className="mt-1 text-sm text-muted">Search by display name. Only public profile details are shown.</p>
          </div>
          <form className="friend-search-form" onSubmit={submitSearch}>
            <label className="sr-only" htmlFor="friend-search">Search by display name</label>
            <input id="friend-search" className="form-input" value={searchInput} onChange={(event) => setSearchInput(event.target.value)} maxLength={80} placeholder="Type a name..." />
            <button className="button-accent" type="submit" disabled={searchLoading}>{searchLoading ? "Searching…" : "Search"}</button>
          </form>
          {searchError && <p className="friend-feedback friend-feedback-error" role="alert">{searchError}</p>}
          {searchFeedback && <p className={searchFeedbackError ? "friend-feedback friend-feedback-error" : "friend-feedback"} role={searchFeedbackError ? "alert" : "status"}>{searchFeedback}</p>}
          {searchLoading && searchResults.length === 0 ? <div className="mt-5"><LoadingState message="Searching for people…" /></div> : null}
          {!searchLoading && searchQuery && searchResults.length === 0 && !searchError && <div className="mt-5"><EmptyState title="No people found" message={`No profiles matched “${searchQuery}”. Try another name.`} /></div>}
          {searchResults.length > 0 && (
            <ul className="friend-list mt-5" aria-label="Search results">
              {searchResults.map((user) => {
                const relationship = getSearchRelationship(user);
                const incomingRequest = requests.incoming.find((request) => request.senderId === user.id);
                const disabled = searchLoading || requestingUserId === user.id || relationship === "unknown";
                return (
                  <FriendCard key={user.id} user={user}>
                    {incomingRequest ? (
                      <>
                        <button className="button-accent friend-action" type="button" onClick={() => void respondToRequest(incomingRequest, "accept")} disabled={requestActionId === incomingRequest.id}>{requestActionId === incomingRequest.id ? "Saving…" : "Accept"}</button>
                        <button className="button-secondary friend-action" type="button" onClick={() => void respondToRequest(incomingRequest, "decline")} disabled={requestActionId === incomingRequest.id}>Decline</button>
                      </>
                    ) : relationship === "none" ? (
                      <button className="button-accent friend-action" type="button" onClick={() => void sendRequest(user)} disabled={disabled}>{requestingUserId === user.id ? "Sending…" : "Add friend"}</button>
                    ) : (
                      <span className={`friend-relationship ${relationship === "unknown" ? "friend-relationship-muted" : ""}`} role="status">{relationshipLabel(relationship)}</span>
                    )}
                  </FriendCard>
                );
              })}
            </ul>
          )}
          {searchCursor && <button className="button-secondary mt-5" type="button" onClick={() => void loadMoreSearchResults()} disabled={searchLoading}>{searchLoading ? "Loading…" : "Load more people"}</button>}
        </section>
      )}

      {view === "requests" && (
        <section className="surface-card p-5 sm:p-7" aria-labelledby="requests-title">
          <div className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div><h2 id="requests-title" className="text-xl font-bold tracking-[-0.03em] text-ink">Friend requests</h2><p className="mt-1 text-sm text-muted">Review invitations and see requests you have sent.</p></div>
            <div className="friend-subtabs" role="tablist" aria-label="Request direction">
              <button type="button" role="tab" aria-selected={incoming} className={incoming ? "friend-subtab friend-subtab-active" : "friend-subtab"} onClick={() => { setRequestView("incoming"); setRequestFeedback(null); }}>Incoming ({requests.incoming.length})</button>
              <button type="button" role="tab" aria-selected={!incoming} className={!incoming ? "friend-subtab friend-subtab-active" : "friend-subtab"} onClick={() => { setRequestView("outgoing"); setRequestFeedback(null); }}>Sent ({requests.outgoing.length})</button>
            </div>
          </div>
          {requestFeedback && <p className={requestFeedbackError ? "friend-feedback friend-feedback-error" : "friend-feedback"} role={requestFeedbackError ? "alert" : "status"}>{requestFeedback}</p>}
          {requestsLoading ? <LoadingState message="Loading friend requests…" /> : requestsError ? <RequestErrorState title="Requests unavailable" message={requestsError} /> : requestProfilesError ? <RequestErrorState title="Profiles unavailable" message={requestProfilesError} /> : requestProfilesLoading ? <LoadingState message="Loading request profiles…" /> : visibleRequests.length === 0 ? <EmptyState title={incoming ? "No incoming requests" : "No sent requests"} message={incoming ? "New friend invitations will appear here." : "Requests you send will appear here until they respond."} /> : (
            <ul className="friend-list" aria-label={incoming ? "Incoming friend requests" : "Sent friend requests"}>
              {visibleRequests.map((request) => {
                const targetId = incoming ? request.senderId : request.recipientId;
                const person = requestProfiles[targetId];
                if (!person) return null;
                return (
                  <FriendCard key={request.id} user={person}>
                    {incoming ? (
                      <>
                        <button className="button-accent friend-action" type="button" onClick={() => void respondToRequest(request, "accept")} disabled={requestActionId === request.id}>{requestActionId === request.id ? "Saving…" : "Accept"}</button>
                        <button className="button-secondary friend-action" type="button" onClick={() => void respondToRequest(request, "decline")} disabled={requestActionId === request.id}>Decline</button>
                      </>
                    ) : <span className="friend-relationship" role="status">Request sent</span>}
                  </FriendCard>
                );
              })}
            </ul>
          )}
          {requestsError && <button className="button-secondary mt-4" type="button" onClick={() => void refreshRequests().catch(() => undefined)}>Try again</button>}
          {requestProfilesError && <button className="button-secondary mt-4" type="button" onClick={() => { setRequestProfilesError(null); setRequestProfilesRetry((current) => current + 1); }}>Retry profiles</button>}
        </section>
      )}

      {view === "friends" && (
        <section className="surface-card p-5 sm:p-7" aria-labelledby="my-friends-title">
          <div className="mb-5"><h2 id="my-friends-title" className="text-xl font-bold tracking-[-0.03em] text-ink">My friends</h2><p className="mt-1 text-sm text-muted">People connected with you on Senderi.</p></div>
          {friendsFeedback && <p className={friendsFeedbackError ? "friend-feedback friend-feedback-error" : "friend-feedback"} role={friendsFeedbackError ? "alert" : "status"}>{friendsFeedback}</p>}
          {friendsLoading && friends.length === 0 ? <LoadingState message="Loading your friends…" /> : friendsError && friends.length === 0 ? <RequestErrorState title="Friends unavailable" message={friendsError} /> : friends.length === 0 ? <EmptyState title="Your friend list is empty" message="Search for people and send a friend request to get started." /> : (
            <ul className="friend-list" aria-label="Your friends">
              {friends.map((friend) => (
                <FriendCard key={friend.id} user={friend}>
                  <Link className="button-secondary friend-action" to={userProfilePath(friend)}>View profile</Link>
                  <button className="button-secondary friend-action friend-remove-action" type="button" onClick={() => void removeFriend(friend)} disabled={removingFriendId === friend.id}>{removingFriendId === friend.id ? "Removing…" : "Remove"}</button>
                </FriendCard>
              ))}
            </ul>
          )}
          {friendsError && friends.length > 0 && <p className="friend-feedback friend-feedback-error" role="alert">{friendsError}</p>}
          {friendsCursor && <button className="button-secondary mt-5" type="button" onClick={() => void loadMoreFriends()} disabled={friendsLoading}>{friendsLoading ? "Loading…" : "Load more friends"}</button>}
          {friendsError && friends.length === 0 && <button className="button-secondary mt-4" type="button" onClick={() => void refreshFriends()}>Try again</button>}
        </section>
      )}
    </div>
  );
}
