import { useEffect, useState } from "react";
import type { MyReport, MyReportsResponse } from "../../../shared";
import { apiFetch } from "../api/client";

function reportStatusLabel(report: MyReport): string {
  if (report.status === "open") return "Being reviewed";
  if (report.actionTaken) return "Reviewed · action taken";
  if (report.status === "dismissed") return "Reviewed · no action taken";
  return "Reviewed · no action taken";
}

function reportReasonLabel(reason: MyReport["reason"]): string {
  return {
    spam: "Spam",
    harassment: "Harassment or bullying",
    hate: "Hateful content",
    violence: "Violence or dangerous behavior",
    sexual_content: "Sexual content",
    scam: "Scam or misleading content",
    other: "Something else",
  }[reason];
}

export function MyReportsPage() {
  const [reports, setReports] = useState<MyReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void apiFetch<MyReportsResponse>("/api/reports").then((response) => {
      if (active) setReports(response.items);
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : "Could not load your reports.");
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, []);

  return <div className="mx-auto w-full max-w-4xl space-y-5">
    <header>
      <span className="eyebrow">Community safety</span>
      <h1 className="mt-2 text-3xl font-bold">My reports</h1>
      <p className="text-muted">Check the review status of content you reported. Only you can see this list. Reports expire after seven days if still open, or seven days after review.</p>
    </header>
    {loading && <p role="status" className="text-muted">Loading your reports…</p>}
    {error && <p role="alert" className="text-red-700">{error}</p>}
    {!loading && !error && reports.length === 0 && <section className="rounded-2xl border border-line bg-white p-5 text-muted">You haven’t submitted any reports.</section>}
    <div className="grid gap-3">
      {reports.map((report) => <article key={report.id} className="rounded-2xl border border-line bg-white p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-bold">{report.targetType === "share" ? "Shared post" : report.targetType[0]!.toUpperCase() + report.targetType.slice(1)} · {reportReasonLabel(report.reason)}</h2>
            <p className="mt-1 text-sm text-muted">Submitted {new Date(report.createdAt).toLocaleString()}</p>
          </div>
          <span className={`rounded-full px-3 py-1 text-xs font-bold ${report.status === "open" ? "bg-accent-soft text-accent-dark" : "bg-canvas text-muted"}`}>
            {reportStatusLabel(report)}
          </span>
        </div>
        <p className="my-3 whitespace-pre-wrap break-words">{report.targetExcerpt || (report.hasPhoto ? "Photo attachment" : "No text provided")}</p>
        {report.hasPhoto && <p className="text-sm text-muted">A photo was attached to the content you reported.</p>}
        {report.details && <p className="mt-3 rounded-xl bg-canvas p-3 text-sm"><strong>Your details:</strong> {report.details}</p>}
        {report.reviewedAt && <p className="mt-3 text-sm text-muted">Reviewed {new Date(report.reviewedAt).toLocaleString()}.</p>}
      </article>)}
    </div>
  </div>;
}
