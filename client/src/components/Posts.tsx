import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { CreatePostRequest, CreatePostResponse, Post, PostListResponse, PostResponse, UpdatePostRequest, Visibility } from "../../../shared";
import { useAuth } from "../auth/AuthContext";
import { ApiError, apiFetch, apiSubmitPost } from "../api/client";
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
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState<{ text: string; isError: boolean } | null>(null);
  const photoInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!photo) {
      setPhotoPreview(null);
      return;
    }

    const previewUrl = URL.createObjectURL(photo);
    setPhotoPreview(previewUrl);
    return () => URL.revokeObjectURL(previewUrl);
  }, [photo]);

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
      let response: CreatePostResponse;
      if (photo) {
        const form = new FormData();
        form.append("text", body.text);
        form.append("visibility", body.visibility);
        form.append("file", photo);
        setUploadProgress(0);
        response = await apiSubmitPost<CreatePostResponse>("/api/posts", form, setUploadProgress);
      } else {
        response = await apiFetch<CreatePostResponse>("/api/posts", { method: "POST", body });
      }
      setText("");
      setPhoto(null);
      setUploadProgress(null);
      if (photoInput.current) photoInput.current.value = "";
      setMessage({ text: "Your post was shared.", isError: false });
      onCreated(response.post);
    } catch (error: unknown) {
      setMessage({
        text: error instanceof ApiError ? error.message : "We couldn’t share your post. Try again.",
        isError: true,
      });
    } finally {
      setUploadProgress(null);
      setIsSubmitting(false);
    }
  }

  function selectPhoto(file: File | undefined) {
    if (!file) return;
    const supportedTypes = ["image/jpeg", "image/png", "image/webp"];
    if (!supportedTypes.includes(file.type)) {
      setPhoto(null);
      setMessage({ text: "Choose a JPEG, PNG, or WebP image.", isError: true });
      if (photoInput.current) photoInput.current.value = "";
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setPhoto(null);
      setMessage({ text: "Photos must be 5 MB or smaller.", isError: true });
      if (photoInput.current) photoInput.current.value = "";
      return;
    }
    setPhoto(file);
    setMessage({ text: "Photo ready to share.", isError: false });
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
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <label className="button-secondary cursor-pointer" htmlFor="post-photo-picker">
            {photo ? "Change photo" : "Add a photo"}
          </label>
          <input
            ref={photoInput}
            id="post-photo-picker"
            className="sr-only"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            aria-label="Choose a post photo"
            disabled={isSubmitting}
            onChange={(event) => selectPhoto(event.target.files?.[0])}
          />
          {photo && (
            <button
              className="text-sm font-semibold text-muted hover:text-ink"
              type="button"
              onClick={() => {
                setPhoto(null);
                if (photoInput.current) photoInput.current.value = "";
              }}
              disabled={isSubmitting}
            >
              Remove photo
            </button>
          )}
        </div>
        {photo && photoPreview && (
          <div className="flex flex-col gap-3 rounded-2xl border border-line bg-canvas p-3 sm:flex-row sm:items-center">
            <img className="max-h-64 w-full rounded-xl object-contain sm:w-48" src={photoPreview} alt="Selected post photo preview" />
            <p className="min-w-0 break-all text-xs text-muted">{photo.name} · {(photo.size / (1024 * 1024)).toFixed(2)} MB</p>
          </div>
        )}
      </div>
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
            {isSubmitting ? (photo ? "Uploading…" : "Sharing…") : photo ? "Share post and photo" : "Share post"}
          </button>
        </div>
      </div>
      {uploadProgress !== null && (
        <div className="space-y-1" role="status" aria-live="polite">
          <div className="flex justify-between text-xs text-muted">
            <span>Uploading photo and sharing post…</span>
            <span>{uploadProgress}%</span>
          </div>
          <div
            className="h-2 overflow-hidden rounded-full bg-line"
            role="progressbar"
            aria-label="Photo upload progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={uploadProgress}
          >
            <div className="h-full rounded-full bg-violet transition-[width]" style={{ width: `${uploadProgress}%` }} />
          </div>
        </div>
      )}
      {message && (
        <p className={message.isError ? "form-error" : "form-success"} role={message.isError ? "alert" : "status"}>
          {message.text}
        </p>
      )}
    </form>
  );
}

function PostCard({ post, onUpdated }: { post: Post; onUpdated: (updated: Post) => void }) {
  const { user } = useAuth();
  const [isUpdating, setIsUpdating] = useState(false);
  const [updateMessage, setUpdateMessage] = useState<{ text: string; isError: boolean } | null>(null);
  const isOwner = user?.id === post.author.id;
  const initial = post.author.displayName.trim().charAt(0).toUpperCase() || "S";
  const createdAt = new Date(post.createdAt);

  async function changeAudience(nextVisibility: Visibility) {
    if (!isOwner || nextVisibility === post.visibility || isUpdating) return;
    setIsUpdating(true);
    setUpdateMessage({ text: "Updating audience…", isError: false });
    try {
      const body: UpdatePostRequest = { visibility: nextVisibility };
      const response = await apiFetch<PostResponse>(`/api/posts/${post.id}`, {
        method: "PATCH",
        body,
      });
      setUpdateMessage({ text: "Audience updated.", isError: false });
      onUpdated(response.post);
    } catch (error: unknown) {
      setUpdateMessage({
        text: error instanceof ApiError ? error.message : "We couldn’t update this post’s audience. Try again.",
        isError: true,
      });
    } finally {
      setIsUpdating(false);
    }
  }

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
        {isOwner ? (
          <label className="flex items-center gap-2 text-xs font-semibold text-muted">
            Audience
            <select
              className="max-w-32 rounded-xl border border-line bg-canvas px-2 py-1.5 text-xs font-semibold text-ink outline-none focus:border-violet disabled:opacity-60"
              value={post.visibility}
              onChange={(event) => void changeAudience(event.target.value as Visibility)}
              aria-label="Edit post audience"
              disabled={isUpdating}
            >
              {audienceOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
        ) : (
          <span className="rounded-full bg-canvas px-3 py-1 text-xs font-semibold text-muted">
            {audienceLabel(post.visibility)}
          </span>
        )}
      </header>
      {updateMessage && (
        <p className={updateMessage.isError ? "form-error mt-3" : "form-success mt-3"} role={updateMessage.isError ? "alert" : "status"}>
          {updateMessage.text}
        </p>
      )}
      <div className="mt-5 whitespace-pre-wrap break-words text-sm leading-7 text-ink/85">
        {post.text || <span className="text-muted">Shared a photo.</span>}
      </div>
      {post.photoUrl && (
        <img
          className="mt-4 max-h-[36rem] w-full rounded-2xl border border-line object-contain"
          src={post.photoUrl}
          alt={`Photo shared by ${post.author.displayName}`}
          loading="lazy"
          referrerPolicy="no-referrer"
        />
      )}
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

  async function refreshAfterEdit(updatedPost: Post) {
    const version = requestVersion.current;
    setItems((current) => current.map((post) => post.id === updatedPost.id ? updatedPost : post));
    try {
      const page = await apiFetch<PostListResponse>(path);
      if (requestVersion.current !== version) return;
      setItems((current) => {
        const refreshedById = new Map(page.items.map((post) => [post.id, post]));
        return current.map((post) => refreshedById.get(post.id) ?? post);
      });
      setNextPageError(null);
    } catch (requestError: unknown) {
      if (requestVersion.current !== version) return;
      setNextPageError(requestError instanceof ApiError ? requestError.message : "We couldn’t refresh posts.");
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
      {items.map((post) => <PostCard key={post.id} post={post} onUpdated={(updated) => void refreshAfterEdit(updated)} />)}
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
