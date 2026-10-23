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
        <div className="surface-card skeleton-profile-details">
          <SkeletonBlock className="skeleton-line skeleton-w-24" />
          <SkeletonBlock className="skeleton-line skeleton-w-50 skeleton-heading" />
          <SkeletonBlock className="skeleton-line skeleton-w-40" />
          <div className="skeleton-profile-columns"><div className="skeleton-copy"><SkeletonBlock className="skeleton-line skeleton-w-75" /><SkeletonBlock className="skeleton-line skeleton-w-90" /><SkeletonBlock className="skeleton-line skeleton-w-50" /></div><div className="skeleton-copy"><SkeletonBlock className="skeleton-line skeleton-w-50" /><SkeletonBlock className="skeleton-line skeleton-w-75" /></div></div>
          <div className="skeleton-profile-tabs">{rows.slice(0, 3).map((row) => <SkeletonBlock className="skeleton-profile-tab" key={row} />)}</div>
        </div>
        <div className="skeleton-profile-posts"><SkeletonBlock className="skeleton-line skeleton-w-24" /><SkeletonBlock className="skeleton-line skeleton-heading skeleton-w-40" /><div className="surface-card skeleton-post"><div className="skeleton-person"><SkeletonBlock className="skeleton-avatar" /><div className="skeleton-copy"><SkeletonBlock className="skeleton-line skeleton-w-40" /><SkeletonBlock className="skeleton-line skeleton-w-24" /></div><SkeletonBlock className="skeleton-post-options" /></div><SkeletonBlock className="skeleton-line skeleton-w-50" /><SkeletonBlock className="skeleton-post-media" /><div className="skeleton-post-actions"><SkeletonBlock className="skeleton-line skeleton-w-20" /><SkeletonBlock className="skeleton-line skeleton-w-20" /><SkeletonBlock className="skeleton-line skeleton-w-20" /></div></div></div>
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

function SessionNavigationSkeleton({ page }: { page: "feed" | "profile" | "search" }) {
  return (
    <aside className="skeleton-session-nav">
      <SkeletonBlock className="skeleton-line skeleton-nav-eyebrow" />
      <div className={`skeleton-nav-profile${page === "profile" ? " skeleton-nav-link-active" : ""}`}>
        <SkeletonBlock className="skeleton-avatar skeleton-nav-profile-avatar" />
        <SkeletonBlock className="skeleton-line skeleton-nav-profile-name" />
      </div>
      <div className={`skeleton-nav-link${page === "feed" ? " skeleton-nav-link-active" : ""}`}>
        <SkeletonBlock className="skeleton-nav-icon" />
        <SkeletonBlock className="skeleton-line skeleton-nav-home-label" />
      </div>
      <div className="skeleton-nav-link">
        <SkeletonBlock className="skeleton-nav-icon" />
        <SkeletonBlock className="skeleton-line skeleton-nav-friends-label" />
      </div>
    </aside>
  );
}

export function SessionSkeleton({ page = "feed" }: { page?: "feed" | "messages" | "friends" | "profile" | "search" | "account" }) {
  if (page === "friends") {
    return (
      <SkeletonRegion message="Restoring your Senderi session" className="skeleton-session-friends">
        <div className="skeleton-friends-layout">
          <aside className="skeleton-friends-sidebar">
            <SkeletonBlock className="skeleton-friends-title" />
            <div className="skeleton-friends-nav">
              {rows.slice(0, 4).map((row) => (
                <div className={`skeleton-friends-nav-item${row === 0 ? " skeleton-friends-nav-item-active" : ""}`} key={row}>
                  <SkeletonBlock className="skeleton-friends-nav-icon" />
                  <SkeletonBlock className="skeleton-line skeleton-friends-nav-label" />
                </div>
              ))}
            </div>
          </aside>
          <main className="skeleton-friends-main">
            {[0, 1].map((section) => (
              <section className="skeleton-friends-section" key={section}>
                <div className="skeleton-friends-section-heading">
                  <div className="skeleton-friends-section-copy">
                    <SkeletonBlock className="skeleton-line skeleton-friends-section-title" />
                    <SkeletonBlock className="skeleton-line skeleton-friends-section-subtitle" />
                  </div>
                  <SkeletonBlock className="skeleton-line skeleton-friends-see-all" />
                </div>
                <div className="friends-card-grid">
                  {rows.slice(0, 6).map((row) => (
                    <div className="friends-profile-card" key={row}>
                      <SkeletonBlock className="skeleton-friend-photo" />
                      <div className="friends-profile-content">
                        <SkeletonBlock className="skeleton-line skeleton-w-75" />
                        <SkeletonBlock className="skeleton-line skeleton-w-50" />
                        <div className="skeleton-friend-actions"><SkeletonBlock className="skeleton-button" /><SkeletonBlock className="skeleton-button" /></div>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </main>
        </div>
      </SkeletonRegion>
    );
  }

  if (page === "messages") {
    return (
      <SkeletonRegion message="Restoring your Senderi session" className="skeleton-session-messages">
        <div className="messages-shell">
          <aside className="messages-sidebar">
            <div className="messages-sidebar-heading"><SkeletonBlock className="skeleton-line skeleton-heading skeleton-w-40" /><SkeletonBlock className="skeleton-message-compose" /></div>
            <div className="messages-page-search"><SkeletonBlock className="skeleton-input" /></div>
            <div className="messages-page-tabs"><SkeletonBlock className="skeleton-message-tab skeleton-message-tab-active" /><SkeletonBlock className="skeleton-message-tab skeleton-message-tab-wide" /></div>
            <div className="messages-page-requests"><SkeletonBlock className="skeleton-message-request-icon" /><span><SkeletonBlock className="skeleton-line skeleton-message-request-title" /><SkeletonBlock className="skeleton-line skeleton-message-request-copy" /></span><SkeletonBlock className="skeleton-message-request-arrow" /></div>
            <div className="messages-page-list"><ChatListSkeleton count={5} /></div>
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
        <SessionNavigationSkeleton page={page} />
        <main className="skeleton-session-content">
          {page === "profile" ? (
            <>
              <div className="skeleton-profile-cover"><SkeletonBlock className="skeleton-cover" /><SkeletonBlock className="skeleton-avatar skeleton-profile-avatar" /></div>
              <div className="surface-card skeleton-profile-details">
                <SkeletonBlock className="skeleton-line skeleton-w-24" />
                <SkeletonBlock className="skeleton-line skeleton-heading skeleton-w-50" />
                <SkeletonBlock className="skeleton-line skeleton-w-40" />
                <div className="skeleton-profile-columns"><div className="skeleton-copy"><SkeletonBlock className="skeleton-line skeleton-w-75" /><SkeletonBlock className="skeleton-line skeleton-w-90" /></div><div className="skeleton-copy"><SkeletonBlock className="skeleton-line skeleton-w-50" /><SkeletonBlock className="skeleton-line skeleton-w-75" /></div></div>
                <div className="skeleton-profile-tabs">{rows.slice(0, 3).map((row) => <SkeletonBlock className="skeleton-profile-tab" key={row} />)}</div>
              </div>
              <div className="skeleton-profile-posts">
                <SkeletonBlock className="skeleton-line skeleton-w-24" />
                <SkeletonBlock className="skeleton-line skeleton-heading skeleton-w-40" />
                <div className="surface-card skeleton-post"><div className="skeleton-person"><SkeletonBlock className="skeleton-avatar" /><div className="skeleton-copy"><SkeletonBlock className="skeleton-line skeleton-w-40" /><SkeletonBlock className="skeleton-line skeleton-w-24" /></div><SkeletonBlock className="skeleton-post-options" /></div><SkeletonBlock className="skeleton-line skeleton-w-50" /><SkeletonBlock className="skeleton-post-media" /><div className="skeleton-post-actions"><SkeletonBlock className="skeleton-line skeleton-w-20" /><SkeletonBlock className="skeleton-line skeleton-w-20" /><SkeletonBlock className="skeleton-line skeleton-w-20" /></div></div>
              </div>
            </>
          ) : page === "search" ? (
            <><div className="skeleton-search-header"><SkeletonBlock className="skeleton-line skeleton-w-24" /><SkeletonBlock className="skeleton-line skeleton-heading skeleton-w-50" /><SkeletonBlock className="skeleton-line skeleton-w-40" /></div><div className="skeleton-session-search-grid"><div className="search-results-section"><SkeletonBlock className="skeleton-line skeleton-w-40" />{rows.slice(0, 4).map((row) => <div className="skeleton-person skeleton-compact-row" key={row}><SkeletonBlock className="skeleton-avatar" /><div className="skeleton-copy"><SkeletonBlock className="skeleton-line skeleton-w-50" /><SkeletonBlock className="skeleton-line skeleton-w-75" /></div></div>)}</div><div className="search-results-section skeleton-post"><SkeletonBlock className="skeleton-line skeleton-w-40" /><div className="skeleton-person"><SkeletonBlock className="skeleton-avatar" /><SkeletonBlock className="skeleton-line skeleton-w-50" /></div><SkeletonBlock className="skeleton-line skeleton-w-90" /><SkeletonBlock className="skeleton-post-media" /></div></div></>
          ) : (
            <>
              <div className="surface-card skeleton-session-composer">
                <div className="skeleton-composer-inline">
                  <SkeletonBlock className="skeleton-avatar" />
                  <SkeletonBlock className="skeleton-composer-textarea" />
                  <div className="skeleton-composer-actions">
                    <SkeletonBlock className="skeleton-composer-options" />
                    <SkeletonBlock className="skeleton-composer-options" />
                  </div>
                </div>
              </div>
              <div className="skeleton-session-feed-stream">
                <div className="skeleton-feed-heading"><SkeletonBlock className="skeleton-line skeleton-feed-eyebrow" /><SkeletonBlock className="skeleton-line skeleton-heading skeleton-feed-title" /></div>
                <div className="skeleton-post-list">
                  {rows.slice(0, 2).map((row) => (
                    <article className="surface-card skeleton-post" key={row}>
                      <div className="skeleton-person"><SkeletonBlock className="skeleton-avatar" /><div className="skeleton-copy"><SkeletonBlock className="skeleton-line skeleton-w-40" /><SkeletonBlock className="skeleton-line skeleton-w-24" /></div><SkeletonBlock className="skeleton-post-options" /></div>
                      <div className="skeleton-copy skeleton-post-copy"><SkeletonBlock className="skeleton-line skeleton-w-50" /></div>
                      {row === 0 && <SkeletonBlock className="skeleton-post-media" />}
                      <div className="skeleton-post-actions"><SkeletonBlock className="skeleton-line" /><SkeletonBlock className="skeleton-line" /><SkeletonBlock className="skeleton-line" /></div>
                    </article>
                  ))}
                </div>
              </div>
            </>
          )}
        </main>
      </div>
    </SkeletonRegion>
  );
}
