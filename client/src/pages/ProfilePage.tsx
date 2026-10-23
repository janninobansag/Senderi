import { useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { ApiError, apiFetch, apiUpload } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { RequestErrorState } from "../components/AsyncState";
import { ProfileSkeleton } from "../components/Skeletons";
import { PostList } from "../components/Posts";
import { ProfileFriends, ProfileImageViewer, ProfilePhotos } from "../components/ProfileCollections";
import { SupporterBadge } from "../components/SupporterBadge";
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
  inputRef,
  showTrigger = true,
}: {
  kind: ProfileImageKind;
  disabled: boolean;
  onSelect: (kind: ProfileImageKind, file: File) => void;
  inputRef?: RefObject<HTMLInputElement | null>;
  showTrigger?: boolean;
}) {
  const imageLabel = profileImageLabel(kind);
  const fileInput = (
    <input
      ref={inputRef}
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
  );

  if (!showTrigger) return fileInput;

  return (
    <label className={`profile-image-picker ${kind === "avatar" ? "profile-avatar-picker" : "profile-cover-picker"} ${disabled ? "profile-image-picker-disabled" : ""}`}>
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M4 7.5h3l1.5-2h7l1.5 2h3v11H4v-11Z" />
        <circle cx="12" cy="13" r="3.5" />
      </svg>
      <span className={kind === "avatar" ? "sr-only" : undefined}>Change {kind === "avatar" ? "profile photo" : "cover"}</span>
      {fileInput}
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
  const [searchParams, setSearchParams] = useSearchParams();
  const profileId = userId ?? currentUser?.id;
  const [profile, setProfile] = useState<ProfileResponse | null>(null);
  const [form, setForm] = useState<FormValues | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [isAvatarMenuOpen, setIsAvatarMenuOpen] = useState(false);
  const [isAvatarViewerOpen, setIsAvatarViewerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [imageUpload, setImageUpload] = useState<ImageUploadState | null>(null);
  const editorDialogRef = useRef<HTMLDialogElement>(null);
  const avatarFrameRef = useRef<HTMLDivElement>(null);
  const avatarTriggerRef = useRef<HTMLButtonElement>(null);
  const avatarFileInputRef = useRef<HTMLInputElement>(null);
  const editorTitleId = useId();
  const profileTabId = useId();
  const uploadInProgress = useRef(false);

  useEffect(() => {
    const dialog = editorDialogRef.current;
    if (!dialog) return;
    if (isEditorOpen && !dialog.open) dialog.showModal();
    if (!isEditorOpen && dialog.open) dialog.close();
  }, [isEditorOpen]);

  useEffect(() => {
    if (!isAvatarMenuOpen) return;

    function closeAvatarMenu(event: PointerEvent) {
      if (event.target instanceof Node && !avatarFrameRef.current?.contains(event.target)) {
        setIsAvatarMenuOpen(false);
      }
    }

    function handleAvatarMenuKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsAvatarMenuOpen(false);
        avatarTriggerRef.current?.focus();
      }
    }

    document.addEventListener("pointerdown", closeAvatarMenu);
    document.addEventListener("keydown", handleAvatarMenuKeyDown);
    return () => {
      document.removeEventListener("pointerdown", closeAvatarMenu);
      document.removeEventListener("keydown", handleAvatarMenuKeyDown);
    };
  }, [isAvatarMenuOpen]);

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
    setIsEditorOpen(false);
    setIsAvatarMenuOpen(false);
    setIsAvatarViewerOpen(false);
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
  const requestedTab = searchParams.get("tab");
  const activeTab = requestedTab === "photos" ? "photos" : requestedTab === "friends" && isOwner ? "friends" : "posts";
  const memberSince = useMemo(() => {
    if (!profile) return "";
    return new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(new Date(profile.user.createdAt));
  }, [profile]);

  function updateField(field: keyof FormValues, value: string) {
    setForm((current) => current ? { ...current, [field]: value } : current);
    setSaveMessage(null);
  }

  function openEditor() {
    if (!profile) return;
    setForm(formFromProfile(profile.user));
    setSaveMessage(null);
    setIsEditorOpen(true);
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
      setIsEditorOpen(false);
    } catch (requestError: unknown) {
      setSaveMessage(requestError instanceof ApiError ? requestError.message : "We couldn’t save your profile.");
    } finally {
      setIsSaving(false);
    }
  }

  if (!profileId) return <RequestErrorState title="Profile unavailable" message="Sign in to view your profile." />;
  if (isLoading) return <ProfileSkeleton />;
  if (error || !profile || !form) return <RequestErrorState title="Unable to load profile" message={error ?? "Please try again."} />;

  const avatarImageUrl = imageUpload?.status === "uploading" && imageUpload.kind === "avatar"
    ? imageUpload.previewUrl
    : profile.user.avatarUrl;

  return (
    <div className="profile-page space-y-5">
      <section className="profile-cover">
        <ProfileCover
          imageUrl={imageUpload?.status === "uploading" && imageUpload.kind === "cover"
            ? imageUpload.previewUrl
            : profile.user.coverUrl}
          displayName={profile.user.displayName}
        />
        <div className="profile-avatar-frame" ref={avatarFrameRef}>
          <button
            ref={avatarTriggerRef}
            className="profile-avatar-trigger"
            type="button"
            aria-label="Profile picture options"
            aria-haspopup="menu"
            aria-expanded={isAvatarMenuOpen}
            aria-controls="profile-avatar-menu"
            onClick={() => setIsAvatarMenuOpen((open) => !open)}
          >
            <ProfileAvatar imageUrl={avatarImageUrl} displayName={profile.user.displayName} />
          </button>
          {isAvatarMenuOpen && (
            <div className="profile-avatar-menu" id="profile-avatar-menu" role="menu" aria-label="Profile picture options">
              <button
                type="button"
                role="menuitem"
                disabled={!avatarImageUrl}
                onClick={() => {
                  setIsAvatarMenuOpen(false);
                  setIsAvatarViewerOpen(true);
                }}
              >
                <svg aria-hidden="true" viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="17" height="17" rx="3" /><circle cx="12" cy="9" r="2.5" /><path d="M7.5 18c.8-2.2 2.3-3.3 4.5-3.3s3.7 1.1 4.5 3.3" /></svg>
                <span>See profile picture</span>
              </button>
              {isOwner && (
                <button
                  type="button"
                  role="menuitem"
                  disabled={imageUpload?.status === "uploading"}
                  onClick={() => {
                    setIsAvatarMenuOpen(false);
                    avatarFileInputRef.current?.click();
                  }}
                >
                  <svg aria-hidden="true" viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="17" height="17" rx="3" /><circle cx="8" cy="8" r="1.3" /><path d="m5 18 5-5 3 3 2.5-2.5L20 18" /></svg>
                  <span>Choose profile picture</span>
                </button>
              )}
            </div>
          )}
          {isOwner && <ProfileImagePicker kind="avatar" disabled={imageUpload?.status === "uploading"} onSelect={uploadProfileImage} inputRef={avatarFileInputRef} showTrigger={false} />}
          {isAvatarViewerOpen && avatarImageUrl && (
            <ProfileImageViewer
              image={{ label: "Profile photo", url: avatarImageUrl }}
              profile={profile.user}
              onClose={() => setIsAvatarViewerOpen(false)}
            />
          )}
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
            <h1 className="mt-3 text-3xl font-bold tracking-[-0.04em] text-ink">{profile.user.displayName} <SupporterBadge user={profile.user} /></h1>
            <p className="mt-2 text-sm text-muted">Member since {memberSince}</p>
          </div>
          {isOwner ? (
            <button className="profile-edit-button" type="button" onClick={openEditor} aria-haspopup="dialog">
              <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m15 5 4 4M4 20l4.5-1 10.7-10.7a2.1 2.1 0 0 0-3-3L5.5 16 4 20Z" /></svg>
              Edit profile
            </button>
          ) : (
            <span className="profile-status" aria-label={`Friendship status: ${friendshipLabel(profile.friendshipStatus)}`}>
              {friendshipLabel(profile.friendshipStatus)}
            </span>
          )}
        </div>

        {isOwner && saveMessage === "Profile saved." && <p className="form-success mt-4" role="status">{saveMessage}</p>}

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
        <div className="profile-tabs" role="tablist" aria-label="Profile sections">
          {(["posts", "photos", ...(isOwner ? ["friends"] : [])] as const).map((tab) => (
            <button
              id={`${profileTabId}-${tab}`}
              key={tab}
              type="button"
              role="tab"
              aria-selected={activeTab === tab}
              aria-controls={`${profileTabId}-panel`}
              className={activeTab === tab ? "profile-tab-active" : ""}
              onClick={() => setSearchParams(tab === "posts" ? {} : { tab })}
            >
              {tab === "posts" ? "Posts" : tab === "photos" ? "Photos" : "Friends"}
            </button>
          ))}
        </div>
      </section>

      <div id={`${profileTabId}-panel`} role="tabpanel" aria-labelledby={`${profileTabId}-${activeTab}`}>
        {activeTab === "posts" ? (
          <section className="space-y-4">
            <div className="px-1">
              <span className="eyebrow">Posts</span>
              <h2 className="mt-2 text-2xl font-bold tracking-[-0.03em] text-ink">{isOwner ? "Your timeline" : `${profile.user.displayName}’s timeline`}</h2>
            </div>
            <PostList path={`/api/users/${profile.user.id}/posts`} />
          </section>
        ) : activeTab === "photos" ? (
          <ProfilePhotos key={profile.user.id} profile={profile.user} />
        ) : (
          <ProfileFriends />
        )}
      </div>

      {isOwner && (
        <dialog
          ref={editorDialogRef}
          className="profile-edit-dialog"
          aria-labelledby={editorTitleId}
          onClose={() => setIsEditorOpen(false)}
          onClick={(event) => {
            if (event.target === event.currentTarget && !isSaving) setIsEditorOpen(false);
          }}
          onCancel={(event) => {
            if (isSaving) event.preventDefault();
          }}
        >
          <header className="profile-edit-dialog-header">
            <div><span className="eyebrow">Edit profile</span><h2 id={editorTitleId}>Keep it current.</h2></div>
            <button className="profile-edit-dialog-close" type="button" aria-label="Close edit profile" disabled={isSaving} onClick={() => setIsEditorOpen(false)}>
              <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M5 5 19 19M19 5 5 19" /></svg>
            </button>
          </header>
          <form className="profile-edit-form" onSubmit={saveProfile}>
            <div className="profile-edit-dialog-body">
              <label className="profile-field">Display name<input value={form.displayName} onChange={(event) => updateField("displayName", event.target.value)} maxLength={80} /></label>
              <label className="profile-field">Bio<textarea value={form.bio} onChange={(event) => updateField("bio", event.target.value)} maxLength={500} rows={4} /><span>{form.bio.length}/500</span></label>
              <div className="profile-edit-field-row">
                <label className="profile-field">Location<input value={form.location} onChange={(event) => updateField("location", event.target.value)} maxLength={120} /></label>
                <label className="profile-field">Website<input value={form.website} onChange={(event) => updateField("website", event.target.value)} placeholder="https://example.com" maxLength={2_048} /></label>
              </div>
              {saveMessage && saveMessage !== "Profile saved." && <p className="form-error" role="alert">{saveMessage}</p>}
            </div>
            <footer className="profile-edit-dialog-footer">
              <button className="button-secondary" type="button" disabled={isSaving} onClick={() => setIsEditorOpen(false)}>Cancel</button>
              <button className="button-accent" type="submit" disabled={isSaving}>{isSaving ? "Saving..." : "Save changes"}</button>
            </footer>
          </form>
        </dialog>
      )}
    </div>
  );
}
