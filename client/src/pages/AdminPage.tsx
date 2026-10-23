import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../api/client";
import { SupporterBadge } from "../components/SupporterBadge";

type AdminUser = { id: string; displayName: string; email: string; supporterBadge: boolean; verifiedBadge: boolean; suspendedAt: string | null; isAdmin: boolean };
type AdminContent = { id: string; author: string; text: string; createdAt: string; hiddenAt: string | null; visibility?: string; hasPhoto?: boolean; postId?: string };
type Audit = { id: string; actorId: string; targetId: string; action: string; reason: string; createdAt: string };
type Tab = "users" | "posts" | "comments" | "audit";
type Page<T> = { items: T[]; nextOffset: number | null };

export function AdminPage() {
  const [tab, setTab] = useState<Tab>("users");
  const [query, setQuery] = useState("");
  const [reason, setReason] = useState("");
  const [items, setItems] = useState<Array<AdminUser | AdminContent | Audit>>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const requestNumber = useRef(0);

  const load = useCallback(async (offset = 0) => {
    const currentRequest = ++requestNumber.current;
    if (offset === 0) { setItems([]); setNextOffset(null); }
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ offset: String(offset) });
      if (tab !== "audit" && query.trim()) params.set("q", query.trim());
      const page = await apiFetch<Page<AdminUser | AdminContent | Audit>>(`/api/admin/${tab}?${params}`);
      if (currentRequest !== requestNumber.current) return;
      setItems((previous) => offset ? [...previous, ...page.items] : page.items);
      setNextOffset(page.nextOffset);
    } catch (cause) {
      if (currentRequest === requestNumber.current) setError(cause instanceof Error ? cause.message : "Could not load admin data.");
    } finally { if (currentRequest === requestNumber.current) setLoading(false); }
  }, [tab, query]);

  useEffect(() => { void load(); }, [load, revision]);

  async function change(path: string, body: object) {
    if (reason.trim().length < 3) { setError("Enter a reason of at least 3 characters."); return; }
    setLoading(true);
    setError("");
    try {
      await apiFetch(path, { method: "PATCH", body: { ...body, reason: reason.trim() } });
      setReason("");
      setRevision((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The action failed.");
      setLoading(false);
    }
  }

  return <div className="mx-auto w-full max-w-5xl space-y-6">
    <div><span className="eyebrow">Administration</span><h1 className="mt-2 text-3xl font-bold">Senderi admin</h1><p className="text-muted">Manage accounts, badges, and content.</p></div>
    <nav className="flex flex-wrap gap-2" aria-label="Admin sections">{(["users", "posts", "comments", "audit"] as Tab[]).map((name) =>
      <button key={name} type="button" className={`rounded-full px-4 py-2 font-semibold ${tab === name ? "bg-ink text-white" : "bg-white text-ink"}`} onClick={() => {
        if (name !== tab) {
          requestNumber.current += 1;
          setItems([]);
          setNextOffset(null);
          setError("");
        }
        setTab(name);
        setQuery("");
      }}>{name[0].toUpperCase() + name.slice(1)}</button>,
    )}</nav>
    {tab !== "audit" && <input className="w-full rounded-xl border border-line bg-white px-4 py-3" type="search" aria-label={`Search ${tab}`} placeholder={tab === "users" ? "Search name or email" : `Search ${tab} text`} value={query} onChange={(event) => setQuery(event.target.value)} />}
    {tab !== "audit" && <label className="block font-semibold">Reason for changes<input className="mt-2 block w-full rounded-xl border border-line bg-white px-4 py-3 font-normal" value={reason} maxLength={500} placeholder="Required for every change" onChange={(event) => setReason(event.target.value)} /></label>}
    {error && <p role="alert" className="text-red-700">{error}</p>}
    <div className="grid gap-3">{items.filter((item) => tab !== "audit" || ("action" in item && typeof item.action === "string")).map((item) => {
      if (tab === "users") { const user = item as AdminUser; return <article key={user.id} className="rounded-2xl border border-line bg-white p-4">
        <div className="font-bold">{user.displayName} <SupporterBadge user={user} /></div><p className="break-all text-sm text-muted">{user.email} · {user.id}</p>
        <p className="text-sm">{user.isAdmin ? "Admin" : user.suspendedAt ? "Suspended" : "Active"}</p>
        <div className="mt-3 flex flex-wrap gap-2"><button disabled={loading} className="rounded-lg border border-line px-3 py-2" onClick={() => void change(`/api/admin/users/${user.id}/badge`, { enabled: !user.supporterBadge })}>{user.supporterBadge ? "Remove Owner badge" : "Grant Owner badge"}</button>
        <button disabled={loading} className="rounded-lg border border-line px-3 py-2" onClick={() => void change(`/api/admin/users/${user.id}/verified-badge`, { enabled: !user.verifiedBadge })}>{user.verifiedBadge ? "Remove verified badge" : "Grant verified badge"}</button>
        {!user.isAdmin && <button disabled={loading} className="rounded-lg border border-line px-3 py-2" onClick={() => void change(`/api/admin/users/${user.id}/suspension`, { enabled: !user.suspendedAt })}>{user.suspendedAt ? "Reactivate" : "Suspend"}</button>}</div>
      </article>; }
      if (tab === "audit") { const entry = item as Audit; return <article key={entry.id} className="rounded-2xl border border-line bg-white p-4"><strong>{entry.action.replaceAll("_", " ")}</strong><p className="text-sm text-muted">{entry.createdAt} · Actor {entry.actorId} · Target {entry.targetId}</p><p>{entry.reason}</p></article>; }
      const content = item as AdminContent; return <article key={content.id} className="rounded-2xl border border-line bg-white p-4">
        <div className="font-bold">{content.author} <span className="font-normal text-muted">· {content.createdAt} {content.visibility && `· ${content.visibility}`}</span></div>
        <p className="my-2 whitespace-pre-wrap break-words">{content.text || "Photo post"}</p>
        {content.hasPhoto && <img className="mb-3 max-h-80 rounded-xl object-contain" src={`/api/admin/posts/${content.id}/photo`} alt="Post attachment" />}
        {content.postId && <p className="text-xs text-muted">Post {content.postId}</p>}
        <button disabled={loading} className="mt-2 rounded-lg border border-line px-3 py-2" onClick={() => void change(`/api/admin/${tab}/${content.id}/visibility`, { hidden: !content.hiddenAt })}>{content.hiddenAt ? "Restore" : "Hide"} {tab === "posts" ? "post" : "comment"}</button>
      </article>;
    })}</div>
    {!loading && items.length === 0 && <p className="text-muted">No results.</p>}
    {loading && <p role="status" className="text-muted">Loading…</p>}
    {nextOffset !== null && <button disabled={loading} className="rounded-xl border border-line bg-white px-4 py-2" onClick={() => void load(nextOffset)}>Load more</button>}
  </div>;
}
