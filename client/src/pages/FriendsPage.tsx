import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
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
import { EmptyState, RequestErrorState } from "../components/AsyncState";
import { PeopleCardsSkeleton, PeopleRowsSkeleton } from "../components/Skeletons";

type FriendsView = "home" | "requests" | "suggestions" | "friends" | "search";
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

function FriendsProfileCard({ children, user }: { children: ReactNode; user: User }) {
  const [imageFailed, setImageFailed] = useState(false);
  const imageUrl = user.coverUrl || user.avatarUrl;
  const initial = user.displayName.trim().charAt(0).toUpperCase() || "?";

  return (
    <li className="friends-profile-card">
      <Link className="friends-profile-cover" to={userProfilePath(user)} aria-label={`View ${user.displayName}'s profile`}>
        {imageUrl && !imageFailed
          ? <img src={imageUrl} alt="" loading="lazy" onError={() => setImageFailed(true)} />
          : <span aria-hidden="true">{initial}</span>}
      </Link>
      <div className="friends-profile-content">
        <Link className="friends-profile-name" to={userProfilePath(user)}>{user.displayName}</Link>
        <p>{user.bio || user.info.location || "Senderi member"}</p>
        <div className="friends-profile-actions">{children}</div>
      </div>
    </li>
  );
}

type FriendsIconName = "home" | "requests" | "suggestions" | "friends";

function FriendsNavIcon({ name }: { name: FriendsIconName }) {
  const paths: Record<FriendsIconName, ReactNode> = {
    home: <><path d="m3 10 9-7 9 7" /><path d="M5 9v11h14V9M9 20v-6h6v6" /></>,
    requests: <><circle cx="9" cy="8" r="4" /><path d="M2 21a7 7 0 0 1 14 0M19 8v6M16 11h6" /></>,
    suggestions: <><path d="m12 3 2.2 5.4L20 10l-5.8 1.6L12 17l-2.2-5.4L4 10l5.8-1.6L12 3Z" /><path d="m19 16 .9 2.1L22 19l-2.1.9L19 22l-.9-2.1L16 19l2.1-.9L19 16Z" /></>,
    friends: <><circle cx="9" cy="8" r="3.5" /><path d="M2 21a7 7 0 0 1 14 0M16 4.5a3.5 3.5 0 0 1 0 7M18 15a6 6 0 0 1 4 6" /></>,
  };

  return <svg aria-hidden="true" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
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
  const location = useLocation();
  const [view, setView] = useState<FriendsView>("home");
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

  const [suggestions, setSuggestions] = useState<User[]>([]);
  const [suggestionsCursor, setSuggestionsCursor] = useState<string | null>(null);
  const [suggestionsLoading, setSuggestionsLoading] = useState(true);
  const [suggestionsError, setSuggestionsError] = useState<string | null>(null);
  const [suggestionsFeedback, setSuggestionsFeedback] = useState<string | null>(null);
  const [suggestionsFeedbackError, setSuggestionsFeedbackError] = useState(false);
  const [hiddenSuggestionIds, setHiddenSuggestionIds] = useState<string[]>([]);

  const refreshRequests = useCallback(async (): Promise<FriendRequestsResponse> => {
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
  }, []);

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

  async function loadSuggestions(cursor: string | null = null, append = false): Promise<void> {
    setSuggestionsLoading(true);
    setSuggestionsError(null);
    try {
      const params = new URLSearchParams({ limit: "20" });
      if (cursor) params.set("cursor", cursor);
      const response = await apiFetch<UserSearchResponse>(`/api/users/suggestions?${params.toString()}`);
      setSuggestions((current) => append ? [...current, ...response.items] : response.items);
      setSuggestionsCursor(response.nextCursor);
    } catch (error) {
      setSuggestionsError(errorMessage(error, "Could not load friend suggestions."));
    } finally {
      setSuggestionsLoading(false);
    }
  }

  useEffect(() => {
    void refreshRequests().catch(() => undefined);
    void refreshFriends();
    void loadSuggestions();
  }, [refreshRequests]);

  useEffect(() => {
    if ((view !== "requests" && view !== "home") || requestsLoading) return;
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

  const fetchSearchStatuses = useCallback(async (users: User[]): Promise<void> => {
    const statuses = await Promise.all(users.map(async (user) => {
      try {
        const profile = await apiFetch<ProfileResponse>(`/api/users/${encodeURIComponent(user.id)}`);
        return [user.id, profile.friendshipStatus] as const;
      } catch {
        return [user.id, "unknown"] as const;
      }
    }));
    setSearchStatuses((current) => ({ ...current, ...Object.fromEntries(statuses) }));
  }, []);

  const loadSearchPage = useCallback(async (query: string, cursor: string | null, append: boolean): Promise<void> => {
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
  }, [fetchSearchStatuses, refreshRequests]);

  useEffect(() => {
    const query = new URLSearchParams(location.search).get("query")?.trim();
    if (!query) return;
    setView("search");
    setSearchResults([]);
    setSearchStatuses({});
    setSearchCursor(null);
    void loadSearchPage(query, null, false);
  }, [location.key, location.search, loadSearchPage]);

  async function sendRequest(user: User): Promise<void> {
    setRequestingUserId(user.id);
    setSearchFeedback(null);
    setSearchFeedbackError(false);
    setSuggestionsFeedback(null);
    setSuggestionsFeedbackError(false);
    try {
      const response = await apiFetch<CreateFriendRequestResponse>("/api/friend-requests", {
        method: "POST",
        body: { recipientId: user.id },
      });
      setRequests((current) => ({ ...current, outgoing: [response.request, ...current.outgoing] }));
      setSuggestions((current) => current.filter((item) => item.id !== user.id));
      const message = `Friend request sent to ${user.displayName}.`;
      if (view === "search") setSearchFeedback(message);
      else setSuggestionsFeedback(message);
    } catch (error) {
      const message = errorMessage(error, `Could not send a request to ${user.displayName}.`);
      if (view === "search") {
        setSearchFeedback(message);
        setSearchFeedbackError(true);
      } else {
        setSuggestionsFeedback(message);
        setSuggestionsFeedbackError(true);
      }
    } finally {
      setRequestingUserId(null);
    }
  }

  async function respondToRequest(request: FriendRequest, action: "accept" | "decline" | "cancel"): Promise<void> {
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
      const message = action === "accept"
        ? "Friend request accepted."
        : action === "cancel" ? "Friend request cancelled." : "Friend request declined.";
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

  async function loadMoreSuggestions(): Promise<void> {
    if (!suggestionsCursor || suggestionsLoading) return;
    await loadSuggestions(suggestionsCursor, true);
  }

  function hideSuggestion(user: User): void {
    setHiddenSuggestionIds((current) => [...current, user.id]);
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
  const visibleSuggestions = suggestions.filter((user) => !hiddenSuggestionIds.includes(user.id));
  const friendsNavigation: Array<{ view: FriendsView; label: string; icon: FriendsIconName; count?: number }> = [
    { view: "home", label: "Home", icon: "home" },
    { view: "requests", label: "Friend requests", icon: "requests", count: requests.incoming.length },
    { view: "suggestions", label: "Suggestions", icon: "suggestions" },
    { view: "friends", label: "All friends", icon: "friends" },
  ];

  return (
    <div className="friends-page-layout">
      <aside className="friends-page-sidebar">
        <h1>Friends</h1>
        <nav aria-label="Friends navigation">
          {friendsNavigation.map((item) => (
            <button
              key={item.view}
              className={`friends-page-nav${view === item.view ? " friends-page-nav-active" : ""}`}
              type="button"
              aria-label={item.count ? `${item.label}, ${item.count}` : item.label}
              aria-current={view === item.view ? "page" : undefined}
              title={item.label}
              onClick={() => { setView(item.view); setSearchFeedback(null); setRequestFeedback(null); setFriendsFeedback(null); }}
            >
              <span className="friends-page-nav-icon"><FriendsNavIcon name={item.icon} /></span>
              <span className="friends-page-nav-label">{item.label}</span>
              {item.count ? <span className="friends-page-nav-count">{item.count}</span> : null}
            </button>
          ))}
        </nav>
      </aside>

      <main className="friends-page-main">
        {view === "home" && (
          <div className="friends-home-sections">
            <section aria-labelledby="friend-requests-home-title">
              <div className="friends-section-heading">
                <div>
                  <h2 id="friend-requests-home-title">Friend requests</h2>
                  <p>{requests.incoming.length ? `${requests.incoming.length} waiting for your response` : "Requests you receive will appear here."}</p>
                </div>
                <button className="friends-see-all" type="button" onClick={() => setView("requests")}>See all</button>
              </div>
              {requestFeedback && <p className={requestFeedbackError ? "friend-feedback friend-feedback-error" : "friend-feedback"} role={requestFeedbackError ? "alert" : "status"}>{requestFeedback}</p>}
              {requestsLoading || requestProfilesLoading ? <PeopleCardsSkeleton message="Loading friend requests" /> : requestsError ? <RequestErrorState title="Requests unavailable" message={requestsError} /> : requestProfilesError ? <RequestErrorState title="Profiles unavailable" message={requestProfilesError} /> : requests.incoming.length === 0 ? <EmptyState title="No new requests" message="When someone asks to connect, their request will appear here." /> : (
                <ul className="friends-card-grid" aria-label="Incoming friend requests">
                  {requests.incoming.slice(0, 6).map((request) => {
                    const person = requestProfiles[request.senderId];
                    if (!person) return null;
                    return (
                      <FriendsProfileCard key={request.id} user={person}>
                        <button className="button-accent" type="button" onClick={() => void respondToRequest(request, "accept")} disabled={requestActionId === request.id}>{requestActionId === request.id ? "Saving…" : "Confirm"}</button>
                        <button className="button-secondary" type="button" onClick={() => void respondToRequest(request, "decline")} disabled={requestActionId === request.id}>Delete</button>
                      </FriendsProfileCard>
                    );
                  })}
                </ul>
              )}
              {requestsError && <button className="button-secondary mt-4" type="button" onClick={() => void refreshRequests().catch(() => undefined)}>Try again</button>}
              {requestProfilesError && <button className="button-secondary mt-4" type="button" onClick={() => { setRequestProfilesError(null); setRequestProfilesRetry((current) => current + 1); }}>Retry profiles</button>}
            </section>

            <section aria-labelledby="suggestions-home-title">
              <div className="friends-section-heading">
                <div>
                  <h2 id="suggestions-home-title">People you may know</h2>
                  <p>Discover more people on Senderi.</p>
                </div>
                <button className="friends-see-all" type="button" onClick={() => setView("suggestions")}>See all</button>
              </div>
              {suggestionsFeedback && <p className={suggestionsFeedbackError ? "friend-feedback friend-feedback-error" : "friend-feedback"} role={suggestionsFeedbackError ? "alert" : "status"}>{suggestionsFeedback}</p>}
              {suggestionsLoading && suggestions.length === 0 ? <PeopleCardsSkeleton message="Finding people to connect with" /> : suggestionsError ? <RequestErrorState title="Suggestions unavailable" message={suggestionsError} /> : visibleSuggestions.length === 0 ? <EmptyState title="No suggestions right now" message="Check back later or find someone by searching their name." /> : (
                <ul className="friends-card-grid" aria-label="People you may know">
                  {visibleSuggestions.slice(0, 6).map((person) => (
                    <FriendsProfileCard key={person.id} user={person}>
                      <button className="button-accent" type="button" onClick={() => void sendRequest(person)} disabled={requestingUserId === person.id}>{requestingUserId === person.id ? "Sending…" : "Add friend"}</button>
                      <button className="button-secondary" type="button" onClick={() => hideSuggestion(person)}>Hide</button>
                    </FriendsProfileCard>
                  ))}
                </ul>
              )}
              {suggestionsError && <button className="button-secondary mt-4" type="button" onClick={() => void loadSuggestions()}>Try again</button>}
            </section>
          </div>
        )}

        {view === "search" && (
          <section className="friends-content-section" aria-labelledby="find-people-title">
          <div className="mb-5">
            <h2 id="find-people-title" className="text-xl font-bold tracking-[-0.03em] text-ink">Find people</h2>
            <p className="mt-1 text-sm text-muted">Search by display name from the bar beside the Senderi logo. Only public profile details are shown.</p>
          </div>
          {searchError && <p className="friend-feedback friend-feedback-error" role="alert">{searchError}</p>}
          {searchFeedback && <p className={searchFeedbackError ? "friend-feedback friend-feedback-error" : "friend-feedback"} role={searchFeedbackError ? "alert" : "status"}>{searchFeedback}</p>}
          {!searchQuery && <EmptyState title="Search for people" message="Enter a name in the search bar beside the Senderi logo." />}
          {searchLoading && searchResults.length === 0 ? <div className="mt-5"><PeopleRowsSkeleton message="Searching for people" /></div> : null}
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
          {searchLoading && searchResults.length > 0 && <PeopleRowsSkeleton count={2} message="Loading more people" />}
          {searchCursor && <button className="button-secondary mt-5" type="button" onClick={() => void loadMoreSearchResults()} disabled={searchLoading}>{searchLoading ? "Loading…" : "Load more people"}</button>}
          </section>
        )}

      {view === "requests" && (
        <section className="friends-content-section" aria-labelledby="requests-title">
          <div className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div><h2 id="requests-title" className="text-xl font-bold tracking-[-0.03em] text-ink">Friend requests</h2><p className="mt-1 text-sm text-muted">Review invitations and see requests you have sent.</p></div>
            <div className="friend-subtabs" role="tablist" aria-label="Request direction">
              <button type="button" role="tab" aria-selected={incoming} className={incoming ? "friend-subtab friend-subtab-active" : "friend-subtab"} onClick={() => { setRequestView("incoming"); setRequestFeedback(null); }}>Incoming ({requests.incoming.length})</button>
              <button type="button" role="tab" aria-selected={!incoming} className={!incoming ? "friend-subtab friend-subtab-active" : "friend-subtab"} onClick={() => { setRequestView("outgoing"); setRequestFeedback(null); }}>Sent ({requests.outgoing.length})</button>
            </div>
          </div>
          {requestFeedback && <p className={requestFeedbackError ? "friend-feedback friend-feedback-error" : "friend-feedback"} role={requestFeedbackError ? "alert" : "status"}>{requestFeedback}</p>}
          {requestsLoading ? <PeopleCardsSkeleton message="Loading friend requests" /> : requestsError ? <RequestErrorState title="Requests unavailable" message={requestsError} /> : requestProfilesError ? <RequestErrorState title="Profiles unavailable" message={requestProfilesError} /> : requestProfilesLoading ? <PeopleCardsSkeleton message="Loading request profiles" /> : visibleRequests.length === 0 ? <EmptyState title={incoming ? "No incoming requests" : "No sent requests"} message={incoming ? "New friend invitations will appear here." : "Requests you send will appear here until they respond."} /> : (
            <ul className="friends-card-grid" aria-label={incoming ? "Incoming friend requests" : "Sent friend requests"}>
              {visibleRequests.map((request) => {
                const targetId = incoming ? request.senderId : request.recipientId;
                const person = requestProfiles[targetId];
                if (!person) return null;
                return (
                  <FriendsProfileCard key={request.id} user={person}>
                    {incoming ? (
                      <>
                        <button className="button-accent" type="button" onClick={() => void respondToRequest(request, "accept")} disabled={requestActionId === request.id}>{requestActionId === request.id ? "Saving…" : "Confirm"}</button>
                        <button className="button-secondary" type="button" onClick={() => void respondToRequest(request, "decline")} disabled={requestActionId === request.id}>Delete</button>
                      </>
                    ) : (
                      <button className="button-secondary" type="button" onClick={() => void respondToRequest(request, "cancel")} disabled={requestActionId === request.id}>Cancel</button>
                    )}
                  </FriendsProfileCard>
                );
              })}
            </ul>
          )}
          {requestsError && <button className="button-secondary mt-4" type="button" onClick={() => void refreshRequests().catch(() => undefined)}>Try again</button>}
          {requestProfilesError && <button className="button-secondary mt-4" type="button" onClick={() => { setRequestProfilesError(null); setRequestProfilesRetry((current) => current + 1); }}>Retry profiles</button>}
        </section>
      )}

      {view === "suggestions" && (
        <section className="friends-content-section" aria-labelledby="suggestions-title">
          <div className="friends-section-heading">
            <div><h2 id="suggestions-title">People you may know</h2><p>Discover more people on Senderi.</p></div>
            <button className="friends-see-all" type="button" onClick={() => setView("search")}>Find people</button>
          </div>
          {suggestionsFeedback && <p className={suggestionsFeedbackError ? "friend-feedback friend-feedback-error" : "friend-feedback"} role={suggestionsFeedbackError ? "alert" : "status"}>{suggestionsFeedback}</p>}
          {suggestionsLoading && suggestions.length === 0 ? <PeopleCardsSkeleton message="Finding people to connect with" /> : suggestionsError ? <RequestErrorState title="Suggestions unavailable" message={suggestionsError} /> : visibleSuggestions.length === 0 ? <EmptyState title="No suggestions right now" message="Check back later or find someone by searching their name." /> : (
            <ul className="friends-card-grid" aria-label="People you may know">
              {visibleSuggestions.map((person) => (
                <FriendsProfileCard key={person.id} user={person}>
                  <button className="button-accent" type="button" onClick={() => void sendRequest(person)} disabled={requestingUserId === person.id}>{requestingUserId === person.id ? "Sending…" : "Add friend"}</button>
                  <button className="button-secondary" type="button" onClick={() => hideSuggestion(person)}>Hide</button>
                </FriendsProfileCard>
              ))}
            </ul>
          )}
          {suggestionsLoading && suggestions.length > 0 && <PeopleCardsSkeleton count={2} message="Loading more suggestions" />}
          {suggestionsError && <button className="button-secondary mt-4" type="button" onClick={() => void loadSuggestions()}>Try again</button>}
          {suggestionsCursor && <button className="button-secondary mt-5" type="button" onClick={() => void loadMoreSuggestions()} disabled={suggestionsLoading}>{suggestionsLoading ? "Loading…" : "See more"}</button>}
        </section>
      )}

      {view === "friends" && (
        <section className="friends-content-section" aria-labelledby="my-friends-title">
          <div className="mb-5"><h2 id="my-friends-title" className="text-xl font-bold tracking-[-0.03em] text-ink">My friends</h2><p className="mt-1 text-sm text-muted">People connected with you on Senderi.</p></div>
          {friendsFeedback && <p className={friendsFeedbackError ? "friend-feedback friend-feedback-error" : "friend-feedback"} role={friendsFeedbackError ? "alert" : "status"}>{friendsFeedback}</p>}
          {friendsLoading && friends.length === 0 ? <PeopleCardsSkeleton message="Loading your friends" wide /> : friendsError && friends.length === 0 ? <RequestErrorState title="Friends unavailable" message={friendsError} /> : friends.length === 0 ? <EmptyState title="Your friend list is empty" message="Search for people and send a friend request to get started." /> : (
            <ul className="friend-list" aria-label="Your friends">
              {friends.map((friend) => (
                <FriendsProfileCard key={friend.id} user={friend}>
                  <Link className="button-secondary" to={userProfilePath(friend)}>View profile</Link>
                  <button className="button-secondary friend-remove-action" type="button" onClick={() => void removeFriend(friend)} disabled={removingFriendId === friend.id}>{removingFriendId === friend.id ? "Removing…" : "Remove"}</button>
                </FriendsProfileCard>
              ))}
            </ul>
          )}
          {friendsLoading && friends.length > 0 && <PeopleCardsSkeleton count={2} message="Loading more friends" wide />}
          {friendsError && friends.length > 0 && <p className="friend-feedback friend-feedback-error" role="alert">{friendsError}</p>}
          {friendsCursor && <button className="button-secondary mt-5" type="button" onClick={() => void loadMoreFriends()} disabled={friendsLoading}>{friendsLoading ? "Loading…" : "Load more friends"}</button>}
          {friendsError && friends.length === 0 && <button className="button-secondary mt-4" type="button" onClick={() => void refreshFriends()}>Try again</button>}
        </section>
      )}
      </main>
    </div>
  );
}
