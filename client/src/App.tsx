import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link, Navigate, NavLink, Route, Routes, useNavigate } from "react-router-dom";
import type { NotificationItem, NotificationsResponse } from "../../shared";
import { apiFetch } from "./api/client";
import { LoadingState } from "./components/AsyncState";
import { PostComposer, PostList } from "./components/Posts";
import { useAuth } from "./auth/AuthContext";
import { ForgotPasswordPage, LoginPage, ResetPasswordPage, SignupPage } from "./pages/AccountPages";
import { FriendsPage } from "./pages/FriendsPage";
import { MessagesPage } from "./pages/MessagesPage";
import { ProfilePage } from "./pages/ProfilePage";

type IconName = "home" | "users" | "message" | "user" | "bell" | "plus" | "arrow";

function Icon({ name, size = 19 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, React.ReactNode> = {
    home: <><path d="m3 10 9-7 9 7" /><path d="M5 9v10h14V9" /><path d="M9 19v-6h6v6" /></>,
    users: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></>,
    message: <><path d="M21 11.5a8.38 8.38 0 0 1-9 8.5 9.62 9.62 0 0 1-4-.8L3 21l1.8-4A8.3 8.3 0 0 1 3 11.5 8.38 8.38 0 0 1 12 3a8.38 8.38 0 0 1 9 8.5Z" /><path d="M8 11h.01M12 11h.01M16 11h.01" /></>,
    user: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
    bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" /><path d="M10 21h4" /></>,
    plus: <><path d="M12 5v14M5 12h14" /></>,
    arrow: <><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></>,
  };

  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

const navigation = [
  { label: "Profile", to: "/profile", icon: "user" as const },
  { label: "Home", to: "/", icon: "home" as const },
  { label: "Friends", to: "/friends", icon: "users" as const },
];

function HomePage() {
  const [refreshKey, setRefreshKey] = useState(0);

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

export default function App() {
  const { user, isLoading, initializationError, refreshUser } = useAuth();

  return (
    <div className="min-h-screen bg-canvas text-ink">
      <header className="relative z-40 border-b border-line/80 bg-canvas/90 backdrop-blur-xl">
        <div className="flex h-[72px] w-full items-center justify-between px-5 sm:px-8">
          <NavLink to="/" className="flex items-center gap-2 text-xl font-extrabold tracking-[-0.06em] text-ink sm:text-2xl">senderi<span className="text-accent">.</span></NavLink>
          <HeaderActions />
        </div>
      </header>

      {initializationError && !isLoading && (
        <div className="mx-auto mt-4 flex max-w-7xl items-center justify-between gap-4 px-5 sm:px-8" role="status">
          <p className="text-sm text-muted">{initializationError}</p>
          <button className="text-sm font-semibold text-accent hover:text-accent-dark" type="button" onClick={() => void refreshUser()}>Retry</button>
        </div>
      )}

      <Routes>
        <Route path="/" element={isLoading ? <PageLoading /> : user ? <MemberLayout><HomePage /></MemberLayout> : <PublicHomePage />} />
        <Route path="/login" element={<PublicAccountRoute><LoginPage /></PublicAccountRoute>} />
        <Route path="/signup" element={<PublicAccountRoute><SignupPage /></PublicAccountRoute>} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/friends" element={<RequireUser><FriendsPage /></RequireUser>} />
        <Route path="/messages" element={<RequireUser><MessagesPage /></RequireUser>} />
        <Route path="/profile" element={<RequireUser><ProfilePage /></RequireUser>} />
        <Route path="/profile/:userId" element={<RequireUser><ProfilePage /></RequireUser>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}

function HeaderActions() {
  const { user, isLoading, signOut } = useAuth();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isAccountMenuOpen, setIsAccountMenuOpen] = useState(false);
  const [isNotificationsOpen, setIsNotificationsOpen] = useState(false);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [unreadNotificationCount, setUnreadNotificationCount] = useState(0);
  const [notificationsLoading, setNotificationsLoading] = useState(false);
  const [notificationError, setNotificationError] = useState<string | null>(null);
  const accountMenuId = useId();
  const notificationsPanelId = useId();
  const accountMenuRef = useRef<HTMLDivElement>(null);
  const accountButtonRef = useRef<HTMLButtonElement>(null);
  const notificationsButtonRef = useRef<HTMLButtonElement>(null);
  const currentUserId = user?.id;

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
    if (!isAccountMenuOpen && !isNotificationsOpen) return;

    function closeOnOutsidePointer(event: PointerEvent) {
      if (event.target instanceof Node && !accountMenuRef.current?.contains(event.target)) {
        setIsAccountMenuOpen(false);
        setIsNotificationsOpen(false);
      }
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsAccountMenuOpen(false);
        setIsNotificationsOpen(false);
        if (isAccountMenuOpen) accountButtonRef.current?.focus();
        else notificationsButtonRef.current?.focus();
      }
    }

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [isAccountMenuOpen, isNotificationsOpen]);

  async function handleSignOut() {
    setPending(true);
    setError(null);
    try {
      await signOut();
      setIsAccountMenuOpen(false);
      setIsNotificationsOpen(false);
      navigate("/login", { replace: true });
    } catch {
      setError("We couldn’t sign you out. Check your connection and try again.");
    } finally {
      setPending(false);
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

  async function handleOpenNotification(notification: NotificationItem) {
    setIsNotificationsOpen(false);
    if (!notification.isRead) {
      try {
        await apiFetch<void>(`/api/notifications/${notification.id}/read`, { method: "PATCH" });
        setNotifications((items) => items.map((item) =>
          item.id === notification.id ? { ...item, isRead: true } : item,
        ));
        setUnreadNotificationCount((count) => Math.max(0, count - 1));
      } catch {
        setNotificationError("This notification couldn’t be marked as read.");
      }
    }
    if (notification.type === "friend_request" || notification.type === "friend_accepted") {
      navigate("/friends");
    } else if (notification.postId) {
      navigate(`/#post-${notification.postId}`);
    }
  }

  return (
    <div className="relative flex items-center gap-3" ref={accountMenuRef}>
      {isLoading ? (
        <span className="text-sm font-medium text-muted" role="status">Restoring session…</span>
      ) : user ? (
        <>
          <NavLink
            className={({ isActive }) => `icon-button header-messages-link${isActive ? " header-icon-active" : ""}`}
            to="/messages"
            aria-label="Messages"
            title="Messages"
            onClick={() => {
              setIsAccountMenuOpen(false);
              setIsNotificationsOpen(false);
            }}
          >
            <Icon name="message" size={19} />
          </NavLink>
          <button
            ref={notificationsButtonRef}
            className="icon-button header-notification-trigger"
            type="button"
            aria-label="Notifications"
            aria-expanded={isNotificationsOpen}
            aria-controls={notificationsPanelId}
            onClick={() => {
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
          <div id={notificationsPanelId} className="header-notifications-panel" hidden={!isNotificationsOpen}>
            <div className="header-notifications-heading">
              <h2>Notifications</h2>
              {unreadNotificationCount > 0 && (
                <button type="button" onClick={() => void handleReadAllNotifications()}>Mark all read</button>
              )}
            </div>
            {notificationError && <p className="header-notifications-error" role="alert">{notificationError}</p>}
            {notificationsLoading && notifications.length === 0 ? (
              <p>Loading notifications…</p>
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
                      <span><strong>{notification.actor.displayName}</strong> {notificationMessage(notification.type)}</span>
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
                <strong>{user.displayName}</strong>
                <span>View your profile</span>
              </span>
            </Link>
            <button
              className="header-profile-menu-signout"
              type="button"
              onClick={() => void handleSignOut()}
              disabled={pending}
            >
              {pending ? "Signing out…" : "Sign out"}
            </button>
            {error && <p className="header-profile-menu-error" role="alert">{error}</p>}
          </div>
        </>
      ) : (
        <>
          <Link className="header-link" to="/login">Sign in</Link>
          <Link className="header-action" to="/signup">Create account</Link>
        </>
      )}
    </div>
  );
}

function notificationMessage(type: NotificationItem["type"]): string {
  switch (type) {
    case "post_like": return "liked your post.";
    case "share_like": return "liked your shared post.";
    case "post_comment": return "commented on your post.";
    case "post_share": return "shared your post.";
    case "friend_request": return "sent you a friend request.";
    case "friend_accepted": return "accepted your friend request.";
    default: return "sent you a notification.";
  }
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
  return <main className="mx-auto flex min-h-[55vh] max-w-7xl items-center px-5 sm:px-8"><LoadingState message="Restoring your Senderi session…" /></main>;
}

function PublicAccountRoute({ children }: { children: ReactNode }) {
  const { user, isLoading } = useAuth();
  if (isLoading) return <PageLoading />;
  if (user) return <Navigate to="/" replace />;
  return children;
}

function RequireUser({ children }: { children: ReactNode }) {
  const { user, isLoading } = useAuth();
  if (isLoading) return <PageLoading />;
  if (!user) return <Navigate to="/login" replace />;
  return <MemberLayout>{children}</MemberLayout>;
}

function MemberLayout({ children }: { children: ReactNode }) {
  const { user } = useAuth();

  return (
    <div className="flex w-full flex-col gap-6 px-5 py-6 sm:px-8 sm:py-10 lg:flex-row">
      <aside className="lg:w-56 lg:shrink-0">
        <nav aria-label="Main navigation" className="flex gap-2 overflow-x-auto pb-1 lg:sticky lg:top-8 lg:flex-col lg:overflow-visible">
          <p className="mb-2 hidden px-3 text-[11px] font-bold uppercase tracking-[0.16em] text-muted lg:block">Explore</p>
          {navigation.map((item) => <NavLink
            key={item.to}
            to={item.to}
            aria-label={item.to === "/profile" && user ? `${user.displayName} profile` : undefined}
            className={({ isActive }) => `nav-item${item.to === "/profile" && user ? " nav-profile-item" : ""} ${isActive ? "nav-item-active" : ""}`}
          >
            {item.to === "/profile" && user ? (
              <>
                <span className="nav-profile-avatar">
                  {user.avatarUrl
                    ? <img src={user.avatarUrl} alt="" />
                    : user.displayName.trim().charAt(0).toUpperCase()}
                </span>
                <span className="nav-profile-name">{user.displayName}</span>
              </>
            ) : <><Icon name={item.icon} size={19} />{item.label}</>}
          </NavLink>)}
        </nav>
      </aside>
      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}

function PublicHomePage() {
  return (
    <main className="mx-auto max-w-7xl px-5 py-7 sm:px-8 sm:py-12">
      <section className="hero-card relative overflow-hidden p-7 sm:p-12 lg:min-h-[420px]">
        <div className="relative z-10 max-w-2xl">
          <span className="eyebrow eyebrow-light">Your space to connect</span>
          <h1 className="mt-4 max-w-xl font-display text-4xl font-bold leading-[1.08] tracking-[-0.055em] text-white sm:text-6xl">Make space for the good stuff.</h1>
          <p className="mt-5 max-w-lg text-base leading-7 text-white/70 sm:text-lg">Share a moment, catch up with your people, and keep the little things that matter close.</p>
          <div className="mt-8 flex flex-wrap items-center gap-4">
            <Link className="button-accent" to="/signup">Create your account <Icon name="arrow" size={16} /></Link>
            <Link className="font-semibold text-white/85 transition hover:text-white" to="/login">I already have an account</Link>
          </div>
        </div>
        <div className="hero-orbit hero-orbit-one" aria-hidden="true" />
        <div className="hero-orbit hero-orbit-two" aria-hidden="true" />
      </section>
      <div className="mt-5 grid gap-5 md:grid-cols-3">
        <section className="surface-card p-6"><span className="eyebrow">Share</span><h2 className="mt-3 font-display text-xl font-bold text-ink">Keep the moments</h2><p className="mt-2 text-sm leading-6 text-muted">Post a thought or a photo for the people you choose.</p></section>
        <section className="surface-card p-6"><span className="eyebrow">Connect</span><h2 className="mt-3 font-display text-xl font-bold text-ink">Find your circle</h2><p className="mt-2 text-sm leading-6 text-muted">Build a space with friends and people you care about.</p></section>
        <section className="surface-card p-6"><span className="eyebrow">Belong</span><h2 className="mt-3 font-display text-xl font-bold text-ink">Make it yours</h2><p className="mt-2 text-sm leading-6 text-muted">Create an account and shape your own Senderi profile.</p></section>
      </div>
    </main>
  );
}
