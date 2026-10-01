import { useState, type FormEvent, type InputHTMLAttributes, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ApiError, apiFetch } from "../api/client";
import { useAuth } from "../auth/AuthContext";

type FieldErrors = Partial<Record<"displayName" | "email" | "password" | "confirmPassword", string>>;

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function validateEmail(email: string): string | undefined {
  if (!email) return "Enter your email address.";
  if (email.length > 254 || !isValidEmail(email)) return "Enter a valid email address.";
  return undefined;
}

function validatePassword(password: string): string | undefined {
  if (password.length < 12) return "Use at least 12 characters.";
  if (password.length > 128) return "Use no more than 128 characters.";
  return undefined;
}

function requestErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  if (error.code === "rate_limited") {
    const retryMessage = error.retryAfterSeconds
      ? ` Try again in about ${Math.ceil(error.retryAfterSeconds / 60)} minute(s).`
      : " Please wait before trying again.";
    return `${error.message}${retryMessage}`;
  }
  return error.message;
}

function Field({
  id,
  label,
  error,
  className = "",
  ...inputProps
}: InputHTMLAttributes<HTMLInputElement> & { id: string; label: string; error?: string }) {
  const errorId = `${id}-error`;
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="block text-sm font-semibold text-ink">{label}</label>
      <input
        id={id}
        className={`form-input ${error ? "form-input-error" : ""} ${className}`}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
        {...inputProps}
      />
      {error && <p id={errorId} className="field-error" role="alert">{error}</p>}
    </div>
  );
}

function FormAlert({ children }: { children: ReactNode }) {
  return <div className="form-alert" role="alert">{children}</div>;
}

function AuthPageShell({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="auth-main">
      <div className="auth-grid">
        <div className="auth-copy">
          <span className="eyebrow">{eyebrow}</span>
          <h1 className="mt-4 max-w-lg font-display text-4xl font-bold leading-tight tracking-[-0.055em] text-ink sm:text-5xl">{title}</h1>
          <p className="mt-5 max-w-md text-base leading-7 text-muted">{description}</p>
          <div className="auth-note mt-8">
            <span className="auth-note-mark" aria-hidden="true">s.</span>
            <p>Make space for the people and moments that matter.</p>
          </div>
        </div>
        <section className="surface-card auth-card" aria-label={title}>
          {children}
        </section>
      </div>
    </div>
  );
}

function AuthSubmit({ children, pending }: { children: string; pending: boolean }) {
  return (
    <button className="auth-submit" type="submit" disabled={pending}>
      {pending ? "Please wait…" : children}
    </button>
  );
}

export function SignupPage() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextErrors: FieldErrors = {};
    const trimmedName = displayName.trim();
    if (!trimmedName) nextErrors.displayName = "Enter your display name.";
    else if (trimmedName.length > 80) nextErrors.displayName = "Use no more than 80 characters.";
    const emailError = validateEmail(email.trim());
    if (emailError) nextErrors.email = emailError;
    const passwordError = validatePassword(password);
    if (passwordError) nextErrors.password = passwordError;
    if (confirmPassword !== password) nextErrors.confirmPassword = "Passwords do not match.";
    setFieldErrors(nextErrors);
    setServerError(null);
    if (Object.keys(nextErrors).length > 0) return;

    setPending(true);
    try {
      await register({ displayName: trimmedName, email: email.trim().toLowerCase(), password });
      navigate("/", { replace: true });
    } catch (error) {
      setServerError(requestErrorMessage(error, "We couldn’t create your account. Please try again."));
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthPageShell eyebrow="Join Senderi" title="A little more connected." description="Create an account to find your people, share what matters, and keep up with friends.">
      <div className="mb-6">
        <h2 className="font-display text-2xl font-bold tracking-[-0.04em] text-ink">Create your account</h2>
        <p className="mt-2 text-sm leading-6 text-muted">It only takes a moment to get started.</p>
      </div>
      <form className="space-y-4" onSubmit={handleSubmit} noValidate>
        {serverError && <FormAlert>{serverError}</FormAlert>}
        <Field id="signup-display-name" label="Display name" autoComplete="name" maxLength={80} value={displayName} onChange={(event) => setDisplayName(event.target.value)} error={fieldErrors.displayName} required />
        <Field id="signup-email" label="Email address" type="email" autoComplete="email" maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} error={fieldErrors.email} required />
        <Field id="signup-password" label="Password" type="password" autoComplete="new-password" minLength={12} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} error={fieldErrors.password} required />
        <p className="-mt-2 text-xs leading-5 text-muted">Use 12 to 128 characters. A long passphrase works well.</p>
        <Field id="signup-confirm-password" label="Confirm password" type="password" autoComplete="new-password" maxLength={128} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} error={fieldErrors.confirmPassword} required />
        <AuthSubmit pending={pending}>Create account</AuthSubmit>
      </form>
      <p className="auth-form-footer">Already have an account? <Link to="/login">Sign in</Link></p>
    </AuthPageShell>
  );
}

export function LoginPage() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextErrors: FieldErrors = {};
    const emailError = validateEmail(email.trim());
    if (emailError) nextErrors.email = emailError;
    if (!password) nextErrors.password = "Enter your password.";
    else if (password.length > 128) nextErrors.password = "Use no more than 128 characters.";
    setFieldErrors(nextErrors);
    setServerError(null);
    if (Object.keys(nextErrors).length > 0) return;

    setPending(true);
    try {
      await signIn({ email: email.trim().toLowerCase(), password });
      navigate("/", { replace: true });
    } catch (error) {
      setServerError(requestErrorMessage(error, "We couldn’t sign you in. Please try again."));
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthPageShell eyebrow="Welcome back" title="Your people are here." description="Sign in to return to your timeline and catch up with your friends.">
      <div className="mb-6">
        <h2 className="font-display text-2xl font-bold tracking-[-0.04em] text-ink">Sign in</h2>
        <p className="mt-2 text-sm leading-6 text-muted">Use the email and password for your Senderi account.</p>
      </div>
      <form className="space-y-4" onSubmit={handleSubmit} noValidate>
        {serverError && <FormAlert>{serverError}</FormAlert>}
        <Field id="login-email" label="Email address" type="email" autoComplete="email" maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} error={fieldErrors.email} required />
        <Field id="login-password" label="Password" type="password" autoComplete="current-password" maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} error={fieldErrors.password} required />
        <div className="flex justify-end">
          <Link className="text-sm font-semibold text-violet hover:text-violet-dark" to="/forgot-password">Forgot password?</Link>
        </div>
        <AuthSubmit pending={pending}>Sign in</AuthSubmit>
      </form>
      <p className="auth-form-footer">New to Senderi? <Link to="/signup">Create an account</Link></p>
    </AuthPageShell>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState<string | undefined>();
  const [serverError, setServerError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const validationError = validateEmail(email.trim());
    setEmailError(validationError);
    setServerError(null);
    if (validationError) return;

    setPending(true);
    try {
      await apiFetch<{ message: string }>("/api/auth/forgot-password", {
        method: "POST",
        body: { email: email.trim().toLowerCase() },
      });
      setSent(true);
    } catch (error) {
      setServerError(requestErrorMessage(error, "We couldn’t process that request. Please try again."));
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthPageShell eyebrow="Account recovery" title="Let’s get you back in." description="Enter the email address you use for Senderi. If an account exists, we’ll send a reset link.">
      <div className="mb-6">
        <h2 className="font-display text-2xl font-bold tracking-[-0.04em] text-ink">Forgot your password?</h2>
        <p className="mt-2 text-sm leading-6 text-muted">We’ll send a link if we find an account for that address.</p>
      </div>
      {sent ? (
        <div className="success-panel" role="status">
          <span className="success-mark" aria-hidden="true">✓</span>
          <div>
            <h3 className="font-semibold text-ink">Check your inbox</h3>
            <p className="mt-1 text-sm leading-6 text-muted">If an account exists for this email, a password reset link will be sent.</p>
          </div>
        </div>
      ) : (
        <form className="space-y-4" onSubmit={handleSubmit} noValidate>
          {serverError && <FormAlert>{serverError}</FormAlert>}
          <Field id="forgot-email" label="Email address" type="email" autoComplete="email" maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} error={emailError} required />
          <AuthSubmit pending={pending}>Send reset link</AuthSubmit>
        </form>
      )}
      <p className="auth-form-footer"><Link to="/login">Back to sign in</Link></p>
    </AuthPageShell>
  );
}

export function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token")?.trim() ?? "";
  const { refreshUser } = useAuth();
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [invalidToken, setInvalidToken] = useState(false);
  const [complete, setComplete] = useState(false);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextErrors: FieldErrors = {};
    const passwordError = validatePassword(password);
    if (passwordError) nextErrors.password = passwordError;
    if (confirmPassword !== password) nextErrors.confirmPassword = "Passwords do not match.";
    setFieldErrors(nextErrors);
    setServerError(null);
    setInvalidToken(false);
    if (!token) {
      setInvalidToken(true);
      return;
    }
    if (Object.keys(nextErrors).length > 0) return;

    setPending(true);
    try {
      await apiFetch<void>("/api/auth/reset-password", {
        method: "POST",
        body: { token, newPassword: password },
      });
      await refreshUser();
      setComplete(true);
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.code === "invalid_reset_token" || error.code === "validation_error")
      ) {
        setInvalidToken(true);
      } else {
        setServerError(requestErrorMessage(error, "We couldn’t reset your password. Please try again."));
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthPageShell eyebrow="Account recovery" title="Choose a new password." description="Reset links can only be used once and expire after 15 minutes. Choose a fresh password for your account.">
      {complete ? (
        <div className="text-center">
          <span className="success-mark mx-auto" aria-hidden="true">✓</span>
          <h2 className="mt-4 font-display text-2xl font-bold tracking-[-0.04em] text-ink">Password updated</h2>
          <p className="mt-2 text-sm leading-6 text-muted">Your password has been changed. Sign in with your new password.</p>
          <button className="auth-submit mt-6" type="button" onClick={() => navigate("/login", { replace: true })}>Continue to sign in</button>
        </div>
      ) : invalidToken || !token ? (
        <div>
          <h2 className="font-display text-2xl font-bold tracking-[-0.04em] text-ink">This link can’t be used</h2>
          <p className="mt-2 text-sm leading-6 text-muted">The reset link is invalid, expired, or already used. Request a new link to continue.</p>
          <Link className="auth-submit mt-6" to="/forgot-password">Request a new reset link</Link>
        </div>
      ) : (
        <>
          <div className="mb-6">
            <h2 className="font-display text-2xl font-bold tracking-[-0.04em] text-ink">Set a new password</h2>
            <p className="mt-2 text-sm leading-6 text-muted">Use at least 12 characters.</p>
          </div>
          <form className="space-y-4" onSubmit={handleSubmit} noValidate>
            {serverError && <FormAlert>{serverError}</FormAlert>}
            <Field id="reset-password" label="New password" type="password" autoComplete="new-password" minLength={12} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} error={fieldErrors.password} required />
            <Field id="reset-confirm-password" label="Confirm new password" type="password" autoComplete="new-password" maxLength={128} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} error={fieldErrors.confirmPassword} required />
            <AuthSubmit pending={pending}>Update password</AuthSubmit>
          </form>
        </>
      )}
    </AuthPageShell>
  );
}
