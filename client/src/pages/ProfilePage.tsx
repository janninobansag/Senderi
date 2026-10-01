import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { ApiError, apiFetch } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { LoadingState, RequestErrorState } from "../components/AsyncState";
import type { ProfileResponse, User } from "../../../shared";

type Profile = User;

type FormValues = {
  displayName: string;
  bio: string;
  location: string;
  website: string;
};

function formFromProfile(profile: Profile): FormValues {
  return {
    displayName: profile.displayName,
    bio: profile.bio,
    location: profile.info.location ?? "",
    website: profile.info.website ?? "",
  };
}

function validateForm(values: FormValues): string | null {
  if (!values.displayName.trim()) return "Display name is required.";
  if (values.displayName.trim().length > 80) return "Display name must be 80 characters or fewer.";
  if (values.bio.length > 500) return "Bio must be 500 characters or fewer.";
  if (values.location.length > 120) return "Location must be 120 characters or fewer.";
  if (values.website && !/^https:\/\//i.test(values.website.trim())) return "Website must use HTTPS.";
  if (values.website.length > 2_048) return "Website must be 2,048 characters or fewer.";
  return null;
}

function ProfileAvatar({ imageUrl, displayName }: { imageUrl?: string; displayName: string }) {
  const [failedImageUrl, setFailedImageUrl] = useState<string | null>(null);
  const initial = displayName.trim().charAt(0).toUpperCase();

  return (
    <div className="profile-avatar" role="img" aria-label={`${displayName}'s profile photo`}>
      {imageUrl && failedImageUrl !== imageUrl ? (
        <img
          className="profile-avatar-image"
          src={imageUrl}
          alt=""
          onError={() => setFailedImageUrl(imageUrl)}
        />
      ) : (
        <span aria-hidden="true">{initial}</span>
      )}
    </div>
  );
}

function ProfileCover({ imageUrl, displayName }: { imageUrl?: string; displayName: string }) {
  const [failedImageUrl, setFailedImageUrl] = useState<string | null>(null);

  if (!imageUrl || failedImageUrl === imageUrl) return null;

  return (
    <img
      className="profile-cover-image"
      src={imageUrl}
      alt={`${displayName}'s cover photo`}
      onError={() => setFailedImageUrl(imageUrl)}
    />
  );
}

function friendshipLabel(status: ProfileResponse["friendshipStatus"]): string {
  switch (status) {
    case "self": return "This is you";
    case "friends": return "Friends";
    case "none": return "Not friends";
  }
}

export function ProfilePage() {
  const { user: currentUser, refreshUser } = useAuth();
  const { userId } = useParams();
  const profileId = userId ?? currentUser?.id;
  const [profile, setProfile] = useState<ProfileResponse | null>(null);
  const [form, setForm] = useState<FormValues | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!profileId) return;
    let active = true;
    setIsLoading(true);
    setError(null);
    setSaveMessage(null);

    apiFetch<ProfileResponse>(`/api/users/${profileId}`)
      .then((response) => {
        if (!active) return;
        setProfile(response);
        setForm(formFromProfile(response.user));
      })
      .catch((requestError: unknown) => {
        if (!active) return;
        setError(requestError instanceof ApiError ? requestError.message : "We couldn’t load this profile.");
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [profileId]);

  const isOwner = Boolean(profile && currentUser && profile.user.id === currentUser.id);
  const memberSince = useMemo(() => {
    if (!profile) return "";
    return new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(new Date(profile.user.createdAt));
  }, [profile]);

  function updateField(field: keyof FormValues, value: string) {
    setForm((current) => current ? { ...current, [field]: value } : current);
    setSaveMessage(null);
  }

  async function saveProfile(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form || !profile) return;
    const validationError = validateForm(form);
    if (validationError) {
      setSaveMessage(validationError);
      return;
    }

    setIsSaving(true);
    setSaveMessage(null);
    try {
      const response = await apiFetch<{ user: Profile & { email?: string } }>("/api/users/me", {
        method: "PATCH",
        body: {
          displayName: form.displayName,
          bio: form.bio,
          info: { location: form.location, website: form.website },
        },
      });
      setProfile((current) => current ? { ...current, user: response.user } : current);
      setForm(formFromProfile(response.user));
      setSaveMessage("Profile saved.");
      await refreshUser();
    } catch (requestError: unknown) {
      setSaveMessage(requestError instanceof ApiError ? requestError.message : "We couldn’t save your profile.");
    } finally {
      setIsSaving(false);
    }
  }

  if (!profileId) return <RequestErrorState title="Profile unavailable" message="Sign in to view your profile." />;
  if (isLoading) return <LoadingState message="Loading profile..." />;
  if (error || !profile || !form) return <RequestErrorState title="Unable to load profile" message={error ?? "Please try again."} />;

  return (
    <div className="space-y-5">
      <section className="profile-cover">
        <ProfileCover imageUrl={profile.user.coverUrl} displayName={profile.user.displayName} />
        <ProfileAvatar imageUrl={profile.user.avatarUrl} displayName={profile.user.displayName} />
      </section>

      <section className="surface-card -mt-12 p-6 pt-16 sm:p-8 sm:pt-16">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <span className="eyebrow">{isOwner ? "Your profile" : "Senderi profile"}</span>
            <h1 className="mt-3 text-3xl font-bold tracking-[-0.04em] text-ink">{profile.user.displayName}</h1>
            <p className="mt-2 text-sm text-muted">Member since {memberSince}</p>
          </div>
          <span className="profile-status" aria-label={`Friendship status: ${friendshipLabel(profile.friendshipStatus)}`}>
            {friendshipLabel(profile.friendshipStatus)}
          </span>
        </div>

        <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.65fr)]">
          <div>
            <h2 className="text-sm font-bold uppercase tracking-[0.12em] text-muted">About</h2>
            <p className="mt-3 whitespace-pre-wrap leading-7 text-ink/80">{profile.user.bio || "No bio yet."}</p>
          </div>
          <dl className="profile-info">
            <div><dt>Location</dt><dd>{profile.user.info.location || "Not shared"}</dd></div>
            <div><dt>Website</dt><dd>{profile.user.info.website ? <a href={profile.user.info.website} target="_blank" rel="noreferrer">{profile.user.info.website}</a> : "Not shared"}</dd></div>
          </dl>
        </div>
      </section>

      {isOwner && (
        <section className="surface-card p-6 sm:p-8">
          <div className="mb-6"><span className="eyebrow">Edit profile</span><h2 className="mt-2 text-2xl font-bold tracking-[-0.03em] text-ink">Keep it current.</h2></div>
          <form className="grid gap-5" onSubmit={saveProfile}>
            <label className="profile-field">Display name<input value={form.displayName} onChange={(event) => updateField("displayName", event.target.value)} maxLength={80} /></label>
            <label className="profile-field">Bio<textarea value={form.bio} onChange={(event) => updateField("bio", event.target.value)} maxLength={500} rows={4} /><span>{form.bio.length}/500</span></label>
            <div className="grid gap-5 sm:grid-cols-2">
              <label className="profile-field">Location<input value={form.location} onChange={(event) => updateField("location", event.target.value)} maxLength={120} /></label>
              <label className="profile-field">Website<input value={form.website} onChange={(event) => updateField("website", event.target.value)} placeholder="https://example.com" maxLength={2_048} /></label>
            </div>
            {saveMessage && <p className={saveMessage === "Profile saved." ? "form-success" : "form-error"} role={saveMessage === "Profile saved." ? "status" : "alert"}>{saveMessage}</p>}
            <div><button className="button-accent" type="submit" disabled={isSaving}>{isSaving ? "Saving..." : "Save changes"}</button></div>
          </form>
        </section>
      )}
    </div>
  );
}
