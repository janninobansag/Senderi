import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { apiFetch } from "../api/client";

type Notice = { kind: "success" | "error"; text: string } | null;

function SettingsNotice({ notice }: { notice: Notice }) {
  if (!notice) return null;
  return <p className={`account-settings-notice account-settings-notice-${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>{notice.text}</p>;
}

export function AccountSettingsPage() {
  const { user, refreshUser, updateAccountDetails } = useAuth();
  const navigate = useNavigate();
  const [identityBusy, setIdentityBusy] = useState(false);
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [deactivateBusy, setDeactivateBusy] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [identityNotice, setIdentityNotice] = useState<Notice>(null);
  const [passwordNotice, setPasswordNotice] = useState<Notice>(null);
  const [deactivateNotice, setDeactivateNotice] = useState<Notice>(null);
  const [deleteNotice, setDeleteNotice] = useState<Notice>(null);

  async function updateIdentity(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const displayName = String(data.get("displayName") ?? "").trim();
    const email = String(data.get("email") ?? "").trim();
    const currentPassword = String(data.get("currentPassword") ?? "");
    setIdentityBusy(true);
    setIdentityNotice(null);
    try {
      const response = await apiFetch<{ user: { displayName: string; email: string } }>("/api/account/identity", {
        method: "PATCH",
        body: { displayName, email, currentPassword },
      });
      updateAccountDetails(response.user);
      (form.elements.namedItem("displayName") as HTMLInputElement).value = response.user.displayName;
      (form.elements.namedItem("email") as HTMLInputElement).value = response.user.email;
      (form.elements.namedItem("currentPassword") as HTMLInputElement).value = "";
      setIdentityNotice({ kind: "success", text: "Your account details have been updated." });
    } catch (error) {
      setIdentityNotice({ kind: "error", text: error instanceof Error ? error.message : "Could not update your account details." });
    } finally {
      setIdentityBusy(false);
    }
  }

  async function updatePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const currentPassword = String(data.get("currentPassword") ?? "");
    const newPassword = String(data.get("newPassword") ?? "");
    const confirmPassword = String(data.get("confirmPassword") ?? "");
    if (newPassword !== confirmPassword) {
      setPasswordNotice({ kind: "error", text: "The new passwords do not match." });
      return;
    }
    setPasswordBusy(true);
    setPasswordNotice(null);
    try {
      await apiFetch<void>("/api/account/password", { method: "POST", body: { currentPassword, newPassword } });
      form.reset();
      setPasswordNotice({ kind: "success", text: "Your password has been changed. Other signed-in devices have been signed out." });
    } catch (error) {
      setPasswordNotice({ kind: "error", text: error instanceof Error ? error.message : "Could not change your password." });
    } finally {
      setPasswordBusy(false);
    }
  }

  async function deactivateAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!window.confirm("Deactivate your account? You will be signed out. Your profile and existing content will remain visible until you sign in again.")) return;
    const form = event.currentTarget;
    const currentPassword = String(new FormData(form).get("currentPassword") ?? "");
    setDeactivateBusy(true);
    setDeactivateNotice(null);
    try {
      await apiFetch<void>("/api/account/deactivate", { method: "POST", body: { currentPassword } });
      await refreshUser();
      navigate("/login", { replace: true });
    } catch (error) {
      setDeactivateNotice({ kind: "error", text: error instanceof Error ? error.message : "Could not deactivate your account." });
      setDeactivateBusy(false);
    }
  }

  async function deleteAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const currentPassword = String(data.get("currentPassword") ?? "");
    const confirmation = String(data.get("confirmation") ?? "");
    if (confirmation !== "DELETE") {
      setDeleteNotice({ kind: "error", text: "Type DELETE exactly to confirm permanent deletion." });
      return;
    }
    if (!window.confirm("Permanently delete your Senderi account and its content? This cannot be undone.")) return;
    setDeleteBusy(true);
    setDeleteNotice(null);
    try {
      await apiFetch<void>("/api/account/me", { method: "DELETE", body: { currentPassword, confirmation } });
      await refreshUser();
      navigate("/login", { replace: true });
    } catch (error) {
      setDeleteNotice({ kind: "error", text: error instanceof Error ? error.message : "Could not delete your account." });
      setDeleteBusy(false);
    }
  }

  if (!user) return null;

  return <div className="account-settings-page">
    <header className="account-settings-heading">
      <span className="eyebrow">Your account</span>
      <h1>Settings</h1>
      <p>Manage your profile details, sign-in credentials, and account status.</p>
    </header>

    <details className="surface-card account-settings-section" aria-labelledby="account-details-heading" open>
      <summary className="account-settings-summary">
        <span className="account-settings-summary-copy">
          <span id="account-details-heading" className="account-settings-section-title" role="heading" aria-level={2}>Account details</span>
          <span className="account-settings-section-description">Change the name people see and the email you use to sign in.</span>
        </span>
      </summary>
      <div className="account-settings-content">
        <SettingsNotice notice={identityNotice} />
        <form className="account-settings-form" onSubmit={(event) => void updateIdentity(event)}>
          <label>Display name<input className="form-input" name="displayName" autoComplete="name" required maxLength={80} defaultValue={user.displayName} /></label>
          <label>Email address<input className="form-input" name="email" type="email" autoComplete="email" required maxLength={254} defaultValue={user.email} /><span className="account-settings-help">Email changes take effect immediately and are used for sign-in and password resets.</span></label>
          <label>Current password<input className="form-input" name="currentPassword" type="password" autoComplete="current-password" required maxLength={128} /></label>
          <button className="account-settings-primary" type="submit" disabled={identityBusy}>{identityBusy ? "Saving…" : "Save account details"}</button>
        </form>
      </div>
    </details>

    <details className="surface-card account-settings-section" aria-labelledby="password-heading">
      <summary className="account-settings-summary">
        <span className="account-settings-summary-copy">
          <span id="password-heading" className="account-settings-section-title" role="heading" aria-level={2}>Change password</span>
          <span className="account-settings-section-description">Use at least 12 characters. Changing your password signs out your other devices.</span>
        </span>
      </summary>
      <div className="account-settings-content">
        <SettingsNotice notice={passwordNotice} />
        <form className="account-settings-form" onSubmit={(event) => void updatePassword(event)}>
          <label>Current password<input className="form-input" name="currentPassword" type="password" autoComplete="current-password" required maxLength={128} /></label>
          <label>New password<input className="form-input" name="newPassword" type="password" autoComplete="new-password" required minLength={12} maxLength={128} /></label>
          <label>Confirm new password<input className="form-input" name="confirmPassword" type="password" autoComplete="new-password" required minLength={12} maxLength={128} /></label>
          <button className="account-settings-primary" type="submit" disabled={passwordBusy}>{passwordBusy ? "Updating…" : "Change password"}</button>
        </form>
      </div>
    </details>

    <details className="surface-card account-settings-section" aria-labelledby="deactivate-heading">
      <summary className="account-settings-summary">
        <span className="account-settings-summary-copy">
          <span id="deactivate-heading" className="account-settings-section-title" role="heading" aria-level={2}>Deactivate account</span>
          <span className="account-settings-section-description">Deactivation signs you out and removes your active sessions and notification subscriptions. Your profile, posts, and messages stay visible. Signing in again reactivates the account.</span>
        </span>
      </summary>
      <div className="account-settings-content">
        <SettingsNotice notice={deactivateNotice} />
        <form className="account-settings-form" onSubmit={(event) => void deactivateAccount(event)}>
          <label>Current password<input className="form-input" name="currentPassword" type="password" autoComplete="current-password" required maxLength={128} /></label>
          <button className="account-settings-secondary" type="submit" disabled={deactivateBusy || deleteBusy}>{deactivateBusy ? "Deactivating…" : "Deactivate account"}</button>
        </form>
      </div>
    </details>

    <details className="account-settings-section account-settings-danger" aria-labelledby="delete-heading">
      <summary className="account-settings-summary">
        <span className="account-settings-summary-copy">
          <span id="delete-heading" className="account-settings-section-title" role="heading" aria-level={2}>Permanently delete account</span>
          <span className="account-settings-section-description">This removes your account, profile images, posts, shares, comments and replies, reactions, messages, connections, and notifications. This action cannot be undone.</span>
        </span>
      </summary>
      <div className="account-settings-content">
        <SettingsNotice notice={deleteNotice} />
        <form className="account-settings-form" onSubmit={(event) => void deleteAccount(event)}>
          <label>Current password<input className="form-input" name="currentPassword" type="password" autoComplete="current-password" required maxLength={128} /></label>
          <label>Type DELETE to confirm<input className="form-input" name="confirmation" autoComplete="off" required pattern="DELETE" /></label>
          <button className="account-settings-delete" type="submit" disabled={deleteBusy || deactivateBusy}>{deleteBusy ? "Deleting account…" : "Permanently delete my account"}</button>
        </form>
      </div>
    </details>
  </div>;
}
