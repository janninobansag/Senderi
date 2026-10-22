import type { ReactNode } from "react";

const rows = [0, 1, 2, 3, 4, 5];

export function SkeletonBlock({ className = "" }: { className?: string }) {
  return <span className={`skeleton-block ${className}`} />;
}

export function SkeletonRegion({ message, className = "", children }: {
  message: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`skeleton-region ${className}`} role="status">
      <span className="sr-only">{message}</span>
      <div aria-hidden="true">{children}</div>
    </div>
  );
}

export function PostListSkeleton({ count = 2 }: { count?: number }) {
  return (
    <SkeletonRegion message="Loading posts" className="skeleton-post-list">
      <div className="skeleton-stack">
        {rows.slice(0, count).map((row) => (
          <article className="surface-card skeleton-post" key={row}>
            <div className="skeleton-person"><SkeletonBlock className="skeleton-avatar" /><div className="skeleton-copy"><SkeletonBlock className="skeleton-line skeleton-w-40" /><SkeletonBlock className="skeleton-line skeleton-w-24" /></div></div>
            <div className="skeleton-copy skeleton-post-copy"><SkeletonBlock className="skeleton-line skeleton-w-90" /><SkeletonBlock className="skeleton-line skeleton-w-65" /></div>
            {row === 0 && <SkeletonBlock className="skeleton-post-media" />}
            <div className="skeleton-post-actions"><SkeletonBlock className="skeleton-line skeleton-w-20" /><SkeletonBlock className="skeleton-line skeleton-w-20" /></div>
          </article>
        ))}
      </div>
    </SkeletonRegion>
  );
}

export function PeopleCardsSkeleton({ count = 6, message = "Loading people", wide = false }: { count?: number; message?: string; wide?: boolean }) {
  return (
    <SkeletonRegion message={message} className={`skeleton-people-grid${wide ? " skeleton-people-grid-wide" : ""}`}>
      <ul className="friends-card-grid">
        {rows.slice(0, count).map((row) => (
          <li className="friends-profile-card" key={row}>
            <SkeletonBlock className="skeleton-friend-photo" />
            <div className="friends-profile-content"><SkeletonBlock className="skeleton-line skeleton-w-75" /><SkeletonBlock className="skeleton-line skeleton-w-50" /><SkeletonBlock className="skeleton-button" /><SkeletonBlock className="skeleton-button" /></div>
          </li>
        ))}
      </ul>
    </SkeletonRegion>
  );
}

export function PeopleRowsSkeleton({ count = 4, message = "Loading people" }: { count?: number; message?: string }) {
  return (
    <SkeletonRegion message={message} className="skeleton-people-rows">
      <div className="skeleton-stack">
        {rows.slice(0, count).map((row) => (
          <div className="skeleton-person skeleton-person-row" key={row}><SkeletonBlock className="skeleton-avatar" /><div className="skeleton-copy"><SkeletonBlock className="skeleton-line skeleton-w-50" /><SkeletonBlock className="skeleton-line skeleton-w-75" /></div></div>
        ))}
      </div>
    </SkeletonRegion>
  );
}

export function ProfileSkeleton() {
  return (
    <SkeletonRegion message="Loading profile" className="skeleton-profile">
      <div className="skeleton-stack">
        <div className="skeleton-profile-cover"><SkeletonBlock className="skeleton-cover" /><SkeletonBlock className="skeleton-avatar skeleton-profile-avatar" /></div>
        <div className="surface-card skeleton-profile-details"><SkeletonBlock className="skeleton-line skeleton-w-24" /><SkeletonBlock className="skeleton-line skeleton-w-50 skeleton-heading" /><SkeletonBlock className="skeleton-line skeleton-w-40" /><div className="skeleton-profile-columns"><div className="skeleton-copy"><SkeletonBlock className="skeleton-line skeleton-w-75" /><SkeletonBlock className="skeleton-line skeleton-w-90" /><SkeletonBlock className="skeleton-line skeleton-w-50" /></div><div className="skeleton-copy"><SkeletonBlock className="skeleton-line skeleton-w-50" /><SkeletonBlock className="skeleton-line skeleton-w-75" /></div></div></div>
        <div className="surface-card skeleton-profile-posts"><SkeletonBlock className="skeleton-line skeleton-w-24" /><SkeletonBlock className="skeleton-line skeleton-heading skeleton-w-40" /><div className="skeleton-post"><div className="skeleton-person"><SkeletonBlock className="skeleton-avatar" /><div className="skeleton-copy"><SkeletonBlock className="skeleton-line skeleton-w-40" /><SkeletonBlock className="skeleton-line skeleton-w-24" /></div></div><SkeletonBlock className="skeleton-line skeleton-w-90" /><SkeletonBlock className="skeleton-line skeleton-w-65" /></div></div>
      </div>
    </SkeletonRegion>
  );
}

export function ChatListSkeleton({ count = 6 }: { count?: number }) {
  return (
    <SkeletonRegion message="Loading chats" className="skeleton-chat-list">
      <div className="skeleton-stack">
        {rows.slice(0, count).map((row) => (
          <div className="skeleton-person skeleton-chat-row" key={row}><SkeletonBlock className="skeleton-avatar" /><div className="skeleton-copy"><SkeletonBlock className="skeleton-line skeleton-w-65" /><SkeletonBlock className="skeleton-line skeleton-w-90" /></div></div>
        ))}
      </div>
    </SkeletonRegion>
  );
}

export function MessageBubblesSkeleton() {
  return (
    <SkeletonRegion message="Loading conversation" className="skeleton-conversation">
      <div className="skeleton-message-stack">
        <SkeletonBlock className="skeleton-message skeleton-message-short" />
        <SkeletonBlock className="skeleton-message skeleton-message-own" />
        <SkeletonBlock className="skeleton-message skeleton-message-medium" />
        <SkeletonBlock className="skeleton-message skeleton-message-own skeleton-message-short" />
      </div>
    </SkeletonRegion>
  );
}

export function CompactRowsSkeleton({ message, count = 4 }: { message: string; count?: number }) {
  return (
    <SkeletonRegion message={message} className="skeleton-compact-list">
      <div className="skeleton-stack">
        {rows.slice(0, count).map((row) => (
          <div className="skeleton-person skeleton-compact-row" key={row}><SkeletonBlock className="skeleton-avatar" /><div className="skeleton-copy"><SkeletonBlock className="skeleton-line skeleton-w-65" /><SkeletonBlock className="skeleton-line skeleton-w-90" /></div></div>
        ))}
      </div>
    </SkeletonRegion>
  );
}

export function CommentsSkeleton() {
  return (
    <SkeletonRegion message="Loading comments" className="skeleton-comments">
      <div className="skeleton-stack">
        {rows.slice(0, 2).map((row) => (
          <div className="skeleton-person skeleton-comment-row" key={row}><SkeletonBlock className="skeleton-avatar" /><div className="skeleton-copy"><SkeletonBlock className="skeleton-line skeleton-w-40" /><SkeletonBlock className="skeleton-line skeleton-w-90" /><SkeletonBlock className="skeleton-line skeleton-w-65" /></div></div>
        ))}
      </div>
    </SkeletonRegion>
  );
}

function SessionNavigationSkeleton() {
  return (
    <aside className="skeleton-session-nav">
      <SkeletonBlock className="skeleton-line skeleton-w-40" />
      {rows.slice(0, 4).map((row) => <SkeletonBlock className="skeleton-nav-item" key={row} />)}
    </aside>
  );
}

export function SessionSkeleton({ page = "feed" }: { page?: "feed" | "messages" | "friends" | "profile" | "search" | "account" }) {
  if (page === "messages") {
    return (
      <SkeletonRegion message="Restoring your Senderi session" className="skeleton-session-messages">
        <div className="messages-shell">
          <aside className="messages-sidebar">
            <SkeletonBlock className="skeleton-line skeleton-heading skeleton-w-40" />
            <SkeletonBlock className="skeleton-input" />
            {rows.slice(0, 5).map((row) => <div className="skeleton-person skeleton-chat-row" key={row}><SkeletonBlock className="skeleton-avatar" /><div className="skeleton-copy"><SkeletonBlock className="skeleton-line skeleton-w-65" /><SkeletonBlock className="skeleton-line skeleton-w-90" /></div></div>)}
          </aside>
          <section className="messages-conversation">
            <div className="skeleton-session-chat-header"><SkeletonBlock className="skeleton-avatar" /><SkeletonBlock className="skeleton-line skeleton-w-24" /></div>
            <div className="skeleton-session-chat-body"><SkeletonBlock className="skeleton-message skeleton-message-short" /><SkeletonBlock className="skeleton-message skeleton-message-own" /><SkeletonBlock className="skeleton-message skeleton-message-medium" /></div>
            <div className="skeleton-session-chat-footer"><SkeletonBlock className="skeleton-input" /></div>
          </section>
          <aside className="messages-info-panel"><SkeletonBlock className="skeleton-avatar skeleton-profile-avatar" /><SkeletonBlock className="skeleton-line skeleton-w-65" /></aside>
        </div>
      </SkeletonRegion>
    );
  }

  if (page === "account") {
    return (
      <SkeletonRegion message="Restoring your Senderi session" className="skeleton-session-account">
        <main className="surface-card skeleton-account-card">
          <SkeletonBlock className="skeleton-line skeleton-w-24" />
          <SkeletonBlock className="skeleton-line skeleton-heading skeleton-w-65" />
          <SkeletonBlock className="skeleton-line skeleton-w-75" />
          <SkeletonBlock className="skeleton-input" />
          <SkeletonBlock className="skeleton-input" />
          <SkeletonBlock className="skeleton-button" />
        </main>
      </SkeletonRegion>
    );
  }

  return (
    <SkeletonRegion message="Restoring your Senderi session" className={`skeleton-session skeleton-session-${page}`}>
      <div className="skeleton-session-layout">
        <SessionNavigationSkeleton />
        <main className="skeleton-session-content">
          {page === "profile" ? (
            <><SkeletonBlock className="skeleton-cover" /><SkeletonBlock className="skeleton-avatar skeleton-profile-avatar" /><div className="surface-card skeleton-profile-details"><SkeletonBlock className="skeleton-line skeleton-heading skeleton-w-50" /><SkeletonBlock className="skeleton-line skeleton-w-75" /><SkeletonBlock className="skeleton-line skeleton-w-65" /></div></>
          ) : page === "friends" ? (
            <><SkeletonBlock className="skeleton-line skeleton-heading skeleton-w-40" /><div className="skeleton-session-cards">{rows.slice(0, 4).map((row) => <div className="friends-profile-card" key={row}><SkeletonBlock className="skeleton-friend-photo" /><div className="friends-profile-content"><SkeletonBlock className="skeleton-line skeleton-w-75" /><SkeletonBlock className="skeleton-button" /></div></div>)}</div></>
          ) : page === "search" ? (
            <><SkeletonBlock className="skeleton-line skeleton-heading skeleton-w-50" /><div className="skeleton-session-search-grid"><div className="search-results-section"><SkeletonBlock className="skeleton-line skeleton-w-40" />{rows.slice(0, 4).map((row) => <div className="skeleton-person skeleton-compact-row" key={row}><SkeletonBlock className="skeleton-avatar" /><div className="skeleton-copy"><SkeletonBlock className="skeleton-line skeleton-w-50" /><SkeletonBlock className="skeleton-line skeleton-w-75" /></div></div>)}</div><div className="search-results-section skeleton-post"><SkeletonBlock className="skeleton-line skeleton-w-40" /><div className="skeleton-person"><SkeletonBlock className="skeleton-avatar" /><SkeletonBlock className="skeleton-line skeleton-w-50" /></div><SkeletonBlock className="skeleton-line skeleton-w-90" /><SkeletonBlock className="skeleton-post-media" /></div></div></>
          ) : (
            <><div className="surface-card skeleton-session-composer"><SkeletonBlock className="skeleton-line skeleton-w-24" /><SkeletonBlock className="skeleton-input" /><SkeletonBlock className="skeleton-line skeleton-w-40" /></div><SkeletonBlock className="skeleton-line skeleton-heading skeleton-w-40" />{rows.slice(0, 2).map((row) => <div className="surface-card skeleton-post" key={row}><div className="skeleton-person"><SkeletonBlock className="skeleton-avatar" /><SkeletonBlock className="skeleton-line skeleton-w-40" /></div><SkeletonBlock className="skeleton-line skeleton-w-90" /><SkeletonBlock className="skeleton-line skeleton-w-65" /></div>)}</>
          )}
        </main>
      </div>
    </SkeletonRegion>
  );
}
