import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { Comment, CommentListResponse, CreateCommentRequest, CreateCommentResponse, CreatePostRequest, CreatePostResponse, CreateShareRequest, CreateShareResponse, LikeResponse, Post, PostListResponse, PostResponse, UpdatePostRequest, UpdateShareResponse, Visibility } from "../../../shared";
import { useAuth } from "../auth/AuthContext";
import { ApiError, apiFetch, apiSubmitPost } from "../api/client";
import { EmptyState, RequestErrorState } from "./AsyncState";
import { CommentsSkeleton, PostListSkeleton } from "./Skeletons";

const MAX_POST_LENGTH = 5_000;

const audienceOptions: Array<{ value: Visibility; label: string }> = [
  { value: "public", label: "Public" },
  { value: "friends", label: "Friends" },
  { value: "onlyMe", label: "Only me" },
];

function audienceLabel(visibility: Visibility): string {
  return audienceOptions.find((option) => option.value === visibility)?.label ?? "Friends";
}

const MAX_COMMENT_LENGTH = 2_000;

function PostActionIcon({ name }: { name: "like" | "comment" | "share" }) {
  const commonProps = {
    "aria-hidden": true as const,
    className: "post-action-icon",
    fill: "none",
    stroke: "currentColor",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    strokeWidth: 1.8,
    viewBox: "0 0 24 24",
  };

  if (name === "like") {
    return <svg {...commonProps}><path d="M7 10v10H4a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1h3Zm0 0 4-7a3 3 0 0 1 2 3v4h5.2a2 2 0 0 1 2 2.4l-1.3 6A2 2 0 0 1 17 20H7" /></svg>;
  }

  if (name === "comment") {
    return <svg {...commonProps}><path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H7l-4 2v-5.5A7.5 7.5 0 1 1 20 11.5Z" /></svg>;
  }

  return <svg {...commonProps}><path d="M14 5 21 12l-7 7" /><path d="M21 12H9a6 6 0 0 0-6 6" /></svg>;
}

function CommentsPanel({ postId, initiallyOpen = false }: { postId: string; initiallyOpen?: boolean }) {
  const commentInputId = useId();
  const [isOpen, setIsOpen] = useState(initiallyOpen);
  const [comments, setComments] = useState<Comment[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitMessage, setSubmitMessage] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const commentsPath = `/api/posts/${postId}/comments`;

  const loadFirstPage = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const page = await apiFetch<CommentListResponse>(commentsPath);
      setComments(page.items);
      setNextCursor(page.nextCursor);
      setHasLoaded(true);
    } catch (error: unknown) {
      setLoadError(error instanceof ApiError ? error.message : "We couldn’t load comments. Try again.");
    } finally {
      setIsLoading(false);
    }
  }, [commentsPath]);

  useEffect(() => {
    if (isOpen && !hasLoaded && !isLoading) void loadFirstPage();
  }, [hasLoaded, isLoading, isOpen, loadFirstPage]);

  async function loadNextPage() {
    if (!nextCursor || isLoadingMore) return;
    setIsLoadingMore(true);
    setLoadError(null);
    try {
      const page = await apiFetch<CommentListResponse>(pageUrl(commentsPath, nextCursor));
      setComments((current) => [...current, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (error: unknown) {
      setLoadError(error instanceof ApiError ? error.message : "We couldn’t load more comments. Try again.");
    } finally {
      setIsLoadingMore(false);
    }
  }

  async function submitComment(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedText = text.trim();
    if (!trimmedText || isSubmitting) return;

    setIsSubmitting(true);
    setSubmitError(null);
    setSubmitMessage(null);
    try {
      const body: CreateCommentRequest = { text: trimmedText };
      const response = await apiFetch<CreateCommentResponse>(commentsPath, { method: "POST", body });
      setComments((current) => [response.comment, ...current.filter((comment) => comment.id !== response.comment.id)]);
      setText("");
      setSubmitMessage("Comment added.");
      setHasLoaded(true);
    } catch (error: unknown) {
      setSubmitError(error instanceof ApiError ? error.message : "We couldn’t add your comment. Try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  function toggleComments() {
    setIsOpen((open) => !open);
  }

  return (
    <>
      <button
        className="post-action post-action-comment"
        type="button"
        aria-expanded={isOpen}
        onClick={toggleComments}
      >
        <PostActionIcon name="comment" />
        <span>{isOpen ? "Hide comments" : "Comment"}</span>
      </button>
      {isOpen && (
        <section className="post-comments-panel space-y-4" aria-label="Post comments">
          {isLoading ? (
            <CommentsSkeleton />
          ) : loadError && !hasLoaded ? (
            <div className="space-y-2">
              <RequestErrorState title="Unable to load comments" message={loadError} />
              <button className="button-secondary" type="button" onClick={() => void loadFirstPage()}>Try again</button>
            </div>
          ) : (
            <>
              {comments.length === 0 ? (
                <p className="text-sm text-muted">No comments yet. Start the conversation.</p>
              ) : (
                <ul className="space-y-3">
                  {comments.map((comment) => {
                    const initial = comment.author.displayName.trim().charAt(0).toUpperCase() || "S";
                    const createdAt = new Date(comment.createdAt);
                    return (
                      <li className="flex gap-3 rounded-2xl bg-canvas p-3" key={comment.id}>
                        <Link
                          className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-accent/10 text-xs font-bold text-accent"
                          to={`/profile/${comment.author.id}`}
                          aria-label={`${comment.author.displayName}’s profile`}
                        >
                          {comment.author.avatarUrl
                            ? <img className="h-full w-full object-cover" src={comment.author.avatarUrl} alt="" />
                            : initial}
                        </Link>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                            <Link className="text-xs font-bold text-ink hover:text-accent" to={`/profile/${comment.author.id}`}>
                              {comment.author.displayName}
                            </Link>
                            <time className="text-[11px] text-muted" dateTime={comment.createdAt}>
                              {Number.isNaN(createdAt.getTime()) ? "Just now" : new Intl.DateTimeFormat(undefined, {
                                dateStyle: "medium",
                                timeStyle: "short",
                              }).format(createdAt)}
                            </time>
                          </div>
                          <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-ink/85">{comment.text}</p>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
              {loadError && <RequestErrorState title="Unable to load more comments" message={loadError} />}
              {isLoadingMore && <CommentsSkeleton />}
              {nextCursor && (
                <button
                  className="button-secondary w-full"
                  type="button"
                  onClick={() => void loadNextPage()}
                  disabled={isLoadingMore}
                >
                  {isLoadingMore ? "Loading more comments…" : loadError ? "Try again" : "Load more comments"}
                </button>
              )}
            </>
          )}
          <form className="comment-composer-form" onSubmit={(event) => void submitComment(event)}>
            <div className="comment-composer-field">
              <label className="sr-only" htmlFor={commentInputId}>Write a comment</label>
              <textarea
                className="comment-composer-input"
                id={commentInputId}
                aria-label="Write a comment"
                placeholder="Write a comment…"
                value={text}
                rows={1}
                maxLength={MAX_COMMENT_LENGTH}
                onChange={(event) => {
                  setText(event.target.value);
                  setSubmitError(null);
                  setSubmitMessage(null);
                }}
                disabled={isSubmitting}
              />
              {text.trim() && (
                <button className="comment-composer-send" type="submit" aria-label={isSubmitting ? "Sending comment" : "Send comment"} title="Send comment" disabled={isSubmitting}>
                  <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M22 2 11 13" /><path d="m22 2-7 20-4-9-9-4 20-7Z" /></svg>
                </button>
              )}
            </div>
            {submitError && <p className="form-error" role="alert">{submitError}</p>}
            {submitMessage && <p className="form-success" role="status">{submitMessage}</p>}
          </form>
        </section>
      )}
    </>
  );
}

function ShareControl({ post, onShared }: { post: Post; onShared: () => void }) {
  const { user } = useAuth();
  const shareAudienceId = useId();
  const shareDialogTitleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [visibility, setVisibility] = useState<Visibility>("public");
  const [caption, setCaption] = useState("");
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isSharing, setIsSharing] = useState(false);
  const [message, setMessage] = useState<{ text: string; isError: boolean } | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (isDialogOpen && !dialog.open) dialog.showModal();
    if (!isDialogOpen && dialog.open) dialog.close();
  }, [isDialogOpen]);

  if (post.visibility !== "public" || (post.share && post.share.visibility !== "public")) return null;

  async function submitShare(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSharing) return;

    setIsSharing(true);
    setMessage(null);
    try {
      const normalizedCaption = caption.trim();
      const body: CreateShareRequest = {
        visibility,
        ...(normalizedCaption ? { caption: normalizedCaption } : {}),
        ...(post.share ? { sourceShareId: post.share.id } : {}),
      };
      await apiFetch<CreateShareResponse>(`/api/posts/${post.id}/shares`, {
        method: "POST",
        body,
      });
      setMessage({ text: "Post shared.", isError: false });
      setCaption("");
      onShared();
      setIsDialogOpen(false);
    } catch (error: unknown) {
      setMessage({
        text: error instanceof ApiError ? error.message : "We couldn’t share this post. Try again.",
        isError: true,
      });
    } finally {
      setIsSharing(false);
    }
  }

  return (
    <div className="post-share-control">
      <button
        className="post-action"
        type="button"
        onClick={() => {
          setMessage(null);
          setCaption("");
          setIsDialogOpen(true);
        }}
      >
        <PostActionIcon name="share" />
        {isSharing ? "Sharing…" : "Share"}
        <span className="post-action-count" aria-live="polite">{(post.share?.shareCount ?? post.shareCount).toLocaleString()}</span>
      </button>
      {message && !isDialogOpen && (
        <span className={message.isError ? "form-error" : "form-success"} role={message.isError ? "alert" : "status"}>
          {message.text}
        </span>
      )}
      <dialog
        ref={dialogRef}
        className="share-dialog"
        aria-labelledby={shareDialogTitleId}
        onClose={() => setIsDialogOpen(false)}
        onClick={(event) => {
          if (event.target === event.currentTarget) setIsDialogOpen(false);
        }}
      >
        <header className="share-dialog-header">
          <h2 id={shareDialogTitleId}>Share</h2>
          <button
            className="share-dialog-close"
            type="button"
            aria-label="Close share dialog"
            onClick={() => setIsDialogOpen(false)}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18" /></svg>
          </button>
        </header>
        <form className="share-dialog-form" onSubmit={(event) => void submitShare(event)}>
          <div className="share-dialog-body">
            <div className="share-dialog-identity">
              <div className="share-dialog-avatar">
                {user?.avatarUrl
                  ? <img src={user.avatarUrl} alt="" />
                  : (user?.displayName ?? "Senderi").trim().charAt(0).toUpperCase() || "S"}
              </div>
              <div className="share-dialog-identity-copy">
                <strong>{user?.displayName ?? "Your profile"}</strong>
                <div className="share-dialog-destination">
                  <span className="share-feed-chip">Feed</span>
                  <label className="sr-only" htmlFor={shareAudienceId}>Share audience</label>
                  <select
                    id={shareAudienceId}
                    className="post-share-audience"
                    value={visibility}
                    onChange={(event) => setVisibility(event.target.value as Visibility)}
                    aria-label="Share audience"
                    disabled={isSharing}
                  >
                    {audienceOptions.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
            <label className="sr-only" htmlFor={`${shareAudienceId}-caption`}>Add a message to your share</label>
            <textarea
              id={`${shareAudienceId}-caption`}
              className="share-dialog-caption"
              value={caption}
              onChange={(event) => setCaption(event.target.value)}
              maxLength={2_000}
              rows={3}
              placeholder="Say something about this..."
              disabled={isSharing}
            />
            <article className="share-preview" aria-label="Post preview">
              <p className="share-preview-author">Originally posted by {post.author.displayName}</p>
              {post.text && <p className="share-preview-text">{post.text}</p>}
              {post.photoUrl && (
                <img
                  className="share-preview-image"
                  src={post.photoUrl}
                  alt={`Photo shared by ${post.author.displayName}`}
                  referrerPolicy="no-referrer"
                />
              )}
              {!post.text && !post.photoUrl && <p className="share-preview-text">Shared a post.</p>}
            </article>
            {message?.isError && <p className="form-error" role="alert">{message.text}</p>}
          </div>
          <footer className="share-dialog-footer">
            <button className="button-secondary" type="button" disabled={isSharing} onClick={() => setIsDialogOpen(false)}>
              Cancel
            </button>
            <button className="button-accent" type="submit" disabled={isSharing}>
              {isSharing ? "Sharing…" : "Share now"}
            </button>
          </footer>
        </form>
      </dialog>
    </div>
  );
}

function PostDetailsDialog({
  post,
  isOpen,
  photoViewer = false,
  onClose,
  likeState,
  isLikePending,
  likeMessage,
  onToggleLike,
  onShared,
}: {
  post: Post;
  isOpen: boolean;
  photoViewer?: boolean;
  onClose: () => void;
  likeState: { likeCount: number; isLikedByViewer: boolean };
  isLikePending: boolean;
  likeMessage?: { text: string; isError: boolean } | null;
  onToggleLike: () => void;
  onShared: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const initial = post.author.displayName.trim().charAt(0).toUpperCase() || "S";
  const shareInitial = post.share?.author.displayName.trim().charAt(0).toUpperCase() || "S";
  const createdAt = new Date(post.createdAt);
  const shareCreatedAt = post.share ? new Date(post.share.createdAt) : null;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (isOpen && dialog && !dialog.open) dialog.showModal();
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <dialog
      ref={dialogRef}
      className={`post-detail-dialog${photoViewer ? " post-photo-viewer-dialog" : ""}`}
      aria-label={post.share ? `Post shared by ${post.share.author.displayName}` : `Post by ${post.author.displayName}`}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {photoViewer ? (
        <div className="post-photo-viewer-controls">
          <button className="post-detail-close" type="button" aria-label="Close photo viewer" onClick={onClose}>
            <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18" /></svg>
          </button>
          <Link className="post-photo-viewer-home" to="/" aria-label="Senderi home" title="Go to home">
            <img src="/senderi-mark.svg" alt="" />
          </Link>
        </div>
      ) : (
        <button className="post-detail-close" type="button" aria-label="Close post details" onClick={onClose}>
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18" /></svg>
        </button>
      )}
      <div className="post-detail-layout">
        <div className="post-detail-media">
          {post.photoUrl
            ? <img src={post.photoUrl} alt={`Photo shared by ${post.author.displayName}`} referrerPolicy="no-referrer" />
            : <p>{post.text || "Shared a post."}</p>}
        </div>
        <aside className="post-detail-sidebar">
          {post.share && (
            <div className="post-detail-share-context">
              <header className="share-post-header">
                <Link
                  className="share-post-avatar"
                  to={`/profile/${post.share.author.id}`}
                  aria-label={`${post.share.author.displayName}'s profile`}
                >
                  {post.share.author.avatarUrl ? <img src={post.share.author.avatarUrl} alt="" /> : shareInitial}
                </Link>
                <div className="share-post-identity-copy">
                  <Link className="share-post-author" to={`/profile/${post.share.author.id}`}>
                    {post.share.author.displayName}
                  </Link>
                  <time dateTime={post.share.createdAt}>
                    {shareCreatedAt && !Number.isNaN(shareCreatedAt.getTime())
                      ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(shareCreatedAt)
                      : "Just now"}
                    <span> · {audienceLabel(post.share.visibility)} audience</span>
                  </time>
                </div>
              </header>
              {post.share.caption && <p className="share-post-caption">{post.share.caption}</p>}
            </div>
          )}
          <header className="post-detail-author">
            <Link
              className="share-post-avatar"
              to={`/profile/${post.author.id}`}
              aria-label={`${post.author.displayName}’s profile`}
            >
              {post.author.avatarUrl ? <img src={post.author.avatarUrl} alt="" /> : initial}
            </Link>
            <div className="share-post-identity-copy">
              <Link className="share-post-author" to={`/profile/${post.author.id}`}>
                {post.author.displayName}
              </Link>
              <time dateTime={post.createdAt}>
                {Number.isNaN(createdAt.getTime()) ? "Just now" : new Intl.DateTimeFormat(undefined, {
                  dateStyle: "medium",
                  timeStyle: "short",
                }).format(createdAt)}
                <span> · {audienceLabel(post.visibility)} audience</span>
              </time>
            </div>
          </header>
          {post.photoUrl && post.text && <p className="post-detail-text">{post.text}</p>}
          <div className="post-action-bar post-detail-actions">
            <button
              className={`post-action post-action-like${likeState.isLikedByViewer ? " post-action-active" : ""}`}
              type="button"
              aria-pressed={likeState.isLikedByViewer}
              aria-label={likeState.isLikedByViewer ? "Unlike post" : "Like post"}
              disabled={isLikePending}
              onClick={onToggleLike}
            >
              <PostActionIcon name="like" />
              <span className="post-action-count" aria-live="polite">{likeState.likeCount.toLocaleString()}</span>
              {likeState.isLikedByViewer ? "Liked" : "Like"}
            </button>
            <CommentsPanel postId={post.id} initiallyOpen />
            <ShareControl post={post} onShared={onShared} />
          </div>
          {likeMessage && <p className={likeMessage.isError ? "form-error" : "form-success"} role={likeMessage.isError ? "alert" : "status"}>{likeMessage.text}</p>}
        </aside>
      </div>
    </dialog>
  );
}

export function PostPhotoViewer({
  post,
  onClose,
  onLikeUpdated,
  onShared = () => {},
}: {
  post: Post;
  onClose: () => void;
  onLikeUpdated?: (state: LikeResponse) => void;
  onShared?: () => void;
}) {
  const [likeState, setLikeState] = useState({ likeCount: post.likeCount, isLikedByViewer: post.isLikedByViewer });
  const [isLikePending, setIsLikePending] = useState(false);
  const [likeMessage, setLikeMessage] = useState<{ text: string; isError: boolean } | null>(null);

  useEffect(() => {
    setLikeState({ likeCount: post.likeCount, isLikedByViewer: post.isLikedByViewer });
  }, [post.id, post.likeCount, post.isLikedByViewer]);

  async function toggleLike() {
    if (isLikePending) return;
    const wasLiked = likeState.isLikedByViewer;
    setIsLikePending(true);
    setLikeMessage(null);
    try {
      const state = await apiFetch<LikeResponse>(`/api/posts/${post.id}/like`, { method: wasLiked ? "DELETE" : "PUT" });
      setLikeState(state);
      onLikeUpdated?.(state);
      setLikeMessage({ text: wasLiked ? "Like removed." : "Post liked.", isError: false });
    } catch (error: unknown) {
      setLikeMessage({
        text: error instanceof ApiError ? error.message : "We couldn’t update your Like. Try again.",
        isError: true,
      });
    } finally {
      setIsLikePending(false);
    }
  }

  return (
    <PostDetailsDialog
      post={post}
      isOpen
      photoViewer
      onClose={onClose}
      likeState={likeState}
      isLikePending={isLikePending}
      likeMessage={likeMessage}
      onToggleLike={() => void toggleLike()}
      onShared={onShared}
    />
  );
}

export function PostComposer({ onCreated }: { onCreated: (post: Post) => void }) {
  const [text, setText] = useState("");
  const [visibility, setVisibility] = useState<Visibility>("friends");
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isAudienceMenuOpen, setIsAudienceMenuOpen] = useState(false);
  const [message, setMessage] = useState<{ text: string; isError: boolean } | null>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const audienceMenuRef = useRef<HTMLDivElement>(null);
  const audienceMenuButtonRef = useRef<HTMLButtonElement>(null);
  const audienceMenuId = useId();

  useEffect(() => {
    if (!photo) {
      setPhotoPreview(null);
      return;
    }

    const previewUrl = URL.createObjectURL(photo);
    setPhotoPreview(previewUrl);
    return () => URL.revokeObjectURL(previewUrl);
  }, [photo]);

  useEffect(() => {
    if (!isAudienceMenuOpen) return;

    function closeOnOutsidePointer(event: PointerEvent) {
      if (event.target instanceof Node && !audienceMenuRef.current?.contains(event.target)) {
        setIsAudienceMenuOpen(false);
      }
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsAudienceMenuOpen(false);
        audienceMenuButtonRef.current?.focus();
      }
    }

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [isAudienceMenuOpen]);

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

  const audienceOptionsControl = (
    <div className="post-composer-options" ref={audienceMenuRef}>
      <button
        ref={audienceMenuButtonRef}
        className="post-composer-options-trigger"
        type="button"
        aria-label={`Post options, audience ${audienceLabel(visibility)}`}
        aria-haspopup="dialog"
        aria-expanded={isAudienceMenuOpen}
        aria-controls={audienceMenuId}
        title="Post options"
        disabled={isSubmitting}
        onClick={() => setIsAudienceMenuOpen((open) => !open)}
      >
        <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" /></svg>
      </button>
      <div className="post-composer-options-menu" id={audienceMenuId} role="dialog" aria-label="Post options" hidden={!isAudienceMenuOpen}>
        <label>
          <span>Audience</span>
          <select
            value={visibility}
            onChange={(event) => {
              setVisibility(event.target.value as Visibility);
              setIsAudienceMenuOpen(false);
              audienceMenuButtonRef.current?.focus();
            }}
            aria-label="Post audience"
            disabled={isSubmitting}
          >
            {audienceOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );

  return (
    <form className="surface-card space-y-4 p-5 sm:p-6" onSubmit={(event) => void submitPost(event)}>
      <div className="post-composer-heading">
        <span className="eyebrow">Create a post</span>
        {audienceOptionsControl}
      </div>
      <label className="block">
        <textarea
          className="mt-3 min-h-28 w-full resize-y rounded-2xl border border-line bg-canvas px-4 py-3 text-sm leading-6 text-ink outline-none transition placeholder:text-muted focus:border-accent"
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
      <div className="post-composer-footer flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
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
            <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${uploadProgress}%` }} />
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

export function PostCard({
  post,
  onUpdated,
  onShared,
  onDeleted,
  commentsInitiallyOpen = false,
}: {
  post: Post;
  onUpdated: (updated: Post) => void;
  onShared: () => void;
  onDeleted: () => void;
  commentsInitiallyOpen?: boolean;
}) {
  const { user } = useAuth();
  const [isUpdating, setIsUpdating] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [detailMode, setDetailMode] = useState<"post" | "photo" | null>(null);
  const [updateMessage, setUpdateMessage] = useState<{ text: string; isError: boolean } | null>(null);
  const [postLikeState, setPostLikeState] = useState({
    likeCount: post.likeCount,
    isLikedByViewer: post.isLikedByViewer,
  });
  const [shareLikeState, setShareLikeState] = useState({
    likeCount: post.share?.likeCount ?? 0,
    isLikedByViewer: post.share?.isLikedByViewer ?? false,
  });
  const [pendingLikeTarget, setPendingLikeTarget] = useState<"post" | "share" | null>(null);
  const [likeMessage, setLikeMessage] = useState<{ text: string; isError: boolean } | null>(null);
  const optionsMenuId = useId();
  const optionsMenuRef = useRef<HTMLDivElement>(null);
  const optionsButtonRef = useRef<HTMLButtonElement>(null);
  const isOwner = user?.id === post.author.id;
  const isShareOwner = Boolean(post.share && user?.id === post.share.author.id);
  const canManagePostOptions = post.share ? isShareOwner : isOwner;
  const displayedAudience = post.share?.visibility ?? post.visibility;
  const initial = post.author.displayName.trim().charAt(0).toUpperCase() || "S";
  const shareInitial = post.share?.author.displayName.trim().charAt(0).toUpperCase() || "S";
  const createdAt = new Date(post.createdAt);

  useEffect(() => {
    setPostLikeState({ likeCount: post.likeCount, isLikedByViewer: post.isLikedByViewer });
  }, [post.likeCount, post.isLikedByViewer]);

  useEffect(() => {
    setShareLikeState({
      likeCount: post.share?.likeCount ?? 0,
      isLikedByViewer: post.share?.isLikedByViewer ?? false,
    });
  }, [post.share?.id, post.share?.likeCount, post.share?.isLikedByViewer]);

  useEffect(() => {
    if (!isMenuOpen) return;

    function closeOnOutsidePointer(event: PointerEvent) {
      if (event.target instanceof Node && !optionsMenuRef.current?.contains(event.target)) {
        setIsMenuOpen(false);
      }
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsMenuOpen(false);
        optionsButtonRef.current?.focus();
      }
    }

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [isMenuOpen]);

  async function toggleLike(target: "post" | "share" = post.share ? "share" : "post") {
    if (pendingLikeTarget) return;
    const state = target === "share" ? shareLikeState : postLikeState;
    const wasLiked = state.isLikedByViewer;
    setPendingLikeTarget(target);
    setLikeMessage(null);
    try {
      const likePath = target === "share" && post.share
        ? `/api/posts/${post.id}/shares/${post.share.id}/like`
        : `/api/posts/${post.id}/like`;
      const response = await apiFetch<LikeResponse>(likePath, {
        method: wasLiked ? "DELETE" : "PUT",
      });
      if (target === "share") setShareLikeState(response);
      else setPostLikeState(response);
      setLikeMessage({ text: wasLiked ? "Like removed." : target === "share" ? "Share liked." : "Post liked.", isError: false });
    } catch (error: unknown) {
      setLikeMessage({
        text: error instanceof ApiError ? error.message : "We couldn’t update your Like. Try again.",
        isError: true,
      });
    } finally {
      setPendingLikeTarget(null);
    }
  }

  async function changeAudience(nextVisibility: Visibility) {
    if (!canManagePostOptions || nextVisibility === displayedAudience || isUpdating) return;
    setIsUpdating(true);
    setUpdateMessage({ text: "Updating audience…", isError: false });
    try {
      const body: UpdatePostRequest = { visibility: nextVisibility };
      const updatedPost = post.share
        ? {
            ...post,
            share: (await apiFetch<UpdateShareResponse>(`/api/posts/${post.id}/shares/${post.share.id}`, {
              method: "PATCH",
              body,
            })).share,
          }
        : (await apiFetch<PostResponse>(`/api/posts/${post.id}`, { method: "PATCH", body })).post;
      setUpdateMessage({ text: "Audience updated.", isError: false });
      setIsMenuOpen(false);
      onUpdated(updatedPost);
    } catch (error: unknown) {
      setUpdateMessage({
        text: error instanceof ApiError ? error.message : "We couldn’t update this post’s audience. Try again.",
        isError: true,
      });
    } finally {
      setIsUpdating(false);
    }
  }

  async function deletePost() {
    if (!canManagePostOptions || isDeleting) return;
    setIsDeleting(true);
    setUpdateMessage(null);
    try {
      const deleteUrl = post.share
        ? `/api/posts/${post.id}/shares/${post.share.id}`
        : `/api/posts/${post.id}`;
      await apiFetch<void>(deleteUrl, { method: "DELETE" });
      setIsMenuOpen(false);
      onDeleted();
    } catch (error: unknown) {
      setUpdateMessage({
        text: error instanceof ApiError ? error.message : "We couldn't delete this post. Try again.",
        isError: true,
      });
    } finally {
      setIsDeleting(false);
    }
  }

  function renderPostOptions() {
    return (
      <div className="post-options" ref={optionsMenuRef}>
        <button
          ref={optionsButtonRef}
          className="post-options-trigger"
          type="button"
          aria-label="Post options"
          aria-expanded={isMenuOpen}
          aria-controls={optionsMenuId}
          onClick={() => setIsMenuOpen((open) => !open)}
        >
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <circle cx="5" cy="12" r="1.6" />
            <circle cx="12" cy="12" r="1.6" />
            <circle cx="19" cy="12" r="1.6" />
          </svg>
        </button>
        <div id={optionsMenuId} className="post-options-menu" hidden={!isMenuOpen}>
          <p className="post-options-title">Post options</p>
          <div className="post-options-audience">
            <span>Audience</span>
            <strong>{audienceLabel(displayedAudience)}</strong>
          </div>
          {canManagePostOptions && (
            <>
              <label className="post-options-edit-audience">
                <span>Edit audience</span>
                <select
                  value={displayedAudience}
                  onChange={(event) => void changeAudience(event.target.value as Visibility)}
                  aria-label="Edit post audience"
                  disabled={isUpdating || isDeleting}
                >
                  {audienceOptions.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
              <button
                className="post-options-delete"
                type="button"
                disabled={isDeleting || isUpdating}
                onClick={() => {
                  const confirmed = post.share
                    ? window.confirm("Remove this share? The original post will remain.")
                    : window.confirm("Delete this post permanently? Its photo, comments, likes, and shares will also be removed.");
                  if (confirmed) void deletePost();
                }}
              >
                <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 7h16M10 11v6m4-6v6M6 7l1 14h10l1-14M9 7V4h6v3" /></svg>
                {isDeleting ? (post.share ? "Removing share…" : "Deleting post…") : (post.share ? "Remove share" : "Delete post")}
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  const originalPostContent = (
    <>
      <div className="mt-5 whitespace-pre-wrap break-words text-sm leading-7 text-ink/85">
        {post.text || <span className="text-muted">Shared a photo.</span>}
      </div>
      {post.photoUrl && (
        post.share ? (
          <img
            className="share-embedded-image"
            src={post.photoUrl}
            alt={`Photo shared by ${post.author.displayName}`}
            loading="lazy"
            referrerPolicy="no-referrer"
          />
        ) : (
          <button
            className="post-photo-trigger"
            type="button"
            aria-haspopup="dialog"
            aria-label={`View photo shared by ${post.author.displayName}`}
            onClick={() => setDetailMode("photo")}
          >
            <img
              className="mt-4 max-h-[36rem] w-full rounded-2xl border border-line object-contain"
              src={post.photoUrl}
              alt={`Photo shared by ${post.author.displayName}`}
              loading="lazy"
              referrerPolicy="no-referrer"
            />
          </button>
        )
      )}
    </>
  );
  const cardLikeState = post.share ? shareLikeState : postLikeState;
  const isCardLikePending = pendingLikeTarget === (post.share ? "share" : "post");
  const likeSubject = post.share ? "shared post" : "post";

  return (
    <article id={`post-${post.id}`} className={`post-card surface-card p-5 sm:p-6${post.share ? " shared-post-card" : ""}`}>
      {post.share && (
        <div className="share-post-context">
          <header className="share-post-header">
            <Link
              className="share-post-avatar"
              to={`/profile/${post.share.author.id}`}
              aria-label={`${post.share.author.displayName}’s profile`}
            >
              {post.share.author.avatarUrl
                ? <img src={post.share.author.avatarUrl} alt="" />
                : shareInitial}
            </Link>
            <div className="share-post-identity-copy">
              <Link className="share-post-author" to={`/profile/${post.share.author.id}`}>
                {post.share.author.displayName}
              </Link>
              <time dateTime={post.share.createdAt}>
                {Number.isNaN(new Date(post.share.createdAt).getTime()) ? "Just now" : new Intl.DateTimeFormat(undefined, {
              dateStyle: "medium",
              timeStyle: "short",
            }).format(new Date(post.share.createdAt))}
                <span> · {audienceLabel(post.share.visibility)} audience</span>
              </time>
            </div>
            {renderPostOptions()}
          </header>
          {post.share.caption && <p className="share-post-caption">{post.share.caption}</p>}
        </div>
      )}
      {post.share && updateMessage && (
        <p className={updateMessage.isError ? "form-error mb-3" : "form-success mb-3"} role={updateMessage.isError ? "alert" : "status"}>
          {updateMessage.text}
        </p>
      )}
      <div className={post.share ? "share-embedded-post" : undefined}>
      <header className="flex items-center gap-3">
        <Link
          className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-full bg-accent/10 text-sm font-bold text-accent"
          to={`/profile/${post.author.id}`}
          aria-label={`${post.author.displayName}’s profile`}
        >
          {post.author.avatarUrl
            ? <img className="h-full w-full object-cover" src={post.author.avatarUrl} alt="" />
            : initial}
        </Link>
        <div className="min-w-0 flex-1">
          <Link className="block truncate text-sm font-bold text-ink hover:text-accent" to={`/profile/${post.author.id}`}>
            {post.author.displayName}
          </Link>
          <time className="mt-0.5 block text-xs text-muted" dateTime={post.createdAt}>
            {Number.isNaN(createdAt.getTime()) ? "Just now" : new Intl.DateTimeFormat(undefined, {
              dateStyle: "medium",
              timeStyle: "short",
            }).format(createdAt)}
            <span> · {audienceLabel(post.visibility)} audience</span>
          </time>
        </div>
        {!post.share && renderPostOptions()}
      </header>
      {!post.share && updateMessage && (
        <p className={updateMessage.isError ? "form-error mt-3" : "form-success mt-3"} role={updateMessage.isError ? "alert" : "status"}>
          {updateMessage.text}
        </p>
      )}
      {post.share ? (
        <button
          className="share-post-open"
          type="button"
          aria-haspopup="dialog"
          aria-label={`Open original post by ${post.author.displayName}`}
          onClick={() => setDetailMode("post")}
        >
          {originalPostContent}
        </button>
      ) : originalPostContent}
      </div>
      {likeMessage && (
        <p className={likeMessage.isError ? "form-error mt-3" : "form-success mt-3"} role={likeMessage.isError ? "alert" : "status"}>
          {likeMessage.text}
        </p>
      )}
      <div className="post-action-bar mt-4">
        <button
          className={`post-action post-action-like${cardLikeState.isLikedByViewer ? " post-action-active" : ""}`}
          type="button"
          aria-pressed={cardLikeState.isLikedByViewer}
          aria-label={`${cardLikeState.isLikedByViewer ? "Unlike" : "Like"} ${likeSubject}`}
          aria-busy={isCardLikePending}
          disabled={pendingLikeTarget !== null}
          onClick={() => void toggleLike()}
        >
          <PostActionIcon name="like" />
          <span className="post-action-count" aria-live="polite">{cardLikeState.likeCount.toLocaleString()}</span>
          {isCardLikePending ? (cardLikeState.isLikedByViewer ? "Removing Like…" : "Liking…") : cardLikeState.isLikedByViewer ? "Liked" : "Like"}
        </button>
        <CommentsPanel postId={post.id} initiallyOpen={commentsInitiallyOpen} />
        <ShareControl post={post} onShared={onShared} />
      </div>
      {detailMode && (
        <PostDetailsDialog
          post={post}
          isOpen
          photoViewer={detailMode === "photo"}
          onClose={() => setDetailMode(null)}
          likeState={cardLikeState}
          isLikePending={pendingLikeTarget !== null}
          likeMessage={likeMessage}
          onToggleLike={() => void toggleLike()}
          onShared={onShared}
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
    const version = ++requestVersion.current;
    setIsLoadingMore(true);
    setItems((current) => current.flatMap((post) => {
      if (post.id !== updatedPost.id) return [post];
      if (post.share && updatedPost.visibility !== "public") return [];
      return [{ ...updatedPost, ...(post.share && !updatedPost.share ? { share: post.share } : {}) }];
    }));
    try {
      const page = await apiFetch<PostListResponse>(path);
      if (requestVersion.current !== version) return;
      setItems(page.items);
      setNextCursor(page.nextCursor);
      setNextPageError(null);
    } catch (requestError: unknown) {
      if (requestVersion.current !== version) return;
      setNextPageError(requestError instanceof ApiError ? requestError.message : "We couldn’t refresh posts.");
    } finally {
      if (requestVersion.current === version) setIsLoadingMore(false);
    }
  }

  async function refreshAfterShare() {
    const version = ++requestVersion.current;
    setIsLoadingMore(true);
    try {
      const page = await apiFetch<PostListResponse>(path);
      if (requestVersion.current !== version) return;
      setItems(page.items);
      setNextCursor(page.nextCursor);
      setNextPageError(null);
    } catch (requestError: unknown) {
      if (requestVersion.current !== version) return;
      setNextPageError(requestError instanceof ApiError ? requestError.message : "We couldn’t refresh posts.");
    } finally {
      if (requestVersion.current === version) setIsLoadingMore(false);
    }
  }

  if (isLoading) return <PostListSkeleton />;
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
      {items.map((post) => (
        <PostCard
          key={post.share?.id ?? post.id}
          post={post}
          onUpdated={(updated) => void refreshAfterEdit(updated)}
          onShared={() => void refreshAfterShare()}
          onDeleted={() => setRetryKey((current) => current + 1)}
        />
      ))}
      {isLoadingMore && <PostListSkeleton count={1} />}
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
