import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { Comment, CommentListResponse, CreateCommentRequest, CreateCommentResponse, CreatePostRequest, CreatePostResponse, CreateShareRequest, CreateShareResponse, LikeResponse, Post, PostListResponse, PostResponse, ReportTargetType, UpdateCommentRequest, UpdateCommentResponse, UpdatePostRequest, UpdateShareResponse, User, UserSearchResponse, Visibility } from "../../../shared";
import { useAuth } from "../auth/AuthContext";
import { ApiError, apiFetch, apiSubmitPost } from "../api/client";
import { EmptyState, RequestErrorState } from "./AsyncState";
import { CommentsSkeleton, PostListSkeleton } from "./Skeletons";
import { SupporterBadge } from "./SupporterBadge";
import { ReportDialog } from "./ReportDialog";

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
const VISIBLE_REPLIES_PER_THREAD = 3;

function updateCommentTree(comments: Comment[], commentId: string, update: (comment: Comment) => Comment): Comment[] {
  return comments.map((comment) => comment.id === commentId
    ? update(comment)
    : { ...comment, replies: updateCommentTree(comment.replies, commentId, update) });
}

function getCommentPreview(comments: Comment[], maxComments = 2): Comment[] {
  if (maxComments > 1) {
    const commentWithReply = comments.find((comment) => comment.replies.length > 0);
    if (commentWithReply) {
      return [{
        ...commentWithReply,
      }];
    }
  }

  const preview: Comment[] = [];
  let remaining = maxComments;
  for (const comment of comments) {
    if (remaining <= 0) break;
    const replies = comment.replies.slice(0, Math.max(0, remaining - 1));
    preview.push({ ...comment, replies });
    remaining -= 1 + replies.length;
  }
  return preview;
}

function formatCommentAge(value: string): string {
  const createdAt = new Date(value);
  if (Number.isNaN(createdAt.getTime())) return "now";
  const ageMs = Math.max(0, Date.now() - createdAt.getTime());
  if (ageMs < 60_000) return "now";
  if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m`;
  if (ageMs < 86_400_000) return `${Math.floor(ageMs / 3_600_000)}h`;
  if (ageMs < 604_800_000) return `${Math.floor(ageMs / 86_400_000)}d`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(createdAt);
}

interface MentionTextareaProps {
  id: string;
  className: string;
  value: string;
  placeholder: string;
  rows: number;
  maxLength: number;
  disabled: boolean;
  ariaLabel: string;
  required?: boolean;
  onChange: (value: string) => void;
  onMentionSelect: (user: User) => void;
  onFocus?: React.FocusEventHandler<HTMLTextAreaElement>;
  onKeyDown?: React.KeyboardEventHandler<HTMLTextAreaElement>;
}

function MentionTextarea({
  id,
  className,
  value,
  placeholder,
  rows,
  maxLength,
  disabled,
  ariaLabel,
  required,
  onChange,
  onMentionSelect,
  onFocus,
  onKeyDown,
}: MentionTextareaProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [mentionSearch, setMentionSearch] = useState<{ query: string; start: number; end: number } | null>(null);
  const [matches, setMatches] = useState<User[]>([]);
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);

  useEffect(() => {
    if (!mentionSearch || mentionSearch.query.length < 2) {
      setMatches([]);
      return;
    }
    let active = true;
    const timeout = window.setTimeout(() => {
      const params = new URLSearchParams({ query: mentionSearch.query, limit: "5" });
      void apiFetch<UserSearchResponse>(`/api/users?${params.toString()}`)
        .then((response) => {
          if (!active) return;
          setMatches(response.items);
          setActiveMatchIndex(0);
        })
        .catch(() => {
          if (active) setMatches([]);
        });
    }, 180);
    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [mentionSearch]);

  function chooseMention(user: User) {
    if (!mentionSearch) return;
    const mentionText = `@${user.displayName} `;
    const nextValue = value.slice(0, mentionSearch.start) + mentionText + value.slice(mentionSearch.end);
    const nextCaret = mentionSearch.start + mentionText.length;
    onChange(nextValue);
    onMentionSelect(user);
    setMentionSearch(null);
    setMatches([]);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(nextCaret, nextCaret);
    });
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (matches.length > 0 && event.key === "ArrowDown") {
      event.preventDefault();
      setActiveMatchIndex((current) => (current + 1) % matches.length);
      return;
    }
    if (matches.length > 0 && event.key === "ArrowUp") {
      event.preventDefault();
      setActiveMatchIndex((current) => (current - 1 + matches.length) % matches.length);
      return;
    }
    if (matches.length > 0 && event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      chooseMention(matches[activeMatchIndex]!);
      return;
    }
    if (event.key === "Escape" && mentionSearch) {
      setMentionSearch(null);
      setMatches([]);
      return;
    }
    onKeyDown?.(event);
  }

  return (
    <div className="mention-input-wrap">
      <textarea
        ref={textareaRef}
        className={className}
        id={id}
        aria-label={ariaLabel}
        aria-autocomplete="list"
        aria-expanded={matches.length > 0}
        aria-controls={`${id}-mention-options`}
        placeholder={placeholder}
        value={value}
        rows={rows}
        maxLength={maxLength}
        required={required}
        onChange={(event) => {
          const nextValue = event.target.value;
          const caret = event.currentTarget.selectionStart;
          onChange(nextValue);
          const beforeCaret = nextValue.slice(0, caret);
          const atIndex = beforeCaret.lastIndexOf("@");
          if (atIndex < 0 || (atIndex > 0 && !/[\s(]/.test(beforeCaret[atIndex - 1]!))) {
            setMentionSearch(null);
            setMatches([]);
            return;
          }
          const query = beforeCaret.slice(atIndex + 1);
          if (query.includes("\n") || query.includes("@")) {
            setMentionSearch(null);
            setMatches([]);
            return;
          }
          setMentionSearch({ query: query.trim(), start: atIndex, end: caret });
        }}
        onKeyDown={handleKeyDown}
        onFocus={onFocus}
        disabled={disabled}
      />
      {matches.length > 0 && mentionSearch && (
        <div className="mention-suggestions" id={`${id}-mention-options`} role="listbox" aria-label="People to mention">
          {matches.map((user, index) => {
            const initial = user.displayName.trim().charAt(0).toUpperCase() || "S";
            return (
              <button
                className={`mention-suggestion${index === activeMatchIndex ? " mention-suggestion-active" : ""}`}
                key={user.id}
                type="button"
                role="option"
                aria-selected={index === activeMatchIndex}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => chooseMention(user)}
              >
                <span className="mention-suggestion-avatar">
                  {user.avatarUrl ? <img src={user.avatarUrl} alt="" /> : initial}
                </span>
                <span className="mention-suggestion-name">{user.displayName}</span>
                <SupporterBadge user={user} />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function getActiveMentionIds(value: string, selected: User[]): string[] {
  return [...new Set(selected.filter((user) => {
    const escapedName = user.displayName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`@${escapedName}(?=$|[\\s.,!?;:])`, "u").test(value);
  }).map((user) => user.id))];
}

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
    return <svg {...commonProps}><path d="M20 11.5c0 4.14-3.58 7.5-8 7.5a8.75 8.75 0 0 1-3.58-.75L4 20l.98-3.32A7.08 7.08 0 0 1 4 11.5C4 7.36 7.58 4 12 4s8 3.36 8 7.5Z" /></svg>;
  }

  return <svg {...commonProps}><path d="M14 5 21 12l-7 7" /><path d="M21 12H9a6 6 0 0 0-6 6" /></svg>;
}

function CommentsPanel({
  postId,
  shareId,
  commentCount,
  preview = false,
  refreshKey = 0,
  onViewMore,
}: {
  postId: string;
  shareId?: string;
  commentCount: number;
  preview?: boolean;
  refreshKey?: number;
  onViewMore?: () => void;
}) {
  const { user } = useAuth();
  const commentInputId = useId();
  const commentMenuIdPrefix = useId();
  const [comments, setComments] = useState<Comment[]>([]);
  const [visibleCommentCount, setVisibleCommentCount] = useState(commentCount);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [selectedMentions, setSelectedMentions] = useState<User[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [replyingToId, setReplyingToId] = useState<string | null>(null);
  const [replyingToCommentId, setReplyingToCommentId] = useState<string | null>(null);
  const [expandedReplyThreads, setExpandedReplyThreads] = useState<Set<string>>(() => new Set());
  const [replyText, setReplyText] = useState("");
  const [selectedReplyMentions, setSelectedReplyMentions] = useState<User[]>([]);
  const [isSubmittingReply, setIsSubmittingReply] = useState(false);
  const [pendingCommentReactionIds, setPendingCommentReactionIds] = useState<Set<string>>(() => new Set());
  const [openCommentMenuId, setOpenCommentMenuId] = useState<string | null>(null);
  const [openCommentMenuAbove, setOpenCommentMenuAbove] = useState(false);
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editingCommentText, setEditingCommentText] = useState("");
  const [pendingCommentActionId, setPendingCommentActionId] = useState<string | null>(null);
  const [commentActionStatus, setCommentActionStatus] = useState<{ text: string; isError: boolean } | null>(null);
  const [reportingCommentId, setReportingCommentId] = useState<string | null>(null);
  const commentMenuButtonRef = useRef<HTMLButtonElement>(null);
  const commentMenuPanelRef = useRef<HTMLDivElement>(null);
  const commentsPath = shareId
    ? `/api/posts/${postId}/shares/${shareId}/comments`
    : `/api/posts/${postId}/comments`;

  useEffect(() => {
    setVisibleCommentCount(commentCount);
  }, [commentCount, postId, shareId]);

  useEffect(() => {
    if (refreshKey === 0) return;
    setComments([]);
    setNextCursor(null);
    setHasLoaded(false);
    setLoadError(null);
  }, [refreshKey]);

  useLayoutEffect(() => {
    if (!openCommentMenuId) return;
    const button = commentMenuButtonRef.current;
    const menu = commentMenuPanelRef.current;
    if (!button || !menu) return;

    const buttonRect = button.getBoundingClientRect();
    const menuHeight = menu.getBoundingClientRect().height;
    const spaceBelow = window.innerHeight - buttonRect.bottom - 8;
    const spaceAbove = buttonRect.top - 8;
    setOpenCommentMenuAbove(spaceBelow < menuHeight && spaceAbove > spaceBelow);
  }, [openCommentMenuId]);

  useEffect(() => {
    if (!openCommentMenuId) return;

    function closeOnOutsidePointer(event: PointerEvent) {
      if (event.target instanceof Element && !event.target.closest(".comment-options")) {
        setOpenCommentMenuId(null);
      }
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpenCommentMenuId(null);
    }

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [openCommentMenuId]);

  const loadFirstPage = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const page = await apiFetch<CommentListResponse>(preview ? `${commentsPath}?limit=3` : commentsPath);
      setComments(page.items);
      setNextCursor(page.nextCursor);
      setHasLoaded(true);
    } catch (error: unknown) {
      setLoadError(error instanceof ApiError ? error.message : "We couldn’t load comments. Try again.");
    } finally {
      setIsLoading(false);
    }
  }, [commentsPath, preview]);

  useEffect(() => {
    if (!hasLoaded && !isLoading) void loadFirstPage();
  }, [hasLoaded, isLoading, loadFirstPage]);

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
    try {
      const body: CreateCommentRequest = {
        text: trimmedText,
        mentionedUserIds: getActiveMentionIds(trimmedText, selectedMentions),
      };
      const response = await apiFetch<CreateCommentResponse>(commentsPath, { method: "POST", body });
      setComments((current) => [response.comment, ...current.filter((comment) => comment.id !== response.comment.id)]);
      setVisibleCommentCount((count) => count + 1);
      setText("");
      setSelectedMentions([]);
      setHasLoaded(true);
    } catch (error: unknown) {
      setSubmitError(error instanceof ApiError ? error.message : "We couldn’t add your comment. Try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function submitReply(event: React.FormEvent<HTMLFormElement>, parent: Comment, replyTarget: Comment) {
    event.preventDefault();
    const trimmedText = replyText.trim();
    if (!trimmedText || isSubmittingReply) return;

    setIsSubmittingReply(true);
    setCommentActionStatus(null);
    try {
      const body: CreateCommentRequest = {
        text: trimmedText,
        parentCommentId: parent.id,
        ...(replyTarget.id !== parent.id ? { replyToCommentId: replyTarget.id } : {}),
        mentionedUserIds: getActiveMentionIds(trimmedText, selectedReplyMentions),
      };
      const response = await apiFetch<CreateCommentResponse>(commentsPath, { method: "POST", body });
      setComments((current) => updateCommentTree(current, parent.id, (comment) => {
        const replies = comment.replies.map((reply) => reply.id === replyTarget.id
          ? { ...reply, replyCount: (reply.replyCount ?? reply.replies.length) + 1 }
          : reply);
        return {
          ...comment,
          replies: [...replies, response.comment],
          replyCount: (comment.replyCount ?? comment.replies.length) + 1,
        };
      }));
      setVisibleCommentCount((count) => count + 1);
      setReplyText("");
      setSelectedReplyMentions([]);
      setReplyingToId(null);
      setReplyingToCommentId(null);
      setExpandedReplyThreads((current) => new Set(current).add(parent.id));
    } catch (error: unknown) {
      setCommentActionStatus({
        text: error instanceof ApiError ? error.message : "We couldn’t add your reply. Try again.",
        isError: true,
      });
    } finally {
      setIsSubmittingReply(false);
    }
  }

  async function toggleCommentReaction(comment: Comment) {
    if (pendingCommentReactionIds.has(comment.id)) return;
    setPendingCommentReactionIds((current) => new Set(current).add(comment.id));
    setCommentActionStatus(null);
    try {
      const response = await apiFetch<{ reactionCount: number; isReactedByViewer: boolean }>(
        `${commentsPath}/${comment.id}/reaction`,
        { method: comment.isReactedByViewer ? "DELETE" : "POST" },
      );
      setComments((current) => updateCommentTree(current, comment.id, (item) => ({
        ...item,
        ...response,
      })));
    } catch (error: unknown) {
      setCommentActionStatus({
        text: error instanceof ApiError ? error.message : "We couldn’t update your reaction. Try again.",
        isError: true,
      });
    } finally {
      setPendingCommentReactionIds((current) => {
        const next = new Set(current);
        next.delete(comment.id);
        return next;
      });
    }
  }

  function beginEditComment(comment: Comment) {
    setEditingCommentId(comment.id);
    setEditingCommentText(comment.text);
    setOpenCommentMenuId(null);
    setCommentActionStatus(null);
  }

  async function saveComment(event: React.FormEvent<HTMLFormElement>, comment: Comment) {
    event.preventDefault();
    const trimmedText = editingCommentText.trim();
    if (user?.id !== comment.author.id || !trimmedText || pendingCommentActionId) return;

    setPendingCommentActionId(comment.id);
    setCommentActionStatus(null);
    try {
      const body: UpdateCommentRequest = { text: trimmedText };
      const response = await apiFetch<UpdateCommentResponse>(`${commentsPath}/${comment.id}`, { method: "PATCH", body });
      setComments((current) => updateCommentTree(current, comment.id, (item) => ({
        ...item,
        ...response.comment,
        replies: item.replies,
        replyCount: item.replyCount ?? item.replies.length,
      })));
      setEditingCommentId(null);
      setEditingCommentText("");
      setCommentActionStatus({ text: "Comment updated.", isError: false });
    } catch (error: unknown) {
      setCommentActionStatus({
        text: error instanceof ApiError ? error.message : "We couldn’t update your comment. Try again.",
        isError: true,
      });
    } finally {
      setPendingCommentActionId(null);
    }
  }

  async function deleteComment(comment: Comment) {
    if (user?.id !== comment.author.id || pendingCommentActionId) return;
    setPendingCommentActionId(comment.id);
    setCommentActionStatus(null);
    try {
      await apiFetch<void>(`${commentsPath}/${comment.id}`, { method: "DELETE" });
      setComments((current) => {
        if (comment.parentCommentId) {
          return updateCommentTree(current, comment.parentCommentId, (parent) => ({
            ...parent,
            replies: parent.replies
              .filter((reply) => reply.id !== comment.id)
              .map((reply) => reply.replyToCommentId === comment.id
                ? { ...reply, replyToCommentId: undefined }
                : reply)
              .map((reply) => reply.id === comment.replyToCommentId
                ? { ...reply, replyCount: Math.max(0, (reply.replyCount ?? reply.replies.length) - 1) }
                : reply),
            replyCount: Math.max(0, (parent.replyCount ?? parent.replies.length) - 1),
          }));
        }
        return current.filter((item) => item.id !== comment.id);
      });
      const removedCommentCount = comment.parentCommentId
        ? 1
        : 1 + (comment.replyCount ?? comment.replies.length);
      setVisibleCommentCount((count) => Math.max(0, count - removedCommentCount));
    } catch (error: unknown) {
      setCommentActionStatus({
        text: error instanceof ApiError ? error.message : "We couldn’t delete your comment. Try again.",
        isError: true,
      });
    } finally {
      setPendingCommentActionId(null);
      setOpenCommentMenuId(null);
    }
  }

  function renderComment(comment: Comment, isReply = false, rootComment: Comment = comment): React.JSX.Element {
    const initial = comment.author.displayName.trim().charAt(0).toUpperCase() || "S";
    const createdAt = new Date(comment.createdAt);
    const isPendingReaction = pendingCommentReactionIds.has(comment.id);
    const replyCount = comment.replyCount ?? comment.replies.length;
    const replyTarget = comment.replyToCommentId
      ? rootComment.replies.find((reply) => reply.id === comment.replyToCommentId)
      : undefined;
    const isReplyThreadExpanded = expandedReplyThreads.has(comment.id);
    const visibleReplies = isReplyThreadExpanded
      ? comment.replies
      : comment.replies.slice(0, preview ? 1 : VISIBLE_REPLIES_PER_THREAD);
    const hiddenReplyCount = comment.replies.length - visibleReplies.length;

    return (
      <li className={`comment-item flex gap-2${isReply ? " comment-item-reply" : ""}`} key={comment.id}>
        <Link
          className="comment-avatar flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-accent/10 text-[10px] font-bold text-accent"
          to={`/profile/${comment.author.id}`}
          aria-label={`${comment.author.displayName}’s profile`}
        >
          {comment.author.avatarUrl
            ? <img className="h-full w-full object-cover" src={comment.author.avatarUrl} alt="" />
            : initial}
        </Link>
        <div className="comment-content min-w-0 flex-1">
          <div className="comment-header">
            <div className="comment-header-copy">
              <Link className="text-xs font-bold text-ink hover:text-accent" to={`/profile/${comment.author.id}`}>
                {comment.author.displayName} <SupporterBadge user={comment.author} />
              </Link>
              <time className="comment-time text-[11px] text-muted" dateTime={comment.createdAt} title={Number.isNaN(createdAt.getTime()) ? undefined : new Intl.DateTimeFormat(undefined, {
                dateStyle: "medium",
                timeStyle: "short",
              }).format(createdAt)}>
                {formatCommentAge(comment.createdAt)}
              </time>
              {comment.editedAt && <span className="comment-edited-label">Edited</span>}
            </div>
            {user && editingCommentId !== comment.id && (
              <div className="comment-options">
                <button
                  ref={openCommentMenuId === comment.id ? commentMenuButtonRef : null}
                  className="comment-options-trigger"
                  type="button"
                  aria-label="Comment options"
                  aria-expanded={openCommentMenuId === comment.id}
                  aria-controls={`${commentMenuIdPrefix}-${comment.id}`}
                  disabled={pendingCommentActionId === comment.id}
                  onClick={() => setOpenCommentMenuId((current) => current === comment.id ? null : comment.id)}
                >
                  <svg aria-hidden="true" viewBox="0 0 24 24">
                    <circle cx="5" cy="12" r="1.6" />
                    <circle cx="12" cy="12" r="1.6" />
                    <circle cx="19" cy="12" r="1.6" />
                  </svg>
                </button>
                <div
                  ref={openCommentMenuId === comment.id ? commentMenuPanelRef : null}
                  className={`comment-options-menu${openCommentMenuAbove ? " comment-options-menu-above" : ""}`}
                  id={`${commentMenuIdPrefix}-${comment.id}`}
                  role="menu"
                  aria-label="Comment options"
                  hidden={openCommentMenuId !== comment.id}
                >
                  {user.id === comment.author.id ? <>
                    <button type="button" role="menuitem" onClick={() => beginEditComment(comment)}>Edit comment</button>
                    <button
                      className="comment-options-delete"
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setOpenCommentMenuId(null);
                        if (window.confirm("Delete your comment permanently? This cannot be undone.")) {
                          void deleteComment(comment);
                        }
                      }}
                    >
                      Delete permanently
                    </button>
                  </> : <button type="button" role="menuitem" onClick={() => {
                    setOpenCommentMenuId(null);
                    setCommentActionStatus(null);
                    setReportingCommentId(comment.id);
                  }}>Report comment</button>}
                </div>
              </div>
            )}
          </div>
          {editingCommentId === comment.id ? (
            <form className="comment-edit-form" onSubmit={(event) => void saveComment(event, comment)}>
              <label className="sr-only" htmlFor={`${commentMenuIdPrefix}-edit-${comment.id}`}>Edit comment</label>
              <textarea
                className="comment-edit-input"
                id={`${commentMenuIdPrefix}-edit-${comment.id}`}
                value={editingCommentText}
                maxLength={MAX_COMMENT_LENGTH}
                rows={Math.min(5, Math.max(2, editingCommentText.split("\n").length))}
                onChange={(event) => setEditingCommentText(event.target.value)}
                disabled={pendingCommentActionId === comment.id}
              />
              <div className="comment-edit-actions">
                <button className="button-secondary" type="button" disabled={pendingCommentActionId === comment.id} onClick={() => setEditingCommentId(null)}>Cancel</button>
                <button className="button-accent" type="submit" disabled={!editingCommentText.trim() || pendingCommentActionId === comment.id}>
                  {pendingCommentActionId === comment.id ? "Saving…" : "Save"}
                </button>
              </div>
            </form>
          ) : (
            <>
              {replyTarget && (
                <p className="comment-reply-context">
                  Replying to <Link to={`/profile/${replyTarget.author.id}`}>{replyTarget.author.displayName}</Link>
                </p>
              )}
              <p className="comment-text whitespace-pre-wrap break-words text-ink/85">{comment.text}</p>
            </>
          )}
          <div className="comment-actions" aria-label="Comment actions">
            <button
              className={`comment-action-button${comment.isReactedByViewer ? " comment-action-button-active" : ""}`}
              type="button"
              aria-pressed={comment.isReactedByViewer}
              disabled={isPendingReaction}
              onClick={() => void toggleCommentReaction(comment)}
            >
              <PostActionIcon name="like" />
              <span>{comment.isReactedByViewer ? "Liked" : "Like"}</span>
              {comment.reactionCount > 0 && <span className="comment-action-count">{comment.reactionCount.toLocaleString()}</span>}
            </button>
            <button
              className="comment-action-button"
              type="button"
              onClick={() => {
                const isCurrentTarget = replyingToId === rootComment.id && replyingToCommentId === comment.id;
                setReplyingToId(isCurrentTarget ? null : rootComment.id);
                setReplyingToCommentId(isCurrentTarget ? null : comment.id);
                setReplyText("");
                setSelectedReplyMentions([]);
                setCommentActionStatus(null);
              }}
            >
              Reply{!isReply && replyCount > 0 ? ` · ${replyCount}` : ""}
            </button>
          </div>
          {replyingToId === rootComment.id && replyingToCommentId === comment.id && (
            <form className="comment-reply-form" onSubmit={(event) => void submitReply(event, rootComment, comment)}>
              <label className="sr-only" htmlFor={`${commentMenuIdPrefix}-reply-${comment.id}`}>Reply to {comment.author.displayName}</label>
              <MentionTextarea
                className="comment-reply-input"
                id={`${commentMenuIdPrefix}-reply-${comment.id}`}
                placeholder={`Reply to ${comment.author.displayName}…`}
                value={replyText}
                maxLength={MAX_COMMENT_LENGTH}
                rows={1}
                ariaLabel={`Reply to ${comment.author.displayName}`}
                onChange={setReplyText}
                onMentionSelect={(mentionedUser) => setSelectedReplyMentions((current) =>
                  current.some((item) => item.id === mentionedUser.id) ? current : [...current, mentionedUser],
                )}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
                  event.preventDefault();
                  if (!isSubmittingReply && replyText.trim()) event.currentTarget.form?.requestSubmit();
                }}
                disabled={isSubmittingReply}
              />
              <div className="comment-edit-actions">
                <button className="button-secondary" type="button" disabled={isSubmittingReply} onClick={() => {
                  setReplyingToId(null);
                  setReplyingToCommentId(null);
                }}>Cancel</button>
                <button className="button-accent" type="submit" disabled={!replyText.trim() || isSubmittingReply}>
                  {isSubmittingReply ? "Replying…" : "Reply"}
                </button>
              </div>
            </form>
          )}
          {!isReply && comment.replies.length > 0 && (
            <ul className="comment-replies" id={`${commentMenuIdPrefix}-replies-${comment.id}`}>
              {visibleReplies.map((reply) => renderComment(reply, true, comment))}
            </ul>
          )}
          {(preview ? comment.replies.length > 1 : comment.replies.length > VISIBLE_REPLIES_PER_THREAD) && (
            <button
              className="comment-view-more"
              type="button"
              aria-expanded={isReplyThreadExpanded}
              aria-controls={`${commentMenuIdPrefix}-replies-${comment.id}`}
              onClick={() => setExpandedReplyThreads((current) => {
                const next = new Set(current);
                if (next.has(comment.id)) next.delete(comment.id);
                else next.add(comment.id);
                return next;
              })}
            >
              {isReplyThreadExpanded
                ? "Hide"
                : `View ${hiddenReplyCount} more ${hiddenReplyCount === 1 ? "reply" : "replies"}`}
            </button>
          )}
        </div>
      </li>
    );
  }

  function toggleComments() {
    if (preview) {
      onViewMore?.();
      return;
    }
    document.getElementById(commentInputId)?.focus();
  }

  return (
    <>
      <button
        className="post-action post-action-comment"
        type="button"
        aria-expanded="true"
        aria-label={`Comment on post, ${visibleCommentCount} comments`}
        onClick={toggleComments}
      >
        <PostActionIcon name="comment" />
        <span className="post-action-label">Comment</span>
        <span className="post-action-count" aria-live="polite">{visibleCommentCount.toLocaleString()}</span>
      </button>
      <section className={`post-comments-panel space-y-4${preview ? " post-comments-preview" : ""}`} aria-label="Post comments">
          {isLoading || (!hasLoaded && !loadError) ? (
            <CommentsSkeleton />
          ) : loadError && !hasLoaded ? (
            <div className="space-y-2">
              <RequestErrorState title="Unable to load comments" message={loadError} />
              <button className="button-secondary" type="button" onClick={() => void loadFirstPage()}>Try again</button>
            </div>
          ) : (
            <>
              {preview && (visibleCommentCount > 2 || comments.length > 2 || nextCursor !== null) && (
                <button className="comment-view-more" type="button" onClick={onViewMore}>
                  View more comments
                </button>
              )}
              {comments.length === 0 ? (
                <p className="text-sm text-muted">No comments yet. Start the conversation.</p>
              ) : (
                <ul className="space-y-3">
                  {(preview ? getCommentPreview(comments) : comments).map((comment) => renderComment(comment))}
                </ul>
              )}
              {loadError && <RequestErrorState title="Unable to load more comments" message={loadError} />}
              {isLoadingMore && <CommentsSkeleton />}
              {!preview && nextCursor && (
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
          {commentActionStatus && (
            <p className={commentActionStatus.isError ? "form-error" : "form-success"} role={commentActionStatus.isError ? "alert" : "status"}>
              {commentActionStatus.text}
            </p>
          )}
          <form className="comment-composer-form" onSubmit={(event) => void submitComment(event)}>
            <div className="comment-composer-field">
              <label className="sr-only" htmlFor={commentInputId}>Write a comment</label>
              <MentionTextarea
                className="comment-composer-input"
                id={commentInputId}
                placeholder="Write a comment…"
                value={text}
                rows={1}
                maxLength={MAX_COMMENT_LENGTH}
                ariaLabel="Write a comment"
                onChange={(nextText) => {
                  setText(nextText);
                  setSubmitError(null);
                }}
                onMentionSelect={(mentionedUser) => setSelectedMentions((current) =>
                  current.some((item) => item.id === mentionedUser.id) ? current : [...current, mentionedUser],
                )}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
                  event.preventDefault();
                  if (!isSubmitting && text.trim()) event.currentTarget.form?.requestSubmit();
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
          </form>
        </section>
      <ReportDialog
        open={reportingCommentId !== null}
        targetType="comment"
        targetId={reportingCommentId ?? ""}
        onClose={() => setReportingCommentId(null)}
        onReported={() => setCommentActionStatus({ text: "Thanks. Your report was sent to the moderators.", isError: false })}
      />
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
        aria-label={isSharing ? "Sharing post" : `Share post, ${(post.share?.shareCount ?? post.shareCount).toLocaleString()} shares`}
        aria-busy={isSharing}
        onClick={() => {
          setMessage(null);
          setCaption("");
          setIsDialogOpen(true);
        }}
      >
        <PostActionIcon name="share" />
        <span className="post-action-label">{isSharing ? "Sharing…" : "Share"}</span>
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

  useLayoutEffect(() => {
    if (!isOpen) return;
    const root = document.documentElement;
    const body = document.body;
    const previousRootOverflow = root.style.overflow;
    const previousBodyOverflow = body.style.overflow;
    const previousBodyPaddingRight = body.style.paddingRight;
    const scrollbarWidth = window.innerWidth - root.clientWidth;
    const bodyPaddingRight = Number.parseFloat(window.getComputedStyle(body).paddingRight) || 0;

    root.style.overflow = "hidden";
    body.style.overflow = "hidden";
    if (scrollbarWidth > 0) body.style.paddingRight = `${bodyPaddingRight + scrollbarWidth}px`;

    return () => {
      root.style.overflow = previousRootOverflow;
      body.style.overflow = previousBodyOverflow;
      body.style.paddingRight = previousBodyPaddingRight;
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <dialog
      ref={dialogRef}
      className={`post-detail-dialog${photoViewer ? " post-photo-viewer-dialog" : ""}${photoViewer && post.share ? " post-shared-photo-viewer-dialog" : ""}`}
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
            <img src="/senderi-symbol.png" alt="" />
          </Link>
        </div>
      ) : (
        <button className="post-detail-close" type="button" aria-label="Close post details" onClick={onClose}>
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18" /></svg>
        </button>
      )}
      <div className="post-detail-layout">
        <div className={`post-detail-media${post.share && photoViewer ? " post-detail-shared-media" : ""}${photoViewer && !post.photoUrl ? " post-detail-text-media" : ""}`}>
          {post.share && photoViewer && (
            <div className="post-detail-share-context post-detail-share-top">
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
                    {post.share.author.displayName} <SupporterBadge user={post.share.author} />
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
          {post.photoUrl
            ? <img src={post.photoUrl} alt={`Photo shared by ${post.author.displayName}`} referrerPolicy="no-referrer" />
            : <p>{post.text || "Shared a post."}</p>}
        </div>
        <aside className="post-detail-sidebar">
          {post.share && !photoViewer && (
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
                    {post.share.author.displayName} <SupporterBadge user={post.share.author} />
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
                {post.author.displayName} <SupporterBadge user={post.author} />
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
          {post.share && photoViewer && (
            <div className="share-embedded-post post-detail-share-card">
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
                    {post.share.author.displayName} <SupporterBadge user={post.share.author} />
                  </Link>
                  <time dateTime={post.share.createdAt}>
                    {shareCreatedAt && !Number.isNaN(shareCreatedAt.getTime())
                      ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(shareCreatedAt)
                      : "Just now"}
                    <span>{" · "}{audienceLabel(post.share.visibility)} audience</span>
                  </time>
                </div>
              </header>
              {post.share.caption && <p className="share-post-caption">{post.share.caption}</p>}
            </div>
          )}
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
              <span className="post-action-label">{likeState.isLikedByViewer ? "Liked" : "Like"}</span>
            </button>
        <CommentsPanel
          postId={post.id}
          shareId={post.share?.id}
          commentCount={post.share?.commentCount ?? post.commentCount}
        />
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
  const { user } = useAuth();
  const [isMobileViewport, setIsMobileViewport] = useState(() =>
    typeof window !== "undefined" && window.matchMedia("(max-width: 640px)").matches,
  );
  const [text, setText] = useState("");
  const [selectedMentions, setSelectedMentions] = useState<User[]>([]);
  const [visibility, setVisibility] = useState<Visibility>("friends");
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [isAudienceMenuOpen, setIsAudienceMenuOpen] = useState(false);
  const [message, setMessage] = useState<{ text: string; isError: boolean } | null>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLFormElement>(null);
  const audienceMenuRef = useRef<HTMLDivElement>(null);
  const audienceMenuButtonRef = useRef<HTMLButtonElement>(null);
  const audienceMenuId = useId();

  useEffect(() => {
    const mobileViewport = window.matchMedia("(max-width: 640px)");
    const updateViewport = () => setIsMobileViewport(mobileViewport.matches);
    mobileViewport.addEventListener("change", updateViewport);
    return () => mobileViewport.removeEventListener("change", updateViewport);
  }, []);

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

  useEffect(() => {
    if (!isExpanded) return;

    function collapseWhenClickedOutside(event: PointerEvent) {
      const composer = composerRef.current;
      if (!composer || !(event.target instanceof Node) || composer.contains(event.target)) return;
      if (text.trim() || photo) return;
      setIsExpanded(false);
      setIsAudienceMenuOpen(false);
    }

    document.addEventListener("pointerdown", collapseWhenClickedOutside);
    return () => document.removeEventListener("pointerdown", collapseWhenClickedOutside);
  }, [isExpanded, text, photo]);

  async function submitPost(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedText = text.trim();
    if (!trimmedText && !photo) {
      setMessage({ text: "Write something or add a photo before sharing your post.", isError: true });
      return;
    }

    setIsSubmitting(true);
    setMessage(null);
    try {
      const body: CreatePostRequest = {
        text: trimmedText,
        visibility,
        mentionedUserIds: getActiveMentionIds(trimmedText, selectedMentions),
      };
      let response: CreatePostResponse;
      if (photo) {
        const form = new FormData();
        form.append("text", body.text);
        form.append("visibility", body.visibility);
        form.append("mentionedUserIds", JSON.stringify(body.mentionedUserIds ?? []));
        form.append("file", photo);
        setUploadProgress(0);
        response = await apiSubmitPost<CreatePostResponse>("/api/posts", form, setUploadProgress);
      } else {
        response = await apiFetch<CreatePostResponse>("/api/posts", { method: "POST", body });
      }
      setText("");
      setSelectedMentions([]);
      setPhoto(null);
      setIsExpanded(false);
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
    setIsExpanded(true);
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
    <form
      ref={composerRef}
      className={`surface-card post-composer-card${isExpanded ? " post-composer-expanded" : ""}`}
      onSubmit={(event) => void submitPost(event)}
    >
      <div className="post-composer-inline">
        <Link className="post-composer-avatar" to="/profile" aria-label="View your profile" title="View your profile">
          {user?.avatarUrl
            ? <img src={user.avatarUrl} alt="" />
            : (user?.displayName ?? "Senderi").trim().charAt(0).toUpperCase() || "S"}
        </Link>
        <div className="post-composer-input-wrap">
          <MentionTextarea
            id="post-text"
            className="post-composer-input"
            ariaLabel="Post text"
            placeholder={isMobileViewport ? "Share your thoughts." : `What's on your mind, ${user?.displayName?.trim() || "friend"}?`}
            rows={1}
            value={text}
            onChange={(nextText) => {
              setText(nextText);
              setMessage(null);
            }}
            onMentionSelect={(mentionedUser) => setSelectedMentions((current) =>
              current.some((item) => item.id === mentionedUser.id) ? current : [...current, mentionedUser],
            )}
            onFocus={() => setIsExpanded(true)}
            maxLength={MAX_POST_LENGTH}
            required={!photo}
            disabled={isSubmitting}
          />
          {isExpanded && (
            <div className="post-composer-footer">
              <span className="text-xs text-muted">{text.length}/{MAX_POST_LENGTH}</span>
              <button className="button-accent" type="submit" disabled={isSubmitting || (!text.trim() && !photo)}>
                {isSubmitting ? (photo ? "Uploading..." : "Sharing...") : photo ? "Share post and photo" : "Share post"}
              </button>
            </div>
          )}
        </div>
        <div className="post-composer-actions">
          {audienceOptionsControl}
          <button
            className={`post-composer-action post-composer-photo${photo ? " has-photo" : ""}`}
            type="button"
            aria-label={photo ? "Change photo" : "Add a photo"}
            title={photo ? "Change photo" : "Add a photo"}
            disabled={isSubmitting}
            onClick={() => photoInput.current?.click()}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="8.5" cy="9" r="1.5" /><path d="m21 15-5-5L5 20" /></svg>
          </button>
        </div>
      </div>
      <input
        ref={photoInput}
        id="post-photo-picker"
        className="sr-only"
        tabIndex={-1}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        aria-label="Choose a post photo"
        disabled={isSubmitting}
        onChange={(event) => selectPhoto(event.target.files?.[0])}
      />
      {photo && photoPreview && (
        <div className="post-composer-photo-preview">
          <img src={photoPreview} alt="Selected post photo preview" />
          <div>
            <p>{photo.name} - {(photo.size / (1024 * 1024)).toFixed(2)} MB</p>
            <button
              type="button"
              onClick={() => {
                setPhoto(null);
                if (photoInput.current) photoInput.current.value = "";
              }}
              disabled={isSubmitting}
            >
              Remove photo
            </button>
          </div>
        </div>
      )}
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
  commentsPreview = true,
}: {
  post: Post;
  onUpdated: (updated: Post) => void;
  onShared: () => void;
  onDeleted: () => void;
  commentsPreview?: boolean;
}) {
  const { user } = useAuth();
  const [isUpdating, setIsUpdating] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isEditingPost, setIsEditingPost] = useState(false);
  const [editText, setEditText] = useState(post.text ?? "");
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isMenuOpenAbove, setIsMenuOpenAbove] = useState(false);
  const [detailMode, setDetailMode] = useState<"post" | "photo" | null>(null);
  const [detailIsOriginalPost, setDetailIsOriginalPost] = useState(false);
  const [commentsRefreshKey, setCommentsRefreshKey] = useState(0);
  const [updateMessage, setUpdateMessage] = useState<{ text: string; isError: boolean } | null>(null);
  const [isReportDialogOpen, setIsReportDialogOpen] = useState(false);
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
  const optionsMenuPanelRef = useRef<HTMLDivElement>(null);
  const optionsButtonRef = useRef<HTMLButtonElement>(null);
  const isOwner = user?.id === post.author.id;
  const isShareOwner = Boolean(post.share && user?.id === post.share.author.id);
  const canManagePostOptions = post.share ? isShareOwner : isOwner;
  const canReportPost = Boolean(user && !canManagePostOptions);
  const reportTargetType: ReportTargetType = post.share ? "share" : "post";
  const reportTargetId = post.share?.id ?? post.id;
  const canEditPost = isOwner && !post.share;
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

  useLayoutEffect(() => {
    if (!isMenuOpen) return;

    const button = optionsButtonRef.current;
    const menu = optionsMenuPanelRef.current;
    if (!button || !menu) return;

    const buttonRect = button.getBoundingClientRect();
    const menuHeight = menu.getBoundingClientRect().height;
    const spaceBelow = window.innerHeight - buttonRect.bottom - 8;
    const spaceAbove = buttonRect.top - 8;
    setIsMenuOpenAbove(spaceBelow < menuHeight && spaceAbove > spaceBelow);
  }, [isMenuOpen]);

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
      setUpdateMessage(null);
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

  async function saveEditedPost(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = editText.trim();
    if (!canEditPost || isUpdating || !text) return;

    setIsUpdating(true);
    setUpdateMessage({ text: "Saving post…", isError: false });
    try {
      const body: UpdatePostRequest = { text };
      const updatedPost = (await apiFetch<PostResponse>(`/api/posts/${post.id}`, { method: "PATCH", body })).post;
      setIsEditingPost(false);
      setUpdateMessage({ text: "Post updated.", isError: false });
      onUpdated(updatedPost);
    } catch (error: unknown) {
      setUpdateMessage({
        text: error instanceof ApiError ? error.message : "We couldn’t update this post. Try again.",
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
      <>
      <div className="post-options" ref={optionsMenuRef}>
        <button
          ref={optionsButtonRef}
          className="post-options-trigger"
          type="button"
          aria-label="Post options"
          aria-expanded={isMenuOpen}
          aria-controls={optionsMenuId}
          disabled={isEditingPost || isUpdating || isDeleting}
          onClick={() => setIsMenuOpen((open) => !open)}
        >
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <circle cx="5" cy="12" r="1.6" />
            <circle cx="12" cy="12" r="1.6" />
            <circle cx="19" cy="12" r="1.6" />
          </svg>
        </button>
        <div
          id={optionsMenuId}
          ref={optionsMenuPanelRef}
          className={`post-options-menu${isMenuOpenAbove ? " post-options-menu-above" : ""}`}
          hidden={!isMenuOpen}
        >
          <p className="post-options-title">Post options</p>
          <div className="post-options-audience">
            <span>Audience</span>
            <strong>{audienceLabel(displayedAudience)}</strong>
          </div>
          {canReportPost && <button className="post-options-edit post-options-report" type="button" onClick={() => {
            setIsMenuOpen(false);
            setIsReportDialogOpen(true);
          }}>Report {post.share ? "shared post" : "post"}</button>}
          {canManagePostOptions && (
            <>
              {canEditPost && (
                <button
                  className="post-options-edit"
                  type="button"
                  disabled={isDeleting || isUpdating}
                  onClick={() => {
                    setEditText(post.text ?? "");
                    setIsEditingPost(true);
                    setIsMenuOpen(false);
                    setUpdateMessage(null);
                  }}
                >
                  Edit post
                </button>
              )}
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
      <ReportDialog
        open={isReportDialogOpen}
        targetType={reportTargetType}
        targetId={reportTargetId}
        onClose={() => setIsReportDialogOpen(false)}
        onReported={() => setUpdateMessage({ text: "Thanks. Your report was sent to the moderators.", isError: false })}
      />
      </>
    );
  }

  const originalPostContent = (
    <>
      {isEditingPost ? (
        <form className="post-edit-form" onSubmit={(event) => void saveEditedPost(event)}>
          <textarea
            aria-label="Edit post text"
            maxLength={MAX_POST_LENGTH}
            required
            value={editText}
            onChange={(event) => setEditText(event.target.value)}
            disabled={isUpdating}
          />
          <div className="post-edit-footer">
            <span>{editText.length.toLocaleString()}/{MAX_POST_LENGTH}</span>
            <div className="post-edit-actions">
              <button
                className="button-secondary"
                type="button"
                onClick={() => {
                  setEditText(post.text ?? "");
                  setIsEditingPost(false);
                  setUpdateMessage(null);
                }}
                disabled={isUpdating}
              >
                Cancel
              </button>
              <button className="button-accent" type="submit" disabled={isUpdating || !editText.trim()}>
                {isUpdating ? "Saving…" : "Save changes"}
              </button>
            </div>
          </div>
        </form>
      ) : post.text ? (
        post.share ? (
          <div className="mt-5 whitespace-pre-wrap break-words text-sm leading-7 text-ink/85">{post.text}</div>
        ) : (
          <button
            className="post-text-open mt-5"
            type="button"
            aria-haspopup="dialog"
            aria-label={`Open post by ${post.author.displayName}`}
            onClick={() => setDetailMode("photo")}
          >
            {post.text}
          </button>
        )
      ) : null}
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
  const detailPost = detailIsOriginalPost && post.share ? { ...post, share: undefined } : post;
  const detailLikeState = detailIsOriginalPost && post.share ? postLikeState : cardLikeState;
  const detailLikeTarget = detailIsOriginalPost && post.share ? "post" : post.share ? "share" : "post";
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
                {post.share.author.displayName} <SupporterBadge user={post.share.author} />
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
            {post.author.displayName} <SupporterBadge user={post.author} />
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
          onClick={() => {
            setDetailIsOriginalPost(true);
            setDetailMode("photo");
          }}
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
          <span className="post-action-label">
            {isCardLikePending ? (cardLikeState.isLikedByViewer ? "Removing Like..." : "Liking...") : cardLikeState.isLikedByViewer ? "Liked" : "Like"}
          </span>
        </button>
        <CommentsPanel
          postId={post.id}
          shareId={post.share?.id}
          commentCount={post.share?.commentCount ?? post.commentCount}
          preview={commentsPreview}
          refreshKey={commentsRefreshKey}
          onViewMore={() => {
            if (commentsPreview) {
              setDetailIsOriginalPost(false);
              setDetailMode("photo");
            }
          }}
        />
        <ShareControl post={post} onShared={onShared} />
      </div>
      {detailMode && (
        <PostDetailsDialog
          post={detailPost}
          isOpen
          photoViewer={detailMode === "photo"}
          onClose={() => {
            setDetailMode(null);
            setDetailIsOriginalPost(false);
            setCommentsRefreshKey((key) => key + 1);
          }}
          likeState={detailLikeState}
          isLikePending={pendingLikeTarget !== null}
          likeMessage={likeMessage}
          onToggleLike={() => void toggleLike(detailLikeTarget)}
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
