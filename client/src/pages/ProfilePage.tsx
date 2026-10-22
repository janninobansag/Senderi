import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { ApiError, apiFetch, apiUpload } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { RequestErrorState } from "../components/AsyncState";
import { ProfileSkeleton } from "../components/Skeletons";
import { PostList } from "../components/Posts";
import type { ProfileResponse, User } from "../../../shared";

type Profile = User;

type FormValues = {
  displayName: string;
  bio: string;
  location: string;
  website: string;
};

type ProfileImageKind = "avatar" | "cover";

type ImageUploadState = {
  kind: ProfileImageKind;
  status: "uploading" | "success" | "error";
  progress: number;
  message: string;
  previewUrl?: string;
};

const PROFILE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const PROFILE_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function profileImageLabel(kind: ProfileImageKind): string {
  return kind === "avatar" ? "profile photo" : "cover photo";
}

function ProfileImagePicker({
  kind,
  disabled,
  onSelect,
}: {
  kind: ProfileImageKind;
  disabled: boolean;
  onSelect: (kind: ProfileImageKind, file: File) => void;
}) {
  const imageLabel = profileImageLabel(kind);

  return (
    <label className={`profile-image-picker ${kind === "avatar" ? "profile-avatar-picker" : "profile-cover-picker"} ${disabled ? "profile-image-picker-disabled" : ""}`}>
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M4 7.5h3l1.5-2h7l1.5 2h3v11H4v-11Z" />
        <circle cx="12" cy="13" r="3.5" />
      </svg>
      <span className={kind === "avatar" ? "sr-only" : undefined}>Change {kind === "avatar" ? "profile photo" : "cover"}</span>
      <input
        className="sr-only"
        type="file"
        accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
        aria-label={`Choose a new ${imageLabel}`}
        disabled={disabled}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) onSelect(kind, file);
        }}
      />
    </label>
  );
}

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
  const [imageUpload, setImageUpload] = useState<ImageUploadState | null>(null);
  const uploadInProgress = useRef(false);

  useEffect(() => {
    const previewUrl = imageUpload?.previewUrl;
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [imageUpload?.previewUrl]);

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

  async function uploadProfileImage(kind: ProfileImageKind, file: File) {
    if (uploadInProgress.current) return;
    setSaveMessage(null);

    if (file.size > PROFILE_IMAGE_MAX_BYTES) {
      setImageUpload({ kind, status: "error", progress: 0, message: "Choose an image that is 5 MB or smaller." });
      return;
    }
    if (file.type && !PROFILE_IMAGE_TYPES.has(file.type)) {
      setImageUpload({ kind, status: "error", progress: 0, message: "Choose a JPEG, PNG, or WebP image." });
      return;
    }

    uploadInProgress.current = true;
    const previewUrl = URL.createObjectURL(file);
    setImageUpload({ kind, status: "uploading", progress: 0, message: "", previewUrl });

    try {
      const response = await apiUpload<{ user: User }>(
        `/api/users/me/${kind}`,
        file,
        (progress) => setImageUpload((current) =>
          current?.status === "uploading" && current.kind === kind
            ? { ...current, progress }
            : current,
        ),
      );
      setProfile((current) => current ? { ...current, user: { ...current.user, ...response.user } } : current);
      setImageUpload({
        kind,
        status: "success",
        progress: 100,
        message: `Your ${profileImageLabel(kind)} was updated.`,
      });
      await refreshUser();
    } catch (uploadError: unknown) {
      let message = "We couldn’t upload your image. Please try again.";
      if (uploadError instanceof ApiError) {
        if (uploadError.code === "file_too_large") message = "Choose an image that is 5 MB or smaller.";
        else if (uploadError.code === "invalid_file_type") message = "Choose a JPEG, PNG, or WebP image.";
        else if (uploadError.status === 401) message = "Your session has expired. Sign in again to update your profile image.";
        else message = uploadError.message;
      }
      setImageUpload({ kind, status: "error", progress: 0, message });
    } finally {
      uploadInProgress.current = false;
    }
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
  if (isLoading) return <ProfileSkeleton />;
  if (error || !profile || !form) return <RequestErrorState title="Unable to load profile" message={error ?? "Please try again."} />;

  return (
    <div className="space-y-5">
      <section className="profile-cover">
        <ProfileCover
          imageUrl={imageUpload?.status === "uploading" && imageUpload.kind === "cover"
            ? imageUpload.previewUrl
            : profile.user.coverUrl}
          displayName={profile.user.displayName}
        />
        <div className="profile-avatar-frame">
          <ProfileAvatar
            imageUrl={imageUpload?.status === "uploading" && imageUpload.kind === "avatar"
              ? imageUpload.previewUrl
              : profile.user.avatarUrl}
            displayName={profile.user.displayName}
          />
          {isOwner && <ProfileImagePicker kind="avatar" disabled={imageUpload?.status === "uploading"} onSelect={uploadProfileImage} />}
        </div>
        {isOwner && <ProfileImagePicker kind="cover" disabled={imageUpload?.status === "uploading"} onSelect={uploadProfileImage} />}
      </section>

      {isOwner && imageUpload && (
        <div className={`profile-image-feedback profile-image-feedback-${imageUpload.status}`} role={imageUpload.status === "error" ? "alert" : "status"}>
          {imageUpload.status === "uploading" ? (
            <>
              <span>Uploading your {profileImageLabel(imageUpload.kind)}… {imageUpload.progress}%</span>
              <progress value={imageUpload.progress} max={100} aria-label={`Uploading ${profileImageLabel(imageUpload.kind)}`} />
            </>
          ) : (
            <span>{imageUpload.message}</span>
          )}
        </div>
      )}

      <section className="surface-card -mt-4 p-6 pt-16 sm:p-8 sm:pt-16">
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

      <section className="surface-card space-y-5 p-6 sm:p-8">
        <div>
          <span className="eyebrow">Posts</span>
          <h2 className="mt-2 text-2xl font-bold tracking-[-0.03em] text-ink">{isOwner ? "Your timeline" : `${profile.user.displayName}’s timeline`}</h2>
        </div>
        <PostList path={`/api/users/${profile.user.id}/posts`} />
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
