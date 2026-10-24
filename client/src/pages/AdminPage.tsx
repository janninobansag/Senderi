import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../api/client";
import { SupporterBadge } from "../components/SupporterBadge";

type AdminUser = { id: string; displayName: string; email: string; supporterBadge: boolean; verifiedBadge: boolean; suspendedAt: string | null; isAdmin: boolean };
type AdminContent = { id: string; author: string; text: string; createdAt: string; hiddenAt: string | null; visibility?: string; hasPhoto?: boolean; postId?: string };
type Audit = { id: string; actorId: string; targetId: string; action: string; reason: string; createdAt: string };
type AdminReport = { id: string; targetType: "post" | "share" | "comment" | "message"; targetId: string; targetOwnerId: string; targetOwner: string; reporterId: string; reporter: string; reason: string; details: string; targetExcerpt: string; hasPhoto: boolean; status: "open" | "resolved" | "dismissed"; actionTaken: boolean; createdAt: string; reviewReason: string; purgeAt: string | null };
type Tab = "users" | "posts" | "comments" | "reports" | "audit";
type Page<T> = { items: T[]; nextOffset: number | null };

export function AdminPage() {
  const [tab, setTab] = useState<Tab>("users");
  const [query, setQuery] = useState("");
  const [reason, setReason] = useState("");
  const [reportStatus, setReportStatus] = useState<"open" | "resolved" | "dismissed" | "all">("open");
  const [items, setItems] = useState<Array<AdminUser | AdminContent | AdminReport | Audit>>([]);
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
      if (tab === "reports") params.set("status", reportStatus);
      const page = await apiFetch<Page<AdminUser | AdminContent | AdminReport | Audit>>(`/api/admin/${tab}?${params}`);
      if (currentRequest !== requestNumber.current) return;
      setItems((previous) => offset ? [...previous, ...page.items] : page.items);
      setNextOffset(page.nextOffset);
    } catch (cause) {
      if (currentRequest === requestNumber.current) setError(cause instanceof Error ? cause.message : "Could not load admin data.");
    } finally { if (currentRequest === requestNumber.current) setLoading(false); }
  }, [tab, query, reportStatus]);

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

  async function deleteComment(content: AdminContent) {
    if (reason.trim().length < 3) { setError("Enter a reason of at least 3 characters."); return; }
    if (!window.confirm("Permanently delete this comment? Any replies to it will also be deleted. This cannot be undone.")) return;
    setLoading(true);
    setError("");
    try {
      await apiFetch(`/api/admin/comments/${content.id}`, { method: "DELETE", body: { reason: reason.trim() } });
      setReason("");
      setRevision((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The action failed.");
      setLoading(false);
    }
  }

  return <div className="mx-auto w-full max-w-5xl space-y-6">
    <div><span className="eyebrow">Administration</span><h1 className="mt-2 text-3xl font-bold">Senderi admin</h1><p className="text-muted">Manage accounts, badges, content, and reports.</p></div>
    <nav className="flex flex-wrap gap-2" aria-label="Admin sections">{(["users", "posts", "comments", "reports", "audit"] as Tab[]).map((name) =>
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
    {tab === "reports" && <label className="block font-semibold">Report status<select className="mt-2 block w-full rounded-xl border border-line bg-white px-4 py-3 font-normal" value={reportStatus} onChange={(event) => setReportStatus(event.target.value as typeof reportStatus)}><option value="open">Open</option><option value="resolved">Resolved</option><option value="dismissed">Dismissed</option><option value="all">All reports</option></select></label>}
    {tab !== "audit" && <label className="block font-semibold">{tab === "reports" ? "Moderator review reason" : "Reason for changes"}<input className="mt-2 block w-full rounded-xl border border-line bg-white px-4 py-3 font-normal" value={reason} maxLength={500} placeholder="Required for every change" onChange={(event) => setReason(event.target.value)} /></label>}
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
      if (tab === "reports") { const report = item as AdminReport; return <article key={report.id} className="rounded-2xl border border-line bg-white p-4">
        <div className="flex flex-wrap items-start justify-between gap-2"><strong>{report.targetType.replaceAll("_", " ")} report · {report.reason.replaceAll("_", " ")}</strong><span className="rounded-full bg-accent-soft px-3 py-1 text-xs font-bold capitalize">{report.status}</span></div>
        <p className="mt-2 text-sm text-muted">{new Date(report.createdAt).toLocaleString()} · Reported by {report.reporter} · Content by {report.targetOwner}</p>
        <p className="my-2 whitespace-pre-wrap break-words">{report.targetExcerpt || (report.hasPhoto ? "Photo attachment" : "No text provided")}</p>
        {report.hasPhoto && <img className="mb-3 max-h-80 max-w-full rounded-xl object-contain" src={`/api/admin/reports/${report.id}/photo`} alt="Reported photo attachment" />}
        {report.details && <p className="rounded-xl bg-canvas p-3 text-sm">Reporter details: {report.details}</p>}
        <p className="mt-2 text-xs text-muted">Target ID: {report.targetId}</p>
        {report.purgeAt && <p className="text-xs text-muted">Scheduled deletion: {new Date(report.purgeAt).toLocaleString()}</p>}
        {report.status === "open" ? <div className="mt-3 flex flex-wrap gap-2">
          <button disabled={loading} className="rounded-lg border border-line px-3 py-2" onClick={() => void change(`/api/admin/reports/${report.id}/status`, { status: "resolved" })}>Resolve without changing content</button>
          <button disabled={loading} className="rounded-lg border border-line px-3 py-2" onClick={() => void change(`/api/admin/reports/${report.id}/status`, { status: "resolved", contentAction: "hide" })}>{report.targetType === "message" ? "Hide message & resolve" : "Hide content & resolve"}</button>
          <button disabled={loading} className="rounded-lg border border-red-300 px-3 py-2 text-red-700 hover:bg-red-50" onClick={() => void change(`/api/admin/reports/${report.id}/status`, { status: "dismissed" })}>Dismiss report</button>
        </div> : <>
          {report.reviewReason && <p className="mt-2 text-sm text-muted">Review note: {report.reviewReason}</p>}
          {report.status === "resolved" && report.actionTaken && <button disabled={loading} className="mt-3 rounded-lg border border-line px-3 py-2" onClick={() => void change(`/api/admin/reports/${report.id}/status`, { status: "resolved", contentAction: "restore" })}>Restore content</button>}
        </>}
      </article>; }
      const content = item as AdminContent; return <article key={content.id} className="rounded-2xl border border-line bg-white p-4">
        <div className="font-bold">{content.author} <span className="font-normal text-muted">· {content.createdAt} {content.visibility && `· ${content.visibility}`}</span></div>
        <p className="my-2 whitespace-pre-wrap break-words">{content.text || "Photo post"}</p>
        {content.hasPhoto && <img className="mb-3 max-h-80 rounded-xl object-contain" src={`/api/admin/posts/${content.id}/photo`} alt="Post attachment" />}
        {content.postId && <p className="text-xs text-muted">Post {content.postId}</p>}
        <div className="mt-2 flex flex-wrap gap-2"><button disabled={loading} className="rounded-lg border border-line px-3 py-2" onClick={() => void change(`/api/admin/${tab}/${content.id}/visibility`, { hidden: !content.hiddenAt })}>{content.hiddenAt ? "Restore" : "Hide"} {tab === "posts" ? "post" : "comment"}</button>
        {tab === "comments" && <button disabled={loading} className="rounded-lg border border-red-300 px-3 py-2 text-red-700 hover:bg-red-50" onClick={() => void deleteComment(content)}>Delete permanently</button>}</div>
      </article>;
    })}</div>
    {!loading && items.length === 0 && <p className="text-muted">No results.</p>}
    {loading && <p role="status" className="text-muted">Loading…</p>}
    {nextOffset !== null && <button disabled={loading} className="rounded-xl border border-line bg-white px-4 py-2" onClick={() => void load(nextOffset)}>Load more</button>}
  </div>;
}
