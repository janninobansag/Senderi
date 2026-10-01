import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { ApiError, apiFetch, apiUpload } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { LoadingState, RequestErrorState } from "../components/AsyncState";

type Profile = {
  id: string;
  displayName: string;
  bio: string;
  info: { location?: string; website?: string };
  avatarId?: string;
  coverId?: string;
  createdAt: string;
};

type ProfileResponse = {
  user: Profile;
  friendshipStatus: "self" | "none";
};

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

function profileImageUrl(assetId: string | undefined): string | undefined {
  const cloudName = import.meta.env.VITE_CLOUDINARY_CLOUD_NAME?.trim();
  return assetId && cloudName ? `https://res.cloudinary.com/${cloudName}/image/upload/f_auto,q_auto/${assetId}` : undefined;
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
  const [uploading, setUploading] = useState<"avatar" | "cover" | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [previews, setPreviews] = useState<{ avatar?: string; cover?: string }>({});
  const [uploadMessage, setUploadMessage] = useState<string | null>(null);
  const avatarInput = useRef<HTMLInputElement>(null);
  const coverInput = useRef<HTMLInputElement>(null);

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

  async function uploadImage(kind: "avatar" | "cover", file: File) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
      setUploadMessage("Choose a JPEG, PNG, or WebP image.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setUploadMessage("Profile images must be 5 MB or smaller.");
      return;
    }
    setUploading(kind);
    setUploadProgress(0);
    setUploadMessage(null);
    const body = new FormData();
    body.append("file", file);
    try {
      const response = await apiUpload<{ user: Profile }>(`/api/users/me/${kind}`, body, setUploadProgress);
      setProfile((current) => current ? { ...current, user: response.user } : current);
      setPreviews((current) => ({ ...current, [kind]: undefined }));
      setUploadMessage(`${kind === "avatar" ? "Profile photo" : "Cover photo"} updated.`);
      await refreshUser();
    } catch (requestError: unknown) {
      setUploadMessage(requestError instanceof ApiError ? requestError.message : "We couldn’t upload that image.");
    } finally {
      setUploading(null);
      setUploadProgress(0);
      if (kind === "avatar" && avatarInput.current) avatarInput.current.value = "";
      if (kind === "cover" && coverInput.current) coverInput.current.value = "";
    }
  }

  function chooseImage(kind: "avatar" | "cover", file: File | undefined) {
    if (!file) return;
    const preview = URL.createObjectURL(file);
    setPreviews((current) => {
      const previous = current[kind];
      if (previous) URL.revokeObjectURL(previous);
      return { ...current, [kind]: preview };
    });
    void uploadImage(kind, file);
  }

  if (!profileId) return <RequestErrorState title="Profile unavailable" message="Sign in to view your profile." />;
  if (isLoading) return <LoadingState message="Loading profile..." />;
  if (error || !profile || !form) return <RequestErrorState title="Unable to load profile" message={error ?? "Please try again."} />;

  return (
    <div className="space-y-5">
      <section className="profile-cover">
        {(previews.cover ?? profileImageUrl(profile.user.coverId)) && <img className="profile-cover-image" src={previews.cover ?? profileImageUrl(profile.user.coverId)} alt="" />}
        <div className="profile-avatar">
          {previews.avatar ?? profileImageUrl(profile.user.avatarId) ? <img src={previews.avatar ?? profileImageUrl(profile.user.avatarId)} alt={`${profile.user.displayName} profile`} /> : profile.user.displayName.trim().charAt(0).toUpperCase()}
        </div>
      </section>

      <section className="surface-card -mt-12 p-6 pt-16 sm:p-8 sm:pt-16">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <span className="eyebrow">{isOwner ? "Your profile" : "Senderi profile"}</span>
            <h1 className="mt-3 text-3xl font-bold tracking-[-0.04em] text-ink">{profile.user.displayName}</h1>
            <p className="mt-2 text-sm text-muted">Member since {memberSince}</p>
          </div>
          <span className="profile-status">{profile.friendshipStatus === "self" ? "This is you" : "Senderi member"}</span>
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
          <div className="profile-image-controls">
            <div><span className="eyebrow">Profile images</span><p className="mt-2 text-sm leading-6 text-muted">JPEG, PNG, or WebP up to 5 MB.</p></div>
            <div className="flex flex-wrap gap-3">
              <input ref={avatarInput} className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => chooseImage("avatar", event.target.files?.[0])} />
              <input ref={coverInput} className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => chooseImage("cover", event.target.files?.[0])} />
              <button className="button-outline" type="button" onClick={() => avatarInput.current?.click()} disabled={uploading !== null}>{uploading === "avatar" ? "Uploading..." : "Change profile photo"}</button>
              <button className="button-outline" type="button" onClick={() => coverInput.current?.click()} disabled={uploading !== null}>{uploading === "cover" ? "Uploading..." : "Change cover photo"}</button>
            </div>
            {uploading && <div aria-label={`Upload progress ${uploadProgress}%`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={uploadProgress} className="upload-progress"><span style={{ width: `${uploadProgress}%` }} /></div>}
            {uploadMessage && <p className={uploadMessage.endsWith("updated.") ? "form-success" : "form-error"} role="status">{uploadMessage}</p>}
          </div>
        </section>
      )}
    </div>
  );
}
