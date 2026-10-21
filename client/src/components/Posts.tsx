import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { CreatePostRequest, CreatePostResponse, Post, PostListResponse, Visibility } from "../../../shared";
import { ApiError, apiFetch } from "../api/client";
import { EmptyState, LoadingState, RequestErrorState } from "./AsyncState";

const MAX_POST_LENGTH = 5_000;

const audienceOptions: Array<{ value: Visibility; label: string }> = [
  { value: "public", label: "Public" },
  { value: "friends", label: "Friends" },
  { value: "onlyMe", label: "Only me" },
];

function audienceLabel(visibility: Visibility): string {
  return audienceOptions.find((option) => option.value === visibility)?.label ?? "Friends";
}

export function PostComposer({ onCreated }: { onCreated: (post: Post) => void }) {
  const [text, setText] = useState("");
  const [visibility, setVisibility] = useState<Visibility>("friends");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState<{ text: string; isError: boolean } | null>(null);

  async function submitPost(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedText = text.trim();
    if (!trimmedText) {
      setMessage({ text: "Write something before sharing your post.", isError: true });
      return;
    }

    setIsSubmitting(true);
    setMessage(null);
    try {
      const body: CreatePostRequest = { text: trimmedText, visibility };
      const response = await apiFetch<CreatePostResponse>("/api/posts", {
        method: "POST",
        body,
      });
      setText("");
      setMessage({ text: "Your post was shared.", isError: false });
      onCreated(response.post);
    } catch (error: unknown) {
      setMessage({
        text: error instanceof ApiError ? error.message : "We couldn’t share your post. Try again.",
        isError: true,
      });
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form className="surface-card space-y-4 p-5 sm:p-6" onSubmit={(event) => void submitPost(event)}>
      <label className="block">
        <span className="eyebrow">Create a post</span>
        <textarea
          className="mt-3 min-h-28 w-full resize-y rounded-2xl border border-line bg-canvas px-4 py-3 text-sm leading-6 text-ink outline-none transition placeholder:text-muted focus:border-violet"
          aria-label="Post text"
          placeholder="What’s on your mind?"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setMessage(null);
          }}
          maxLength={MAX_POST_LENGTH}
          required
        />
      </label>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <label className="flex items-center gap-3 text-sm font-semibold text-muted">
          Audience
          <select
            className="rounded-xl border border-line bg-canvas px-3 py-2 text-sm font-medium text-ink outline-none focus:border-violet"
            value={visibility}
            onChange={(event) => setVisibility(event.target.value as Visibility)}
            aria-label="Post audience"
          >
            {audienceOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <div className="flex items-center justify-between gap-4 sm:justify-end">
          <span className="text-xs text-muted">{text.length}/{MAX_POST_LENGTH}</span>
          <button className="button-accent" type="submit" disabled={isSubmitting || !text.trim()}>
            {isSubmitting ? "Sharing…" : "Share post"}
          </button>
        </div>
      </div>
      {message && (
        <p className={message.isError ? "form-error" : "form-success"} role={message.isError ? "alert" : "status"}>
          {message.text}
        </p>
      )}
    </form>
  );
}

function PostCard({ post }: { post: Post }) {
  const initial = post.author.displayName.trim().charAt(0).toUpperCase() || "S";
  const createdAt = new Date(post.createdAt);

  return (
    <article className="surface-card p-5 sm:p-6">
      <header className="flex items-center gap-3">
        <Link
          className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-full bg-violet/10 text-sm font-bold text-violet"
          to={`/profile/${post.author.id}`}
          aria-label={`${post.author.displayName}’s profile`}
        >
          {post.author.avatarUrl
            ? <img className="h-full w-full object-cover" src={post.author.avatarUrl} alt="" />
            : initial}
        </Link>
        <div className="min-w-0 flex-1">
          <Link className="block truncate text-sm font-bold text-ink hover:text-violet" to={`/profile/${post.author.id}`}>
            {post.author.displayName}
          </Link>
          <time className="mt-0.5 block text-xs text-muted" dateTime={post.createdAt}>
            {Number.isNaN(createdAt.getTime()) ? "Just now" : new Intl.DateTimeFormat(undefined, {
              dateStyle: "medium",
              timeStyle: "short",
            }).format(createdAt)}
          </time>
        </div>
        <span className="rounded-full bg-canvas px-3 py-1 text-xs font-semibold text-muted">
          {audienceLabel(post.visibility)}
        </span>
      </header>
      <div className="mt-5 whitespace-pre-wrap break-words text-sm leading-7 text-ink/85">
        {post.text || <span className="text-muted">Shared a photo.</span>}
      </div>
    </article>
  );
}

function pageUrl(path: string, cursor: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}`;
}

export function PostList({ path, refreshKey = 0 }: { path: string; refreshKey?: number }) {
  const [items, setItems] = useState<Post[]>([]);
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
    setIsLoading(true);
    setIsLoadingMore(false);
    setError(null);
    setNextPageError(null);

    apiFetch<PostListResponse>(path)
      .then((page) => {
        if (!active) return;
        setItems(page.items);
        setNextCursor(page.nextCursor);
      })
      .catch((requestError: unknown) => {
        if (!active) return;
        setError(requestError instanceof ApiError ? requestError.message : "We couldn’t load posts.");
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });

    return () => {
      active = false;
      if (requestVersion.current === version) requestVersion.current += 1;
    };
  }, [path, refreshKey, retryKey]);

  async function loadNextPage() {
    if (!nextCursor || isLoadingMore) return;
    const version = requestVersion.current;
    setIsLoadingMore(true);
    setNextPageError(null);
    try {
      const page = await apiFetch<PostListResponse>(pageUrl(path, nextCursor));
      if (requestVersion.current !== version) return;
      setItems((current) => [...current, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (requestError: unknown) {
      if (requestVersion.current !== version) return;
      setNextPageError(requestError instanceof ApiError ? requestError.message : "We couldn’t load more posts.");
    } finally {
      if (requestVersion.current === version) setIsLoadingMore(false);
    }
  }

  if (isLoading) return <LoadingState message="Loading posts…" />;
  if (error) {
    return (
      <div className="space-y-3">
        <RequestErrorState title="Unable to load posts" message={error} />
        <button className="button-secondary" type="button" onClick={() => setRetryKey((current) => current + 1)}>Try again</button>
      </div>
    );
  }
  if (items.length === 0) {
    return <EmptyState title="No posts yet" message="New updates will show here when someone shares." />;
  }

  return (
    <div className="space-y-4">
      {items.map((post) => <PostCard key={post.id} post={post} />)}
      {nextPageError && <RequestErrorState title="Unable to load more posts" message={nextPageError} />}
      {nextCursor && (
        <div className="flex justify-center">
          <button className="button-secondary" type="button" onClick={() => void loadNextPage()} disabled={isLoadingMore}>
            {isLoadingMore ? "Loading more…" : nextPageError ? "Try again" : "Load more posts"}
          </button>
        </div>
      )}
    </div>
  );
}
