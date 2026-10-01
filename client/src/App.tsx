import { useEffect, useState, type ReactNode } from "react";
import { Link, Navigate, NavLink, Route, Routes, useNavigate } from "react-router-dom";
import { ApiError, apiFetch } from "./api/client";
import { EmptyState, LoadingState, RequestErrorState } from "./components/AsyncState";
import { useAuth } from "./auth/AuthContext";
import { ForgotPasswordPage, LoginPage, ResetPasswordPage, SignupPage } from "./pages/AccountPages";
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
  { label: "Home", to: "/", icon: "home" as const },
  { label: "Friends", to: "/friends", icon: "users" as const },
  { label: "Messages", to: "/messages", icon: "message" as const },
  { label: "Profile", to: "/profile", icon: "user" as const },
];

function PlaceholderPage({ title, description, eyebrow = "Senderi space" }: { title: string; description: string; eyebrow?: string }) {
  return (
    <section className="surface-card p-7 sm:p-10">
      <span className="eyebrow">{eyebrow}</span>
      <h1 className="mt-4 max-w-2xl text-3xl font-bold tracking-[-0.04em] text-ink sm:text-5xl">{title}</h1>
      <p className="mt-5 max-w-xl text-base leading-7 text-muted sm:text-lg">{description}</p>
    </section>
  );
}

function HomePage() {
  const [health, setHealth] = useState<"loading" | "ready" | "empty" | "error">("loading");
  const [healthMessage, setHealthMessage] = useState("");

  useEffect(() => {
    let active = true;

    apiFetch<{ status: string }>("/api/health")
      .then((response) => {
        if (active) {
          setHealth(response.status === "ok" ? "ready" : "empty");
        }
      })
      .catch((error: unknown) => {
        if (!active) return;
        setHealth("error");
        setHealthMessage(error instanceof ApiError ? error.message : "The API is unavailable right now.");
      });

    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="space-y-5">
      <section className="hero-card relative overflow-hidden p-7 sm:p-10">
        <div className="relative z-10 max-w-2xl">
          <span className="eyebrow eyebrow-light">Your space to connect</span>
          <h1 className="mt-4 max-w-xl text-4xl font-bold leading-[1.08] tracking-[-0.05em] text-white sm:text-6xl">Make space for the good stuff.</h1>
          <p className="mt-5 max-w-lg text-base leading-7 text-white/70 sm:text-lg">Share a moment, catch up with your people, and keep the little things that matter close.</p>
          <button className="button-accent mt-7" type="button"><Icon name="plus" size={18} /> Create a post</button>
        </div>
      </section>

      <div className="grid gap-5 md:grid-cols-[1.3fr_0.7fr]">
        <section className="surface-card flex min-h-44 flex-col justify-between p-6 sm:p-7">
          <div>
            <p className="text-sm font-semibold text-muted">Your timeline</p>
            <h2 className="mt-2 text-xl font-bold tracking-[-0.03em] text-ink">A fresh start feels good.</h2>
            <p className="mt-2 max-w-md text-sm leading-6 text-muted">When your friends start sharing, their updates will show up here.</p>
          </div>
          <div className="mt-5">
            {health === "loading" && <LoadingState message="Connecting to Senderi..." />}
            {health === "ready" && <div className="api-status"><span className="status-indicator" /> API connected</div>}
            {health === "empty" && <EmptyState title="No API status yet" message="The server returned an empty health response." />}
            {health === "error" && <RequestErrorState title="API unavailable" message={healthMessage} />}
          </div>
          <button className="button-link mt-6" type="button">Find your friends <Icon name="arrow" size={16} /></button>
        </section>
        <section className="accent-card flex min-h-44 flex-col justify-between p-6 sm:p-7">
          <div className="flex items-center justify-between"><span className="text-sm font-semibold text-ink/70">Today’s note</span><span className="sparkle">✦</span></div>
          <p className="mt-8 text-2xl font-bold tracking-[-0.04em] text-ink">Stay curious.<br />Stay connected.</p>
        </section>
      </div>
    </div>
  );
}

export default function App() {
  const { user, isLoading, initializationError, refreshUser } = useAuth();

  return (
    <div className="min-h-screen bg-canvas text-ink">
      <header className="border-b border-line/80 bg-canvas/90 backdrop-blur-xl">
        <div className="mx-auto flex h-[72px] max-w-7xl items-center justify-between px-5 sm:px-8">
          <NavLink to="/" className="flex items-center gap-2 text-xl font-extrabold tracking-[-0.06em] text-ink sm:text-2xl">senderi<span className="text-violet">.</span></NavLink>
          <HeaderActions />
        </div>
      </header>

      {initializationError && !isLoading && (
        <div className="mx-auto mt-4 flex max-w-7xl items-center justify-between gap-4 px-5 sm:px-8" role="status">
          <p className="text-sm text-muted">{initializationError}</p>
          <button className="text-sm font-semibold text-violet hover:text-violet-dark" type="button" onClick={() => void refreshUser()}>Retry</button>
        </div>
      )}

      <Routes>
        <Route path="/" element={isLoading ? <PageLoading /> : user ? <MemberLayout><HomePage /></MemberLayout> : <PublicHomePage />} />
        <Route path="/login" element={<PublicAccountRoute><LoginPage /></PublicAccountRoute>} />
        <Route path="/signup" element={<PublicAccountRoute><SignupPage /></PublicAccountRoute>} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/friends" element={<RequireUser><PlaceholderPage title="Your people, all in one place." description="Friend requests and your connections will appear here." eyebrow="Friends" /></RequireUser>} />
        <Route path="/messages" element={<RequireUser><PlaceholderPage title="Conversations that feel easy." description="Your private conversations will appear here." eyebrow="Messages" /></RequireUser>} />
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

  async function handleSignOut() {
    setPending(true);
    setError(null);
    try {
      await signOut();
      navigate("/login", { replace: true });
    } catch {
      setError("We couldn’t sign you out. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="relative flex items-center gap-3">
      {error && <span className="header-alert" role="alert">{error}</span>}
      {isLoading ? (
        <span className="text-sm font-medium text-muted" role="status">Restoring session…</span>
      ) : user ? (
        <>
          <span className="hidden max-w-40 truncate text-sm font-semibold text-muted sm:inline">{user.displayName}</span>
          <div className="avatar" aria-label={`${user.displayName} profile`}>{user.displayName.trim().charAt(0).toUpperCase()}</div>
          <button className="header-action" type="button" onClick={() => void handleSignOut()} disabled={pending}>{pending ? "Signing out…" : "Sign out"}</button>
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
  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6 px-5 py-6 sm:px-8 sm:py-10 lg:flex-row">
      <aside className="lg:w-56 lg:shrink-0">
        <nav aria-label="Main navigation" className="flex gap-2 overflow-x-auto pb-1 lg:sticky lg:top-8 lg:flex-col lg:overflow-visible">
          <p className="mb-2 hidden px-3 text-[11px] font-bold uppercase tracking-[0.16em] text-muted lg:block">Explore</p>
          {navigation.map((item) => <NavLink key={item.to} to={item.to} className={({ isActive }) => `nav-item ${isActive ? "nav-item-active" : ""}`}><Icon name={item.icon} size={19} />{item.label}</NavLink>)}
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
