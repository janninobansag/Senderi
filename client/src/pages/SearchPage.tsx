import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { User, UserSearchResponse } from "../../../shared";
import { ApiError, apiFetch } from "../api/client";
import { EmptyState, RequestErrorState } from "../components/AsyncState";
import { PostList } from "../components/Posts";
import { PeopleRowsSkeleton } from "../components/Skeletons";

export function SearchPage() {
  const [searchParams] = useSearchParams();
  const query = searchParams.get("query")?.trim() ?? "";
  const [people, setPeople] = useState<User[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    if (!query) {
      setPeople([]);
      setNextCursor(null);
      setError(null);
      setIsLoading(false);
      return () => { active = false; };
    }

    setIsLoading(true);
    setError(null);
    setLoadMoreError(null);
    const params = new URLSearchParams({ query, limit: "20" });
    void apiFetch<UserSearchResponse>(`/api/users?${params.toString()}`)
      .then((page) => {
        if (!active) return;
        setPeople(page.items);
        setNextCursor(page.nextCursor);
      })
      .catch((requestError: unknown) => {
        if (active) setError(requestError instanceof ApiError ? requestError.message : "Search could not load. Please try again.");
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => { active = false; };
  }, [query]);

  async function loadMorePeople() {
    if (!query || !nextCursor || isLoadingMore) return;
    setIsLoadingMore(true);
    setLoadMoreError(null);
    const params = new URLSearchParams({ query, cursor: nextCursor, limit: "20" });
    try {
      const page = await apiFetch<UserSearchResponse>(`/api/users?${params.toString()}`);
      setPeople((current) => [...current, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (requestError) {
      setLoadMoreError(requestError instanceof ApiError ? requestError.message : "More people could not load. Please try again.");
    } finally {
      setIsLoadingMore(false);
    }
  }

  const postSearchPath = `/api/posts/search?${new URLSearchParams({ query, limit: "20" }).toString()}`;

  return (
    <div className="search-results-page">
      <header className="search-results-heading">
        <span className="eyebrow">Search Senderi</span>
        <h1>{query ? <>Results for <span>“{query}”</span></> : "Search for people and posts"}</h1>
        <p>Find people and posts shared with you.</p>
      </header>

      {!query ? (
        <EmptyState title="Enter a search" message="Use the search bar beside the Senderi logo to find people and posts." />
      ) : (
        <div className="search-results-grid">
          <section className="search-results-section" aria-labelledby="search-people-title">
            <div className="search-results-section-heading"><h2 id="search-people-title">People</h2></div>
            {isLoading ? <PeopleRowsSkeleton message="Searching people" /> : error ? <RequestErrorState title="People search unavailable" message={error} /> : people.length === 0 ? (
              <EmptyState title="No people found" message="Try another name or spelling." />
            ) : (
              <ul className="search-people-list">
                {people.map((person) => (
                  <li key={person.id}>
                    <Link className="search-person-result" to={`/profile/${encodeURIComponent(person.id)}`}>
                      <span className="search-person-avatar">
                        {person.avatarUrl ? <img src={person.avatarUrl} alt="" /> : person.displayName.trim().charAt(0).toUpperCase() || "?"}
                      </span>
                      <span className="search-person-copy"><strong>{person.displayName}</strong><span>{person.bio || person.info.location || "Senderi member"}</span></span>
                      <span className="search-person-action">View profile</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {isLoadingMore && <PeopleRowsSkeleton count={2} message="Loading more people" />}
            {loadMoreError && <RequestErrorState title="More people could not load" message={loadMoreError} />}
            {nextCursor && !isLoading && <button className="button-secondary search-load-more" type="button" onClick={() => void loadMorePeople()} disabled={isLoadingMore}>{isLoadingMore ? "Loading…" : "Load more people"}</button>}
          </section>

          <section className="search-results-section" aria-labelledby="search-posts-title">
            <div className="search-results-section-heading"><h2 id="search-posts-title">Posts</h2></div>
            <PostList path={postSearchPath} />
          </section>
        </div>
      )}
    </div>
  );
}
