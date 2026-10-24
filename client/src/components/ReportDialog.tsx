import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { CreateReportRequest, CreateReportResponse, ReportReason, ReportTargetType } from "../../../shared";
import { ApiError, apiFetch } from "../api/client";

const reasons: Array<{ value: ReportReason; label: string }> = [
  { value: "spam", label: "Spam" },
  { value: "harassment", label: "Harassment or bullying" },
  { value: "hate", label: "Hateful content" },
  { value: "violence", label: "Violence or dangerous behavior" },
  { value: "sexual_content", label: "Sexual content" },
  { value: "scam", label: "Scam or misleading content" },
  { value: "other", label: "Something else" },
];

const targetLabels: Record<ReportTargetType, string> = {
  post: "post",
  share: "shared post",
  comment: "comment",
  message: "message",
};

export function ReportDialog({
  open,
  targetType,
  targetId,
  onClose,
  onReported,
}: {
  open: boolean;
  targetType: ReportTargetType;
  targetId: string;
  onClose: () => void;
  onReported: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const reasonId = useId();
  const detailsId = useId();
  const [reason, setReason] = useState<ReportReason>("spam");
  const [details, setDetails] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (open) {
      setReason("spam");
      setDetails("");
      setError("");
    }
  }, [open, targetId]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const body: CreateReportRequest = {
        targetType,
        targetId,
        reason,
        ...(details.trim() ? { details: details.trim() } : {}),
      };
      await apiFetch<CreateReportResponse>("/api/reports", { method: "POST", body });
      onReported();
      onClose();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Could not submit the report. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="report-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}
      onClose={() => { if (open && !busy) onClose(); }}
    >
      <form className="report-dialog-form" onSubmit={(event) => void submit(event)}>
        <header className="report-dialog-header">
          <div><span className="eyebrow">Community safety</span><h2 id={titleId}>Report this {targetLabels[targetType]}</h2></div>
          <button className="report-dialog-close" type="button" aria-label="Close report dialog" onClick={onClose} disabled={busy}>×</button>
        </header>
        <div className="report-dialog-body">
          <p>Choose the reason that best describes the issue. Reports are reviewed by Senderi moderators.</p>
          <label htmlFor={reasonId}>Reason</label>
          <select id={reasonId} value={reason} onChange={(event) => setReason(event.target.value as ReportReason)} disabled={busy}>
            {reasons.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
          <label htmlFor={detailsId}>More details <span>(optional)</span></label>
          <textarea id={detailsId} value={details} onChange={(event) => setDetails(event.target.value)} maxLength={1_000} rows={4} placeholder="Add details to help the moderators review this report." disabled={busy} />
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
        <footer className="report-dialog-footer">
          <button className="button-secondary" type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="button-accent" type="submit" disabled={busy}>{busy ? "Submitting…" : "Submit report"}</button>
        </footer>
      </form>
    </dialog>
  );
}
