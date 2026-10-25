import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { io } from "socket.io-client";
import type { ChatUnreadResponse, FriendListResponse, GroupConversation, GroupConversationsResponse, Message, MessageHistoryResponse, NotificationItem, NotificationsResponse, Post, PostListResponse, SocketTicketResponse, User, UserSearchResponse } from "../../shared";
import { apiFetch } from "./api/client";
import { GroupChatAvatar } from "./chat/chat-avatars";
import { CHAT_UNREAD_CHANGED_EVENT, notifyChatUnreadChanged } from "./chat/unread-events";
import { lastActiveLabel, useFriendPresence } from "./chat/use-friend-presence";
import { CompactRowsSkeleton, SessionSkeleton, SkeletonBlock, SkeletonRegion } from "./components/Skeletons";
import { PostComposer, PostList } from "./components/Posts";
import { SupporterBadge } from "./components/SupporterBadge";
import { useAuth } from "./auth/AuthContext";
import { ForgotPasswordPage, LoginPage, ResetPasswordPage, SignupPage } from "./pages/AccountPages";
import { FriendsPage } from "./pages/FriendsPage";
import { MessagesPage } from "./pages/MessagesPage";
import { PostPage } from "./pages/PostPage";
import { ProfilePage } from "./pages/ProfilePage";
import { SearchPage } from "./pages/SearchPage";
import { AdminPage } from "./pages/AdminPage";
import { InformationPage, SiteFooter, informationPageIds } from "./pages/InformationPages";
import { AccountSettingsPage } from "./pages/AccountSettingsPage";
import { MyReportsPage } from "./pages/MyReportsPage";
import { usePwaInstall, usePwaUpdate } from "./pwa";

type IconName = "home" | "users" | "message" | "user" | "userPlus" | "bell" | "plus" | "install";

function Icon({ name, size = 19 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, React.ReactNode> = {
    home: <><path d="m3 10 9-7 9 7" /><path d="M5 9v10h14V9" /><path d="M9 19v-6h6v6" /></>,
    users: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></>,
    message: <><path d="M21 11.5a8.38 8.38 0 0 1-9 8.5 9.62 9.62 0 0 1-4-.8L3 21l1.8-4A8.3 8.3 0 0 1 3 11.5 8.38 8.38 0 0 1 12 3a8.38 8.38 0 0 1 9 8.5Z" /><path d="M8 11h.01M12 11h.01M16 11h.01" /></>,
    user: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
    userPlus: <><circle cx="8" cy="7" r="4" /><path d="M2.5 20v-1a5.5 5.5 0 0 1 11 0v1M19 8v7M15.5 11.5h7" /></>,
    bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" /><path d="M10 21h4" /></>,
    plus: <><path d="M12 5v14M5 12h14" /></>,
    install: <><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></>,
  };

  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

const navigation = [
  { label: "Profile", to: "/profile", icon: "user" as const },
  { label: "Home", to: "/", icon: "home" as const },
  { label: "Friends", to: "/friends", icon: "users" as const },
];

const HOME_REFRESH_EVENT = "senderi:home-refresh";

function requestHomeRefresh() {
  window.scrollTo({ top: 0, behavior: "smooth" });
  window.dispatchEvent(new Event(HOME_REFRESH_EVENT));
}

function HomePage() {
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const refreshHome = () => setRefreshKey((current) => current + 1);
    window.addEventListener(HOME_REFRESH_EVENT, refreshHome);
    return () => window.removeEventListener(HOME_REFRESH_EVENT, refreshHome);
  }, []);

  return (
    <div className="home-feed-column space-y-5">
      <div id="post-composer"><PostComposer onCreated={() => setRefreshKey((current) => current + 1)} /></div>

      <section className="space-y-4">
        <div className="px-1">
          <span className="eyebrow">Your timeline</span>
          <h2 className="mt-2 text-2xl font-bold tracking-[-0.03em] text-ink">Your feed</h2>
        </div>
        <PostList path="/api/posts" refreshKey={refreshKey} />
      </section>
    </div>
  );
}

function MobileMainNavigation() {
  return (
    <nav className="mobile-main-nav" aria-label="Main navigation">
      <NavLink
        to="/"
        end
        aria-label="Home"
        title="Home"
        className={({ isActive }) => `icon-button mobile-main-nav-link${isActive ? " header-icon-active" : ""}`}
        onClick={requestHomeRefresh}
      >
        <Icon name="home" size={18} />
      </NavLink>
      <NavLink
        to="/friends"
        aria-label="Friends"
        title="Friends"
        className={({ isActive }) => `icon-button mobile-main-nav-link${isActive ? " header-icon-active" : ""}`}
      >
        <Icon name="users" size={18} />
      </NavLink>
    </nav>
  );
}

export default function App() {
  const { user, isLoading, initializationError, refreshUser } = useAuth();
  const location = useLocation();
  const showSidebarFooter = Boolean(!isLoading && user && (
    location.pathname === "/" ||
    location.pathname === "/search" ||
    location.pathname === "/admin" ||
    location.pathname === "/reports" ||
    location.pathname === "/settings" ||
    location.pathname === "/profile" ||
    location.pathname.startsWith("/profile/") ||
    location.pathname.startsWith("/posts/")
  ));

  return (
    <div className={`app-shell min-h-screen bg-canvas text-ink${user ? " app-shell-authenticated" : ""}${showSidebarFooter ? " app-shell-sidebar-footer" : ""}${location.pathname === "/messages" ? " app-shell-messages" : ""}`}>
      <header className="app-site-header relative z-40 border-b border-line/80 bg-canvas/90 backdrop-blur-xl">
        <div className="app-header-inner flex h-[72px] w-full items-center justify-between px-5 sm:px-8">
          <div className="header-brand-group">
            <NavLink to="/" aria-label="Senderi home" className="header-brand" onClick={requestHomeRefresh}>
              <picture className="header-brand-picture">
                <source media="(max-width: 640px)" srcSet="/senderi-symbol.png" />
                <img src="/senderi-logo.png" alt="" className="header-brand-image" />
              </picture>
            </NavLink>
            {user ? <HeaderPeopleSearch /> : isLoading ? <span className="skeleton-block skeleton-header-search" aria-hidden="true" /> : null}
          </div>
          <HeaderActions />
        </div>
      </header>

      {initializationError && !isLoading && (
        <div className="mx-auto mt-4 flex max-w-7xl items-center justify-between gap-4 px-5 sm:px-8" role="status">
          <p className="text-sm text-muted">{initializationError}</p>
          <button className="text-sm font-semibold text-accent hover:text-accent-dark" type="button" onClick={() => void refreshUser()}>Retry</button>
        </div>
      )}

      <div className="app-route-content">
        <Routes>
          <Route path="/" element={isLoading ? <PageLoading /> : user ? <MemberLayout><HomePage /></MemberLayout> : <Navigate to="/login" replace />} />
          <Route path="/login" element={<PublicAccountRoute><LoginPage /></PublicAccountRoute>} />
          <Route path="/signup" element={<PublicAccountRoute><SignupPage /></PublicAccountRoute>} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          {informationPageIds.map((page) => <Route key={page} path={`/${page}`} element={<InformationPage page={page} />} />)}
          <Route path="/friends" element={<RequireUser><FriendsPage /></RequireUser>} />
          <Route path="/messages" element={<RequireUser withLayout={false}><MessagesPage /></RequireUser>} />
          <Route path="/posts/:postId" element={<RequireUser><PostPage /></RequireUser>} />
          <Route path="/search" element={<RequireUser><SearchPage /></RequireUser>} />
          <Route path="/settings" element={<RequireUser><AccountSettingsPage /></RequireUser>} />
          <Route path="/reports" element={<RequireUser><MyReportsPage /></RequireUser>} />
          <Route path="/admin" element={isLoading ? <PageLoading /> : user?.isAdmin ? <MemberLayout><AdminPage /></MemberLayout> : <Navigate to="/" replace />} />
          <Route path="/profile" element={<RequireUser><ProfilePage /></RequireUser>} />
          <Route path="/profile/:userId" element={<RequireUser><ProfilePage /></RequireUser>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
      {location.pathname !== "/messages" && <SiteFooter placement="global" />}
    </div>
  );
}

function HeaderPeopleSearch() {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [isEditingHistory, setIsEditingHistory] = useState(false);
  const [recentSearches, setRecentSearches] = useState<string[]>(() => {
    try {
      const stored: unknown = JSON.parse(window.localStorage.getItem("senderi-search-history") ?? "[]");
      return Array.isArray(stored) ? stored.filter((item): item is string => typeof item === "string").slice(0, 8) : [];
    } catch {
      return [];
    }
  });
  const [peopleMatches, setPeopleMatches] = useState<User[]>([]);
  const [postMatches, setPostMatches] = useState<Post[]>([]);
  const [isLoadingMatches, setIsLoadingMatches] = useState(false);
  const [matchesError, setMatchesError] = useState<string | null>(null);
  const searchControlRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const normalizedQuery = query.trim();

  useEffect(() => {
    if (isOpen) searchInputRef.current?.focus();
  }, [isOpen]);

  useEffect(() => {
    const term = normalizedQuery;
    if (term.length < 2) {
      setPeopleMatches([]);
      setPostMatches([]);
      setMatchesError(null);
      setIsLoadingMatches(false);
      return;
    }

    let active = true;
    setPeopleMatches([]);
    setPostMatches([]);
    setIsLoadingMatches(true);
    const timeout = window.setTimeout(() => {
      setMatchesError(null);
      const userParams = new URLSearchParams({ query: term, limit: "5" });
      const postParams = new URLSearchParams({ query: term, limit: "5" });
      void Promise.all([
        apiFetch<UserSearchResponse>(`/api/users?${userParams.toString()}`),
        apiFetch<PostListResponse>(`/api/posts/search?${postParams.toString()}`),
      ]).then(([people, posts]) => {
        if (!active) return;
        setPeopleMatches(people.items);
        setPostMatches(posts.items);
      }).catch(() => {
        if (active) {
          setPeopleMatches([]);
          setPostMatches([]);
          setMatchesError("Search suggestions could not load. Press Enter to try the full search.");
        }
      }).finally(() => {
        if (active) setIsLoadingMatches(false);
      });
    }, 220);

    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [normalizedQuery]);

  useEffect(() => {
    function closeSearch(event: PointerEvent) {
      if (event.target instanceof Node && !searchControlRef.current?.contains(event.target)) {
        setIsOpen(false);
        searchInputRef.current?.blur();
      }
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsOpen(false);
        searchInputRef.current?.blur();
      }
    }
    document.addEventListener("pointerdown", closeSearch);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeSearch);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  function storeRecentSearch(term: string) {
    const next = [term, ...recentSearches.filter((item) => item.toLocaleLowerCase() !== term.toLocaleLowerCase())].slice(0, 8);
    setRecentSearches(next);
    try {
      window.localStorage.setItem("senderi-search-history", JSON.stringify(next));
    } catch {
      // Keep the current session usable when browser storage is unavailable.
    }
  }

  function openFullSearch(value: string) {
    const term = value.trim();
    if (!term) return;
    setQuery(term);
    storeRecentSearch(term);
    setIsEditingHistory(false);
    setIsOpen(false);
    searchInputRef.current?.blur();
    navigate(`/search?query=${encodeURIComponent(term)}`);
  }

  function removeRecentSearch(value: string) {
    const next = recentSearches.filter((item) => item !== value);
    setRecentSearches(next);
    try {
      window.localStorage.setItem("senderi-search-history", JSON.stringify(next));
    } catch {
      // Keep the current session usable when browser storage is unavailable.
    }
  }

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    openFullSearch(query);
  }

  return (
    <div className={`header-search-control${isOpen ? " is-open" : ""}`} ref={searchControlRef}>
      <form className="header-people-search" role="search" onSubmit={submitSearch}>
        <svg className="header-search-desktop-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="10.8" cy="10.8" r="6.8" />
          <path d="m16 16 5 5" />
        </svg>
        <button
          className="header-mobile-search-trigger"
          type="button"
          aria-label={isOpen ? "Close search" : "Open search"}
          aria-expanded={isOpen}
          aria-controls="header-search-popover"
          onClick={() => {
            if (isOpen) {
              setIsOpen(false);
              setQuery("");
              searchInputRef.current?.blur();
            } else {
              setIsOpen(true);
            }
          }}
        >
          {isOpen ? (
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M5 5l14 14M19 5 5 19" /></svg>
          ) : (
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 5 5" /></svg>
          )}
        </button>
        <label className="sr-only" htmlFor="header-people-search-input">Search Senderi</label>
        <input
          ref={searchInputRef}
          id="header-people-search-input"
          value={query}
          onFocus={() => setIsOpen(true)}
          onChange={(event) => { setQuery(event.target.value); setIsOpen(true); setIsEditingHistory(false); }}
          aria-expanded={isOpen}
          aria-controls="header-search-popover"
          maxLength={80}
          placeholder="Search Senderi"
          autoComplete="off"
        />
      </form>

      {isOpen && (
        <div id="header-search-popover" className="header-search-popover" role="region" aria-label="Search Senderi suggestions">
          {normalizedQuery.length < 2 ? (
            <>
              <div className="header-search-popover-heading">
                <strong>Recent</strong>
                {recentSearches.length > 0 && <button type="button" onClick={() => setIsEditingHistory((editing) => !editing)}>{isEditingHistory ? "Done" : "Edit"}</button>}
              </div>
              {recentSearches.length === 0 ? (
                <p className="header-search-empty">Recent searches will appear here.</p>
              ) : (
                <ul className="header-search-list">
                  {recentSearches.map((recent) => (
                    <li className="header-search-list-item" key={recent}>
                      <span className="header-search-recent-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg></span>
                      <button className="header-search-result-copy" type="button" onClick={() => openFullSearch(recent)}>{recent}</button>
                      {isEditingHistory && <button className="header-search-remove" type="button" aria-label={`Remove ${recent} from recent searches`} onClick={() => removeRecentSearch(recent)}>×</button>}
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <>
              <div className="header-search-popover-heading"><strong>Search results</strong></div>
              {isLoadingMatches ? <CompactRowsSkeleton message="Searching Senderi" count={3} /> : null}
              {matchesError && <p className="header-search-empty header-search-error" role="alert">{matchesError}</p>}
              {!isLoadingMatches && !matchesError && peopleMatches.length === 0 && postMatches.length === 0 && <p className="header-search-empty">No matches found. Try another search.</p>}
              {peopleMatches.length > 0 && (
                <>
                  <h3 className="header-search-section-label">People</h3>
                  <ul className="header-search-list">
                    {peopleMatches.map((person) => (
                      <li key={person.id}>
                        <Link className="header-search-result" to={`/profile/${encodeURIComponent(person.id)}`} onClick={() => { storeRecentSearch(normalizedQuery); setIsOpen(false); searchInputRef.current?.blur(); }}>
                          <span className="header-search-result-avatar">{person.avatarUrl ? <img src={person.avatarUrl} alt="" /> : person.displayName.trim().charAt(0).toUpperCase() || "?"}</span>
                          <span className="header-search-result-copy"><strong>{person.displayName} <SupporterBadge user={person} /></strong><span>{person.bio || person.info.location || "Senderi member"}</span></span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {postMatches.length > 0 && (
                <>
                  <h3 className="header-search-section-label">Posts</h3>
                  <ul className="header-search-list">
                    {postMatches.map((post) => (
                      <li key={post.share?.id ?? post.id}>
                        <button className="header-search-result" type="button" onClick={() => openFullSearch(normalizedQuery)}>
                          <span className="header-search-result-avatar">{(post.share?.author.avatarUrl || post.author.avatarUrl) ? <img src={post.share?.author.avatarUrl || post.author.avatarUrl} alt="" /> : (post.share?.author.displayName || post.author.displayName).trim().charAt(0).toUpperCase() || "?"}</span>
                          <span className="header-search-result-copy"><strong>{post.share ? <>{post.share.author.displayName} <SupporterBadge user={post.share.author} /> shared a post</> : <>{post.author.displayName} <SupporterBadge user={post.author} /></>}</strong><span>{post.share?.caption || post.text || "Photo post"}</span></span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <button className="header-search-all-results" type="button" onClick={() => openFullSearch(normalizedQuery)}>See all results for “{normalizedQuery}”</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function HeaderActions() {
  const { user, isLoading, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installMessage, setInstallMessage] = useState<string | null>(null);
  const { canInstall, install, isInstalled } = usePwaInstall();
  const { updateAvailable, updating, applyUpdate, dismissUpdate } = usePwaUpdate();
  const [isMobileViewport, setIsMobileViewport] = useState(() => window.matchMedia("(max-width: 640px)").matches);
  const [isAccountMenuOpen, setIsAccountMenuOpen] = useState(false);
  const [isNotificationsOpen, setIsNotificationsOpen] = useState(false);
  const [isPushSettingsOpen, setIsPushSettingsOpen] = useState(false);
  const [isPushPromptOpen, setIsPushPromptOpen] = useState(false);
  const [isMessagesOpen, setIsMessagesOpen] = useState(false);
  const [messageSearch, setMessageSearch] = useState("");
  const [messageFilter, setMessageFilter] = useState<"all" | "unread">("all");
  const [messageFriends, setMessageFriends] = useState<User[]>([]);
  const [messageGroups, setMessageGroups] = useState<GroupConversation[]>([]);
  const [messagePreviews, setMessagePreviews] = useState<Record<string, Message | null>>({});
  const [messageUnreadCounts, setMessageUnreadCounts] = useState<Record<string, number>>({});
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [unreadNotificationCount, setUnreadNotificationCount] = useState(0);
  const [notificationsLoading, setNotificationsLoading] = useState(false);
  const [notificationError, setNotificationError] = useState<string | null>(null);
  const [pushState, setPushState] = useState<"checking" | "enabled" | "available" | "unavailable" | "unsupported" | "denied" | "not-configured">("checking");
  const [pushWorking, setPushWorking] = useState(false);
  const [pushMessage, setPushMessage] = useState<string | null>(null);
  const accountMenuId = useId();
  const notificationsPanelId = useId();
  const pushSettingsPanelId = useId();
  const messagesPanelId = useId();
  const pushPromptTitleId = useId();
  const pushPromptDescriptionId = useId();
  const accountMenuRef = useRef<HTMLDivElement>(null);
  const accountButtonRef = useRef<HTMLButtonElement>(null);
  const notificationsButtonRef = useRef<HTMLButtonElement>(null);
  const pushSettingsButtonRef = useRef<HTMLButtonElement>(null);
  const pushSettingsPanelRef = useRef<HTMLDivElement>(null);
  const pushPromptRef = useRef<HTMLDialogElement>(null);
  const messagesButtonRef = useRef<HTMLAnchorElement>(null);
  const currentUserId = user?.id;

  useEffect(() => {
    const mobileViewport = window.matchMedia("(max-width: 640px)");
    const updateViewport = () => setIsMobileViewport(mobileViewport.matches);
    updateViewport();
    mobileViewport.addEventListener("change", updateViewport);
    return () => mobileViewport.removeEventListener("change", updateViewport);
  }, []);

  useEffect(() => {
    if (!isNotificationsOpen) setIsPushSettingsOpen(false);
  }, [isNotificationsOpen]);

  const refreshNotifications = useCallback(async () => {
    setNotificationsLoading(true);
    try {
      const result = await apiFetch<NotificationsResponse>("/api/notifications");
      setNotifications(result.items);
      setUnreadNotificationCount(result.unreadCount);
      setNotificationError(null);
    } catch {
      setNotificationError("Notifications couldn’t load. Please try again.");
    } finally {
      setNotificationsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!currentUserId) {
      setNotifications([]);
      setUnreadNotificationCount(0);
      return;
    }

    void refreshNotifications();
    const interval = window.setInterval(() => void refreshNotifications(), 30_000);
    const refreshOnFocus = () => void refreshNotifications();
    window.addEventListener("focus", refreshOnFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshOnFocus);
    };
  }, [currentUserId, refreshNotifications]);

  useEffect(() => {
    if (!currentUserId) {
      setPushState("checking");
      setPushMessage(null);
      setIsPushPromptOpen(false);
      return;
    }
    setPushMessage(null);
    let active = true;
    const checkPushAvailability = async () => {
      if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
        setPushState("unsupported");
        return;
      }
      if (Notification.permission === "denied") {
        setPushState("denied");
        return;
      }
      try {
        const { publicKey } = await apiFetch<{ publicKey: string | null }>("/api/notifications/push/public-key");
        if (!active) return;
        if (!publicKey) {
          setPushState("not-configured");
          return;
        }
        let registration = await navigator.serviceWorker.getRegistration("/");
        if (!registration && import.meta.env.PROD) registration = await navigator.serviceWorker.ready;
        if (!active) return;
        if (!registration) {
          setPushState("unavailable");
          return;
        }
        const subscription = await registration.pushManager.getSubscription();
        if (active) setPushState(subscription && Notification.permission === "granted" ? "enabled" : "available");
      } catch {
        if (active) setPushState("unavailable");
      }
    };
    void checkPushAvailability();
    return () => { active = false; };
  }, [currentUserId, isNotificationsOpen]);

  useEffect(() => {
    if (!currentUserId || pushState !== "available" || !isMobileViewport) {
      setIsPushPromptOpen(false);
      return;
    }
    const dismissedKey = `senderi:push-prompt-dismissed:${currentUserId}`;
    try {
      if (window.sessionStorage.getItem(dismissedKey) === "true") return;
    } catch {
      // Keep the prompt available when browser storage is disabled.
    }
    setIsPushPromptOpen(true);
  }, [currentUserId, isMobileViewport, pushState]);

  useEffect(() => {
    const dialog = pushPromptRef.current;
    if (!dialog) return;
    if (isPushPromptOpen && !dialog.open) dialog.showModal();
    else if (!isPushPromptOpen && dialog.open) dialog.close();
  }, [isPushPromptOpen]);

  useEffect(() => {
    if (!currentUserId) {
      setMessageUnreadCounts({});
      return;
    }

    let active = true;
    let latestRequest = 0;
    const refreshMessageUnread = () => {
      const request = ++latestRequest;
      void apiFetch<ChatUnreadResponse>("/api/chats/unread").then((result) => {
        if (active && request === latestRequest) {
          setMessageUnreadCounts(Object.fromEntries(result.items.map((item) => [
            "groupId" in item ? `group:${item.groupId}` : item.friendId,
            item.unreadCount,
          ])));
        }
      }).catch(() => {
        // Retain the last known badge while the connection is unavailable.
      });
    };

    refreshMessageUnread();
    const interval = window.setInterval(refreshMessageUnread, 30_000);
    window.addEventListener("focus", refreshMessageUnread);
    window.addEventListener(CHAT_UNREAD_CHANGED_EVENT, refreshMessageUnread);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshMessageUnread);
      window.removeEventListener(CHAT_UNREAD_CHANGED_EVENT, refreshMessageUnread);
    };
  }, [currentUserId]);

  useEffect(() => {
    if (!currentUserId) return;
    const socket = io(import.meta.env.VITE_SOCKET_URL || window.location.origin, {
      autoConnect: false,
      withCredentials: true,
      auth: (callback) => {
        void apiFetch<SocketTicketResponse>("/api/auth/socket-ticket", { method: "POST", body: {} })
          .then(({ ticket }) => callback({ ticket }))
          .catch(() => callback({ ticket: "" }));
      },
    });
    socket.on("connect", notifyChatUnreadChanged);
    socket.on("message:new", notifyChatUnreadChanged);
    socket.connect();
    return () => { socket.disconnect(); };
  }, [currentUserId]);

  useEffect(() => {
    if (!isAccountMenuOpen && !isNotificationsOpen && !isMessagesOpen) return;

    function closeOnOutsidePointer(event: PointerEvent) {
      if (event.target instanceof Node && !accountMenuRef.current?.contains(event.target)) {
        setIsAccountMenuOpen(false);
        setIsNotificationsOpen(false);
        setIsMessagesOpen(false);
      }
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (isPushSettingsOpen) {
          setIsPushSettingsOpen(false);
          pushSettingsButtonRef.current?.focus();
          return;
        }
        setIsAccountMenuOpen(false);
        setIsNotificationsOpen(false);
        setIsMessagesOpen(false);
        if (isAccountMenuOpen) accountButtonRef.current?.focus();
        else if (isNotificationsOpen) notificationsButtonRef.current?.focus();
        else messagesButtonRef.current?.focus();
      }
    }

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [isAccountMenuOpen, isNotificationsOpen, isMessagesOpen, isPushSettingsOpen]);

  useEffect(() => {
    if (!isMessagesOpen || !currentUserId) return;
    let active = true;
    setMessagesLoading(true);
    void Promise.all([
      apiFetch<FriendListResponse>("/api/friends?limit=12").catch(() => null),
      apiFetch<GroupConversationsResponse>("/api/chats/groups").catch(() => null),
    ]).then(async ([friendResult, groupResult]) => {
      if (!active) return;
      const friends = friendResult?.items ?? [];
      setMessageFriends(friends);
      setMessageGroups((groupResult?.items ?? []).sort((left, right) =>
        (right.latestMessage?.createdAt ?? right.createdAt).localeCompare(left.latestMessage?.createdAt ?? left.createdAt),
      ));
      const summaries = await Promise.all(friends.map(async (friend) => {
        try {
          const history = await apiFetch<MessageHistoryResponse>(`/api/chats/${encodeURIComponent(friend.id)}/messages?limit=1`);
          return [friend.id, history.items[0] ?? null] as const;
        } catch {
          return [friend.id, null] as const;
        }
      }));
      if (active) {
        const previews = Object.fromEntries(summaries);
        setMessagePreviews(previews);
        setMessageFriends([...friends].sort((left, right) =>
          (previews[right.id]?.createdAt ?? "").localeCompare(previews[left.id]?.createdAt ?? ""),
        ));
      }
    }).finally(() => {
      if (active) setMessagesLoading(false);
    });
    return () => { active = false; };
  }, [isMessagesOpen, currentUserId]);

  async function handleSignOut() {
    setPending(true);
    setError(null);
    try {
      try {
        const registration = await navigator.serviceWorker?.getRegistration("/");
        const subscription = await registration?.pushManager.getSubscription();
        if (subscription) {
          await apiFetch<void>("/api/notifications/push-subscription", {
            method: "DELETE",
            body: { endpoint: subscription.endpoint },
          }).catch(() => undefined);
          await subscription.unsubscribe().catch(() => false);
          setPushState("available");
        }
      } catch {
        // Signing out remains available when this device is offline.
      }
      await signOut();
      setIsAccountMenuOpen(false);
      setIsNotificationsOpen(false);
      setIsMessagesOpen(false);
      navigate("/login", { replace: true });
    } catch {
      setError("We couldn’t sign you out. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  }

  async function handleInstall() {
    setInstallMessage(null);
    try {
      const outcome = await install();
      if (outcome === "accepted") {
        setIsAccountMenuOpen(false);
      } else if (outcome === "dismissed") {
        setInstallMessage("Installation was cancelled. You can try again anytime.");
      } else {
        setInstallMessage("Install Senderi from your browser menu by choosing Add to Home Screen or Install app.");
      }
    } catch {
      setInstallMessage("Senderi couldn’t start the installer. Try Install app from your browser menu.");
    }
  }

  async function handleReadAllNotifications() {
    try {
      await apiFetch<void>("/api/notifications/read-all", { method: "PATCH" });
      setNotifications((items) => items.map((item) => ({ ...item, isRead: true })));
      setUnreadNotificationCount(0);
      setNotificationError(null);
    } catch {
      setNotificationError("Notifications couldn’t be updated. Please try again.");
    }
  }

  async function handlePushNotifications() {
    if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
      setPushState("unsupported");
      return;
    }
    setPushWorking(true);
    setPushMessage(null);
    try {
      if (pushState === "enabled") {
        const registration = await navigator.serviceWorker.getRegistration("/");
        const subscription = await registration?.pushManager.getSubscription();
        if (subscription) {
          await apiFetch<void>("/api/notifications/push-subscription", {
            method: "DELETE",
            body: { endpoint: subscription.endpoint },
          });
          setPushState("available");
          await subscription.unsubscribe().catch(() => false);
        }
        setPushState("available");
        setPushMessage("Phone notifications are off.");
        return;
      }

      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setPushState(permission === "denied" ? "denied" : "available");
        setPushMessage(permission === "denied" ? "Allow notifications for Senderi in your browser or phone settings." : "Allow notifications to turn on phone alerts.");
        return;
      }

      const { publicKey } = await apiFetch<{ publicKey: string | null }>("/api/notifications/push/public-key");
      if (!publicKey) {
        setPushState("not-configured");
        setPushMessage("Phone notifications are not configured for Senderi yet.");
        return;
      }
      let registration = await navigator.serviceWorker.getRegistration("/");
      if (!registration && import.meta.env.PROD) registration = await navigator.serviceWorker.ready;
      if (!registration) {
        setPushState("unavailable");
        setPushMessage("Install or update Senderi on this device, then try again.");
        return;
      }
      const subscription = await registration.pushManager.getSubscription() ?? await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodeVapidKey(publicKey),
      });
      await apiFetch<void>("/api/notifications/push-subscription", {
        method: "PUT",
        body: subscription.toJSON(),
      });
      setPushState("enabled");
      setPushMessage("Phone notifications are on.");
    } catch {
      setPushMessage("Phone notifications couldn’t be updated. Please try again.");
    } finally {
      setPushWorking(false);
    }
  }

  function dismissPushPrompt() {
    if (currentUserId) {
      try {
        window.sessionStorage.setItem(`senderi:push-prompt-dismissed:${currentUserId}`, "true");
      } catch {
        // Dismissing the prompt still works when browser storage is disabled.
      }
    }
    setIsPushPromptOpen(false);
  }

  async function enablePushFromPrompt() {
    await handlePushNotifications();
    if (!("Notification" in window) || Notification.permission !== "default") dismissPushPrompt();
  }

  async function handleOpenNotification(notification: NotificationItem) {
    setIsNotificationsOpen(false);
    if (!notification.isRead) {
      setNotifications((items) => items.map((item) =>
        item.id === notification.id ? { ...item, isRead: true } : item,
      ));
      setUnreadNotificationCount((count) => Math.max(0, count - 1));
      void apiFetch<void>(`/api/notifications/${notification.id}/read`, { method: "PATCH" }).catch(() => {
        setNotificationError("This notification couldn’t be marked as read.");
      });
    }
    if (notification.type === "report_update") {
      navigate("/reports");
    } else if (notification.type === "friend_request" || notification.type === "friend_accepted") {
      navigate("/friends");
    } else if (notification.postId) {
      const query = new URLSearchParams();
      if (notification.shareId) query.set("shareId", notification.shareId);
      if (notification.type === "post_comment" || notification.type === "post_mention") query.set("comments", "1");
      const queryString = query.toString();
      navigate(`/posts/${encodeURIComponent(notification.postId)}${queryString ? `?${queryString}` : ""}`);
    }
  }

  const filteredMessageFriends = messageFriends.filter((friend) => {
    const preview = messagePreviews[friend.id];
    const text = `${friend.displayName} ${preview?.text ?? ""}`;
    return text.toLocaleLowerCase().includes(messageSearch.trim().toLocaleLowerCase()) &&
      (messageFilter === "all" || (messageUnreadCounts[friend.id] ?? 0) > 0);
  });
  const filteredMessageGroups = messageGroups.filter((group) => {
    const preview = group.latestMessage;
    const searchableText = `${group.name} ${group.participants.map((participant) => participant.displayName).join(" ")} ${preview?.text ?? ""}`;
    return searchableText.toLocaleLowerCase().includes(messageSearch.trim().toLocaleLowerCase()) &&
      (messageFilter === "all" || (messageUnreadCounts[`group:${group.id}`] ?? group.unreadCount) > 0);
  });
  const hasFilteredMessages = filteredMessageFriends.length > 0 || filteredMessageGroups.length > 0;
  const hasAnyMessages = messageFriends.length > 0 || messageGroups.length > 0;
  const { presenceById, now: presenceNow } = useFriendPresence(messageFriends.map((friend) => friend.id), isMessagesOpen);
  const unreadMessageCount = Object.values(messageUnreadCounts).reduce((total, count) => total + count, 0);

  return (
    <div className="relative flex items-center gap-3" ref={accountMenuRef}>
      {isLoading ? (
        <SkeletonRegion message="Restoring session" className="skeleton-header-actions"><div className="skeleton-header-icons"><SkeletonBlock className="skeleton-avatar" /><SkeletonBlock className="skeleton-avatar" /><SkeletonBlock className="skeleton-avatar" /></div></SkeletonRegion>
      ) : user ? (
        <>
          <MobileMainNavigation />
          <NavLink
            ref={messagesButtonRef}
            className={({ isActive }) => `icon-button header-messages-link${isActive || isMessagesOpen ? " header-icon-active" : ""}`}
            to="/messages"
            onClick={(event) => {
              event.preventDefault();
              if (!isMessagesOpen) notifyChatUnreadChanged();
              setIsAccountMenuOpen(false);
              setIsNotificationsOpen(false);
              setIsMessagesOpen((open) => !open);
            }}
            aria-expanded={isMessagesOpen}
            aria-controls={messagesPanelId}
            aria-haspopup="dialog"
            aria-label={unreadMessageCount > 0 ? `Messages, ${unreadMessageCount} unread` : "Messages"}
            title="Messages"
          >
            <Icon name="message" size={19} />
            {unreadMessageCount > 0 && (
              <span className="header-notification-badge" aria-hidden="true">
                {unreadMessageCount > 99 ? "99+" : unreadMessageCount}
              </span>
            )}
          </NavLink>
          <div id={messagesPanelId} className="header-messages-panel" role="dialog" aria-label="Messages" hidden={!isMessagesOpen}>
            <div className="header-messages-heading">
              <h2>Chats</h2>
            </div>
            <label className="header-messages-search">
              <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 5 5" /></svg>
              <span className="sr-only">Search messages</span>
              <input value={messageSearch} onChange={(event) => setMessageSearch(event.target.value)} placeholder="Search Messenger" />
            </label>
            <div className="header-messages-tabs" role="tablist" aria-label="Chat filters">
              <button className={messageFilter === "all" ? "header-messages-tab-active" : ""} type="button" role="tab" aria-selected={messageFilter === "all"} onClick={() => setMessageFilter("all")}>All</button>
              <button className={messageFilter === "unread" ? "header-messages-tab-active" : ""} type="button" role="tab" aria-selected={messageFilter === "unread"} onClick={() => setMessageFilter("unread")}>Unread</button>
            </div>
            <div className="header-messages-list" aria-live="polite">
              {messagesLoading ? <CompactRowsSkeleton message="Loading chats" count={4} /> : null}
              {!messagesLoading && !hasFilteredMessages && <p className="header-messages-empty">{messageFilter === "unread" ? "No unread messages." : !hasAnyMessages ? "Your chats will appear here." : "No chats match your search."}</p>}
              {!messagesLoading && filteredMessageGroups.length > 0 && (
                <section className="header-messages-section" aria-label="Group chats">
                  <p className="header-messages-section-label">Chats</p>
                  {filteredMessageGroups.map((group) => {
                    const preview = group.latestMessage;
                    const unreadCount = messageUnreadCounts[`group:${group.id}`] ?? group.unreadCount;
                    const senderName = preview?.senderId === currentUserId
                      ? "You"
                      : group.participants.find((participant) => participant.id === preview?.senderId)?.displayName ?? "Member";
                    const previewText = preview
                      ? `${senderName}: ${preview.text || (preview.photoUrl ? "Photo" : "Message")}`
                      : `${group.participants.length} members`;
                    return (
                      <button className="header-message-row" key={group.id} type="button" onClick={() => { setIsMessagesOpen(false); navigate(`/messages?group=${encodeURIComponent(group.id)}`); }}>
                        <GroupChatAvatar name={group.name} />
                        <span className="header-message-copy"><strong>{group.name}</strong><span>{previewText}</span></span>
                        {unreadCount > 0 && <span className="chat-unread-dot" role="img" aria-label={`${unreadCount} unread messages`} />}
                      </button>
                    );
                  })}
                </section>
              )}
              {!messagesLoading && filteredMessageFriends.length > 0 && (
                <section className="header-messages-section" aria-label="Friend chats">
                  {filteredMessageFriends.map((friend) => {
                    const preview = messagePreviews[friend.id];
                    const presence = presenceById[friend.id];
                    const lastActive = lastActiveLabel(presence, presenceNow);
                    return (
                      <button className="header-message-row" key={friend.id} type="button" onClick={() => { setIsMessagesOpen(false); navigate(`/messages?friend=${encodeURIComponent(friend.id)}`); }}>
                        <span className="chat-presence-avatar"><span className="header-message-avatar">{friend.avatarUrl ? <img src={friend.avatarUrl} alt="" /> : friend.displayName.trim().charAt(0).toUpperCase()}</span>{presence?.isOnline && <span className="chat-online-dot" role="img" aria-label="Online" />}</span>
                        <span className="header-message-copy"><strong>{friend.displayName} <SupporterBadge user={friend} /></strong><span>{preview ? `${preview.senderId === currentUserId ? "You: " : ""}${preview.text || (preview.photoUrl ? "Photo" : "Message")}` : "Start a conversation"}</span></span>
                        {lastActive && <time className="chat-presence-time" dateTime={presence?.lastActiveAt} title="Last active">{lastActive}</time>}
                        {(messageUnreadCounts[friend.id] ?? 0) > 0 && <span className="chat-unread-dot" role="img" aria-label={`${messageUnreadCounts[friend.id]} unread messages`} />}
                      </button>
                    );
                  })}
                </section>
              )}
            </div>
            <button className="header-messages-see-all" type="button" onClick={() => { setIsMessagesOpen(false); navigate("/messages"); }}>See all in Messages</button>
          </div>
          <button
            ref={notificationsButtonRef}
            className="icon-button header-notification-trigger"
            type="button"
            aria-label="Notifications"
            aria-expanded={isNotificationsOpen}
            aria-controls={notificationsPanelId}
            onClick={() => {
              setIsPushSettingsOpen(false);
              setIsMessagesOpen(false);
              setIsAccountMenuOpen(false);
              setIsNotificationsOpen((open) => {
                if (!open) void refreshNotifications();
                return !open;
              });
            }}
          >
            <Icon name="bell" size={19} />
            {unreadNotificationCount > 0 && (
              <span className="header-notification-badge" aria-label={`${unreadNotificationCount} unread notifications`}>
                {unreadNotificationCount > 99 ? "99+" : unreadNotificationCount}
              </span>
            )}
          </button>
          <div
            id={notificationsPanelId}
            className="header-notifications-panel"
            hidden={!isNotificationsOpen}
            onClick={(event) => {
              const target = event.target;
              if (target instanceof Node && !pushSettingsPanelRef.current?.contains(target) && !pushSettingsButtonRef.current?.contains(target)) {
                setIsPushSettingsOpen(false);
              }
            }}
          >
            <div className="header-notifications-heading">
              <div className="header-notifications-title">
                <h2>Notifications</h2>
                <button
                  ref={pushSettingsButtonRef}
                  className={`header-push-settings-trigger${isPushSettingsOpen ? " header-push-settings-trigger-active" : ""}`}
                  type="button"
                  aria-label="Phone notification settings"
                  aria-expanded={isPushSettingsOpen}
                  aria-controls={pushSettingsPanelId}
                  aria-pressed={pushState === "enabled"}
                  title="Phone notification settings"
                  onClick={() => setIsPushSettingsOpen((open) => !open)}
                >
                  <Icon name="bell" size={16} />
                  {pushState === "enabled" && <span className="header-push-settings-enabled-dot" aria-hidden="true" />}
                </button>
              </div>
              {unreadNotificationCount > 0 && (
                <button className="header-notifications-read-all" type="button" onClick={() => void handleReadAllNotifications()}>Mark all read</button>
              )}
            </div>
            <div
              id={pushSettingsPanelId}
              ref={pushSettingsPanelRef}
              className="header-push-settings-popover"
              role="dialog"
              aria-label="Phone notification settings"
              hidden={!isPushSettingsOpen}
            >
              <div className="header-push-settings-copy">
                <strong>Phone notifications</strong>
                <span>{pushState === "enabled" ? "Get alerts for messages and activity." : pushState === "checking" ? "Checking this device…" : pushState === "unsupported" ? "This browser does not support phone alerts." : pushState === "denied" ? "Allow notifications in your browser or phone settings." : pushState === "not-configured" ? "Phone alerts are not configured for Senderi yet." : pushState === "unavailable" ? "Open Senderi from an installed, updated app." : "Get alerts for messages and activity."}</span>
              </div>
              {(pushState === "enabled" || pushState === "available") && (
                <button type="button" onClick={() => void handlePushNotifications()} disabled={pushWorking}>
                  {pushWorking ? "Please wait…" : pushState === "enabled" ? "Turn off" : "Turn on"}
                </button>
              )}
              {pushMessage && <p className="header-push-message" role="status">{pushMessage}</p>}
            </div>
            {notificationError && <p className="header-notifications-error" role="alert">{notificationError}</p>}
            {notificationsLoading && notifications.length === 0 ? (
              <CompactRowsSkeleton message="Loading notifications" count={3} />
            ) : notifications.length === 0 ? (
              <div className="header-notifications-empty">
                <strong>No notifications yet</strong>
                <p>You’re all caught up. New notifications will appear here.</p>
              </div>
            ) : (
              <div className="header-notifications-list">
                {notifications.map((notification) => (
                  <button
                    className={`header-notification-item${notification.isRead ? "" : " header-notification-unread"}`}
                    key={notification.id}
                    type="button"
                    onClick={() => void handleOpenNotification(notification)}
                  >
                    <span className="header-notification-avatar">
                      {notification.actor.avatarUrl
                        ? <img src={notification.actor.avatarUrl} alt="" />
                        : notification.actor.displayName.trim().charAt(0).toUpperCase()}
                    </span>
                    <span className="header-notification-copy">
                      <span><strong>{notification.actor.displayName} <SupporterBadge user={notification.actor} /></strong> {notificationMessage(notification)}</span>
                      <time dateTime={notification.createdAt}>{formatNotificationTime(notification.createdAt)}</time>
                    </span>
                    {!notification.isRead && <span className="header-notification-unread-dot" aria-hidden="true" />}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            ref={accountButtonRef}
            className="avatar header-profile-trigger"
            type="button"
            aria-label="Open account menu"
            aria-expanded={isAccountMenuOpen}
            aria-controls={accountMenuId}
            onClick={() => {
              setIsNotificationsOpen(false);
              setIsMessagesOpen(false);
              setIsAccountMenuOpen((open) => !open);
            }}
          >
            {user.avatarUrl
              ? <img className="header-avatar-image" src={user.avatarUrl} alt="" />
              : user.displayName.trim().charAt(0).toUpperCase()}
          </button>
          <div id={accountMenuId} className="header-profile-menu" hidden={!isAccountMenuOpen}>
            <Link className="header-profile-menu-identity" to="/profile" onClick={() => setIsAccountMenuOpen(false)}>
              <span className="header-profile-menu-avatar">
                {user.avatarUrl
                  ? <img src={user.avatarUrl} alt="" />
                  : user.displayName.trim().charAt(0).toUpperCase()}
              </span>
              <span className="header-profile-menu-copy">
                <strong>{user.displayName} <SupporterBadge user={user} /></strong>
                <span>View your profile</span>
              </span>
            </Link>
            {!isInstalled && (
              <button
                className="header-profile-menu-install"
                type="button"
                onClick={() => void handleInstall()}
                title={canInstall ? "Install Senderi on this device" : "Install from your browser menu"}
              >
                <Icon name="install" size={18} />
                <span>Install Senderi</span>
              </button>
            )}
            {installMessage && <p className="header-profile-menu-install-message" role="status">{installMessage}</p>}
            <Link className="header-profile-menu-settings" to="/settings" onClick={() => setIsAccountMenuOpen(false)}>
              Settings
            </Link>
            <Link className="header-profile-menu-settings" to="/reports" onClick={() => setIsAccountMenuOpen(false)}>
              My reports
            </Link>
            {user.isAdmin && (
              <Link className="header-profile-menu-admin" to="/admin" onClick={() => setIsAccountMenuOpen(false)}>
                Admin
              </Link>
            )}
            <button
              className="header-profile-menu-signout"
              type="button"
              onClick={() => void handleSignOut()}
              disabled={pending}
            >
              {pending ? "Signing out…" : "Sign out"}
            </button>
            {error && <p className="header-profile-menu-error" role="alert">{error}</p>}
            <SiteFooter placement="menu" />
          </div>
          <dialog
            ref={pushPromptRef}
            className="push-permission-dialog"
            aria-labelledby={pushPromptTitleId}
            aria-describedby={pushPromptDescriptionId}
            onCancel={(event) => { event.preventDefault(); dismissPushPrompt(); }}
          >
            <div className="push-permission-content">
              <span className="push-permission-icon"><Icon name="bell" size={22} /></span>
              <h2 id={pushPromptTitleId}>Turn on notifications?</h2>
              <p id={pushPromptDescriptionId}>Get alerts when someone sends you a message or interacts with your posts.</p>
              {pushMessage && <p className="push-permission-status" role="status">{pushMessage}</p>}
              <div className="push-permission-actions">
                <button className="push-permission-dismiss" type="button" onClick={dismissPushPrompt}>Not now</button>
                <button className="push-permission-enable" type="button" autoFocus disabled={pushWorking} onClick={() => void enablePushFromPrompt()}>
                  {pushWorking ? "Please wait…" : "Turn on notifications"}
                </button>
              </div>
            </div>
          </dialog>
        </>
      ) : (
        <>
          {location.pathname !== "/login" && <Link className="header-link" to="/login">Sign in</Link>}
          {location.pathname !== "/signup" && <Link className="header-action" to="/signup">Create account</Link>}
        </>
      )}
      {isMobileViewport && updateAvailable && createPortal(
        <div className="app-update-notice" role="status">
          <span className="app-update-copy"><strong>Update ready</strong><span>A new version of Senderi is available.</span></span>
          <div className="app-update-actions">
            <button className="app-update-apply" type="button" disabled={updating} onClick={() => void applyUpdate()}>{updating ? "Updating…" : "Update now"}</button>
            <button className="app-update-dismiss" type="button" onClick={dismissUpdate}>Later</button>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

function notificationMessage(notification: Pick<NotificationItem, "type" | "shareId" | "reportStatus" | "reportActionTaken" | "moderatedContentType">): string {
  switch (notification.type) {
    case "post_like": return "liked your post.";
    case "share_like": return "liked a post you shared.";
    case "post_comment": return notification.shareId ? "commented on a shared post." : "commented on your post.";
    case "post_mention": return notification.shareId
      ? "mentioned you in a comment on a shared post."
      : "mentioned you in a comment.";
    case "post_body_mention": return "mentioned you in a post.";
    case "post_share": return notification.shareId ? "reshared a post you shared." : "shared your post.";
    case "friend_request": return "sent you a friend request.";
    case "friend_accepted": return "accepted your friend request.";
    case "report_update": return notification.reportActionTaken
      ? "reviewed your report and took action."
      : notification.reportStatus === "dismissed"
        ? "reviewed and dismissed your report; no action was taken."
        : "reviewed your report; no action was taken.";
    case "content_moderated": return `hid your ${notification.moderatedContentType === "share" ? "shared post" : notification.moderatedContentType ?? "content"} after reviewing a report.`;
    default: return "sent you a notification.";
  }
}

function decodeVapidKey(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = window.atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function formatNotificationTime(value: string): string {
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1_000);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 31_536_000], ["month", 2_592_000], ["week", 604_800],
    ["day", 86_400], ["hour", 3_600], ["minute", 60],
  ];
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const unit = units.find(([, secondsPerUnit]) => Math.abs(seconds) >= secondsPerUnit);
  return unit ? formatter.format(Math.round(seconds / unit[1]), unit[0]) : formatter.format(seconds, "second");
}

function PageLoading() {
  const { pathname } = useLocation();
  const page = pathname === "/messages" ? "messages" : pathname === "/friends" ? "friends" : pathname.startsWith("/profile") ? "profile" : pathname === "/search" ? "search" : ["/login", "/signup", "/forgot-password", "/reset-password"].includes(pathname) ? "account" : "feed";
  return <SessionSkeleton page={page} />;
}

function PublicAccountRoute({ children }: { children: ReactNode }) {
  const { user, isLoading } = useAuth();
  if (isLoading) return <PageLoading />;
  if (user) return <Navigate to="/" replace />;
  return children;
}

function RequireUser({ children, withLayout = true }: { children: ReactNode; withLayout?: boolean }) {
  const { user, isLoading } = useAuth();
  if (isLoading) return <PageLoading />;
  if (!user) return <Navigate to="/login" replace />;
  return withLayout ? <MemberLayout>{children}</MemberLayout> : children;
}

function MemberLayout({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const location = useLocation();
  const isFriendsPage = location.pathname === "/friends";
  const isHomePage = location.pathname === "/";
  const isSearchPage = location.pathname === "/search";
  const isProfilePage = location.pathname.startsWith("/profile");

  return (
    <div className={`flex w-full flex-col gap-6 px-5 py-6 sm:px-8 sm:py-10 lg:flex-row ${isFriendsPage ? "friends-member-layout" : ""} ${isHomePage ? "home-member-layout" : ""} ${isSearchPage ? "search-member-layout" : ""} ${isProfilePage ? "profile-member-layout" : ""}`}>
      {!isFriendsPage && <aside className="member-layout-sidebar lg:-mt-3 lg:w-80 lg:shrink-0">
        <nav aria-label="Main navigation" className="member-primary-nav flex gap-2 overflow-x-auto pb-1 lg:sticky lg:top-8 lg:flex-col lg:overflow-visible">
          {navigation.map((item) => <NavLink
            key={item.to}
            to={item.to}
            aria-label={item.to === "/profile" && user ? `${user.displayName} profile` : item.label}
            className={({ isActive }) => `nav-item${item.to === "/profile" && user ? " nav-profile-item" : ""} ${isActive ? "nav-item-active" : ""}`}
            onClick={item.to === "/" ? requestHomeRefresh : undefined}
          >
            {item.to === "/profile" && user ? (
              <>
                <span className="nav-profile-avatar">
                  {user.avatarUrl
                    ? <img src={user.avatarUrl} alt="" />
                    : user.displayName.trim().charAt(0).toUpperCase()}
                </span>
                <span className="nav-profile-name">{user.displayName} <SupporterBadge user={user} /></span>
              </>
            ) : <><Icon name={item.icon} size={19} /><span className="nav-item-label">{item.label}</span></>}
          </NavLink>)}
        </nav>
        <SiteFooter placement="sidebar" />
      </aside>}
      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}
