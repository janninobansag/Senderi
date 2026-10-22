import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { FriendListItem, Page, Post, User } from "../../../shared";
import { ApiError, apiFetch } from "../api/client";
import { PostPhotoViewer } from "./Posts";
import { EmptyState, RequestErrorState } from "./AsyncState";
import { SkeletonBlock, SkeletonRegion } from "./Skeletons";

function useProfileCollection<T>(path: string) {
  const [items, setItems] = useState<T[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextPageError, setNextPageError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const requestVersion = useRef(0);

  useEffect(() => {
    let active = true;
    const version = ++requestVersion.current;
    setItems([]);
    setNextCursor(null);
    setIsLoading(true);
    setIsLoadingMore(false);
    setError(null);
    setNextPageError(null);
    void apiFetch<Page<T>>(path).then((page) => {
      if (!active || requestVersion.current !== version) return;
      setItems(page.items);
      setNextCursor(page.nextCursor);
    }).catch((requestError: unknown) => {
      if (active && requestVersion.current === version) {
        setError(requestError instanceof ApiError ? requestError.message : "Could not load this section.");
      }
    }).finally(() => {
      if (active && requestVersion.current === version) setIsLoading(false);
    });
    return () => {
      active = false;
      if (requestVersion.current === version) requestVersion.current += 1;
    };
  }, [path, retryKey]);

  async function loadMore() {
    if (!nextCursor || isLoadingMore) return;
    const version = requestVersion.current;
    setIsLoadingMore(true);
    setNextPageError(null);
    try {
      const separator = path.includes("?") ? "&" : "?";
      const page = await apiFetch<Page<T>>(`${path}${separator}cursor=${encodeURIComponent(nextCursor)}`);
      if (requestVersion.current !== version) return;
      setItems((current) => [...current, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (requestError: unknown) {
      if (requestVersion.current === version) {
        setNextPageError(requestError instanceof ApiError ? requestError.message : "Could not load more.");
      }
    } finally {
      if (requestVersion.current === version) setIsLoadingMore(false);
    }
  }

  return { items, setItems, nextCursor, isLoading, isLoadingMore, error, nextPageError, loadMore, retry: () => setRetryKey((value) => value + 1) };
}

export function ProfileImageViewer({ image, profile, onClose }: { image: { label: string; url: string }; profile: User; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const initial = profile.displayName.trim().charAt(0).toUpperCase() || "S";

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="post-detail-dialog post-photo-viewer-dialog"
      aria-label={`${image.label} for ${profile.displayName}`}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="post-photo-viewer-controls">
        <button className="post-detail-close" type="button" aria-label="Close photo viewer" onClick={onClose}>
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18" /></svg>
        </button>
        <Link className="post-photo-viewer-home" to="/" aria-label="Senderi home" title="Go to home">
          <img src="/senderi-mark.svg" alt="" />
        </Link>
      </div>
      <div className="post-detail-layout">
        <div className="post-detail-media">
          <img src={image.url} alt={image.label} referrerPolicy="no-referrer" />
        </div>
        <aside className="post-detail-sidebar">
          <header className="post-detail-author">
            <Link className="share-post-avatar" to={`/profile/${profile.id}`} aria-label={`${profile.displayName}’s profile`}>
              {profile.avatarUrl ? <img src={profile.avatarUrl} alt="" /> : initial}
            </Link>
            <div className="share-post-identity-copy">
              <Link className="share-post-author" to={`/profile/${profile.id}`}>{profile.displayName}</Link>
              <span className="text-xs text-muted">{image.label}</span>
            </div>
          </header>
        </aside>
      </div>
    </dialog>
  );
}

export function ProfilePhotos({ profile }: { profile: User }) {
  const collection = useProfileCollection<Post>(`/api/users/${profile.id}/photos?limit=24`);
  const [selectedPostId, setSelectedPostId] = useState<string | null>(null);
  const [selectedProfileImage, setSelectedProfileImage] = useState<{ label: string; url: string } | null>(null);
  const profileImages = [
    ...(profile.avatarUrl ? [{ label: "Profile photo", url: profile.avatarUrl }] : []),
    ...(profile.coverUrl ? [{ label: "Cover photo", url: profile.coverUrl }] : []),
  ];

  return (
    <section className="surface-card space-y-5 p-6 sm:p-8" aria-label="Profile photos">
      <div><span className="eyebrow">Photos</span><h2 className="mt-2 text-2xl font-bold tracking-[-0.03em] text-ink">{`${profile.displayName}’s photos`}</h2></div>
      {collection.isLoading ? (
        <SkeletonRegion message="Loading photos"><div className="profile-photos-grid">{Array.from({ length: 6 }, (_, index) => <SkeletonBlock key={index} className="profile-photo-skeleton" />)}</div></SkeletonRegion>
      ) : collection.error ? (
        <div className="space-y-3"><RequestErrorState title="Unable to load photos" message={collection.error} /><button className="button-secondary" type="button" onClick={collection.retry}>Try again</button></div>
      ) : collection.items.length === 0 && profileImages.length === 0 ? (
        <EmptyState title="No photos yet" message="Photo posts will appear here when they’re shared with you." />
      ) : (
        <>
          <div className="profile-photos-grid">
            {profileImages.map((image) => (
              <button className="profile-photo-tile" type="button" onClick={() => setSelectedProfileImage(image)} key={image.label} aria-label={`Open ${image.label.toLowerCase()}`}>
                <img src={image.url} alt={image.label} loading="lazy" />
                <span className="profile-photo-label">{image.label}</span>
              </button>
            ))}
            {collection.items.filter((post) => post.photoUrl).map((post) => (
              <button className="profile-photo-tile" type="button" onClick={() => setSelectedPostId(post.id)} key={post.id} aria-label={`Open photo posted ${new Date(post.createdAt).toLocaleDateString()}`}>
                <img src={post.photoUrl} alt={post.text || `Photo by ${profile.displayName}`} loading="lazy" />
              </button>
            ))}
          </div>
          {selectedProfileImage && <ProfileImageViewer image={selectedProfileImage} profile={profile} onClose={() => setSelectedProfileImage(null)} />}
          {selectedPostId && collection.items.find((post) => post.id === selectedPostId) && (
            <PostPhotoViewer
              key={selectedPostId}
              post={collection.items.find((post) => post.id === selectedPostId)!}
              onClose={() => setSelectedPostId(null)}
              onLikeUpdated={(state) => collection.setItems((items) => items.map((post) => post.id === selectedPostId ? { ...post, ...state } : post))}
            />
          )}
          {collection.nextPageError && <RequestErrorState title="Unable to load more photos" message={collection.nextPageError} />}
          {collection.nextCursor && <div className="flex justify-center"><button className="button-secondary" type="button" disabled={collection.isLoadingMore} onClick={() => void collection.loadMore()}>{collection.isLoadingMore ? "Loading…" : collection.nextPageError ? "Try again" : "Load more photos"}</button></div>}
        </>
      )}
    </section>
  );
}

export function ProfileFriends() {
  const collection = useProfileCollection<FriendListItem>("/api/friends?limit=24&includeMutualCounts=true");

  return (
    <section className="surface-card space-y-5 p-6 sm:p-8" aria-label="Profile friends">
      <div><span className="eyebrow">Friends</span><h2 className="mt-2 text-2xl font-bold tracking-[-0.03em] text-ink">Your friends</h2></div>
      {collection.isLoading ? (
        <SkeletonRegion message="Loading friends"><div className="profile-friends-grid">{Array.from({ length: 4 }, (_, index) => <SkeletonBlock key={index} className="profile-friend-skeleton" />)}</div></SkeletonRegion>
      ) : collection.error ? (
        <div className="space-y-3"><RequestErrorState title="Unable to load friends" message={collection.error} /><button className="button-secondary" type="button" onClick={collection.retry}>Try again</button></div>
      ) : collection.items.length === 0 ? (
        <EmptyState title="No friends yet" message="Friends you connect with will appear here." />
      ) : (
        <>
          <div className="profile-friends-grid">
            {collection.items.map((friend) => {
              const mutualFriendCount = friend.mutualFriendCount ?? 0;
              return (
                <Link className="profile-friend-tile" to={`/profile/${friend.id}`} key={friend.id}>
                  <span className="profile-friend-avatar">{friend.avatarUrl ? <img src={friend.avatarUrl} alt="" loading="lazy" /> : friend.displayName.trim().charAt(0).toUpperCase() || "?"}</span>
                  <span className="profile-friend-copy">
                    <span className="profile-friend-name">{friend.displayName}</span>
                    {mutualFriendCount > 0 && (
                      <span className="profile-friend-mutuals">
                        {mutualFriendCount} mutual {mutualFriendCount === 1 ? "friend" : "friends"}
                      </span>
                    )}
                  </span>
                </Link>
              );
            })}
          </div>
          {collection.nextPageError && <RequestErrorState title="Unable to load more friends" message={collection.nextPageError} />}
          {collection.nextCursor && <div className="flex justify-center"><button className="button-secondary" type="button" disabled={collection.isLoadingMore} onClick={() => void collection.loadMore()}>{collection.isLoadingMore ? "Loading…" : collection.nextPageError ? "Try again" : "Load more friends"}</button></div>}
        </>
      )}
    </section>
  );
}
