import { fileTypeFromBuffer } from "file-type";
import { HttpError } from "../errors/http-error";

export const PROFILE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const PROFILE_IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export async function validateProfileImage(file: { buffer: Buffer; size: number }): Promise<void> {
  if (file.size > PROFILE_IMAGE_MAX_BYTES) {
    throw new HttpError(413, "file_too_large", "Profile images must be 5 MB or smaller.");
  }

  const detected = await fileTypeFromBuffer(file.buffer);
  if (!detected || !PROFILE_IMAGE_MIME_TYPES.includes(detected.mime as (typeof PROFILE_IMAGE_MIME_TYPES)[number])) {
    throw new HttpError(400, "invalid_file_type", "Profile images must be JPEG, PNG, or WebP files.");
  }
}
