import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { Post, PostResponse } from "../../../shared";
import { ApiError, apiFetch } from "../api/client";
import { RequestErrorState } from "../components/AsyncState";
import { PostCard } from "../components/Posts";
import { PostListSkeleton } from "../components/Skeletons";

export function PostPage() {
  const { postId } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [post, setPost] = useState<Post | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const commentsInitiallyOpen = searchParams.get("comments") === "1";

  const loadPost = useCallback(async (showLoading = true) => {
    if (!postId) {
      setError("The post link is incomplete.");
      setIsLoading(false);
      return;
    }

    if (showLoading) setIsLoading(true);
    setError(null);
    try {
      const response = await apiFetch<PostResponse>(`/api/posts/${encodeURIComponent(postId)}`);
      setPost(response.post);
    } catch (requestError: unknown) {
      setError(requestError instanceof ApiError ? requestError.message : "We couldn't load this post. Try again.");
    } finally {
      if (showLoading) setIsLoading(false);
    }
  }, [postId]);

  useEffect(() => {
    void loadPost();
  }, [loadPost]);

  return (
    <div className="home-feed-column space-y-4">
      {isLoading ? (
        <PostListSkeleton count={1} />
      ) : error || !post ? (
        <div className="space-y-3">
          <RequestErrorState title="Unable to open post" message={error ?? "Post was not found."} />
          <button className="button-secondary" type="button" onClick={() => void loadPost()}>
            Try again
          </button>
        </div>
      ) : (
        <PostCard
          post={post}
          commentsInitiallyOpen={commentsInitiallyOpen}
          onUpdated={setPost}
          onShared={() => { void loadPost(false); }}
          onDeleted={() => navigate("/", { replace: true })}
        />
      )}
    </div>
  );
}
