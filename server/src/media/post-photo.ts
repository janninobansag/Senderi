import { v2 as cloudinary } from "cloudinary";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";
import { HttpError } from "../errors/http-error";

export const POST_PHOTO_MAX_BYTES = 5 * 1024 * 1024;
export const POST_PHOTO_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const POST_PHOTO_MAX_DIMENSION = 2048;
const POST_PHOTO_MAX_INPUT_PIXELS = 60_000_000;

export interface UploadedPostPhoto {
  /** Cloudinary public ID, used only by the server to retrieve the authenticated asset. */
  assetId: string;
}

export interface DownloadedPostPhoto {
  stream: Readable;
  contentType: (typeof POST_PHOTO_MIME_TYPES)[number];
  contentLength?: number;
}

export interface PostPhotoStorage {
  upload(buffer: Buffer, publicId: string, folder?: string): Promise<UploadedPostPhoto>;
  destroy(assetId: string): Promise<void>;
  download(assetId: string): Promise<DownloadedPostPhoto>;
}

export async function optimizePostPhoto(file: { buffer: Buffer; size: number }): Promise<Buffer> {
  if (file.size > POST_PHOTO_MAX_BYTES) {
    throw new HttpError(413, "file_too_large", "Images must be 5 MB or smaller.");
  }

  const detected = await fileTypeFromBuffer(file.buffer);
  if (!detected || !POST_PHOTO_MIME_TYPES.includes(detected.mime as (typeof POST_PHOTO_MIME_TYPES)[number])) {
    throw new HttpError(400, "invalid_file_type", "Images must be JPEG, PNG, or WebP files.");
  }

  try {
    const metadata = await sharp(file.buffer, { limitInputPixels: POST_PHOTO_MAX_INPUT_PIXELS }).metadata();

    // Keep animated WebP files intact; Sharp would otherwise process only their first frame.
    if (metadata.pages && metadata.pages > 1) return file.buffer;

    const optimized = await sharp(file.buffer, { limitInputPixels: POST_PHOTO_MAX_INPUT_PIXELS })
      .rotate()
      .resize({
        width: POST_PHOTO_MAX_DIMENSION,
        height: POST_PHOTO_MAX_DIMENSION,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: 82, effort: 4 })
      .toBuffer();

    // Avoid increasing storage for already-small or highly compressed images.
    return optimized.length < file.buffer.length ? optimized : file.buffer;
  } catch {
    throw new HttpError(400, "invalid_file_type", "Images must be valid JPEG, PNG, or WebP files.");
  }
}

function getConfiguredCloudinary() {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME?.trim();
  const apiKey = process.env.CLOUDINARY_API_KEY?.trim();
  const apiSecret = process.env.CLOUDINARY_API_SECRET?.trim();

  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error("Cloudinary credentials are required for private image storage.");
  }

  cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret });
  return cloudinary;
}

function uploadAuthenticatedImage(buffer: Buffer, publicId: string, folder = "senderi/posts"): Promise<UploadedPostPhoto> {
  const configured = getConfiguredCloudinary();

  return new Promise((resolve, reject) => {
    const stream = configured.uploader.upload_stream(
      {
        folder,
        public_id: publicId,
        resource_type: "image",
        type: "authenticated",
        overwrite: false,
        unique_filename: false,
      },
      (error, result) => {
        if (error || !result?.public_id) {
          reject(error ?? new Error("Cloudinary did not return a post photo ID."));
          return;
        }
        resolve({ assetId: result.public_id });
      },
    );

    stream.end(buffer);
  });
}

async function destroyAuthenticatedImage(assetId: string): Promise<void> {
  const configured = getConfiguredCloudinary();
  await configured.uploader.destroy(assetId, { resource_type: "image", type: "authenticated" });
}

async function downloadAuthenticatedImage(assetId: string): Promise<DownloadedPostPhoto> {
  const configured = getConfiguredCloudinary();
  const signedUrl = configured.url(assetId, {
    resource_type: "image",
    type: "authenticated",
    secure: true,
    sign_url: true,
  });
  const upstream = await fetch(signedUrl, { signal: AbortSignal.timeout(20_000) });

  if (!upstream.ok || !upstream.body) {
    throw new Error("Cloudinary could not return the authenticated post photo.");
  }

  const contentType = upstream.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (!contentType || !POST_PHOTO_MIME_TYPES.includes(contentType as (typeof POST_PHOTO_MIME_TYPES)[number])) {
    await upstream.body.cancel();
    throw new Error("Cloudinary returned an unsupported post photo format.");
  }

  const contentLengthHeader = upstream.headers.get("content-length");
  const contentLength = contentLengthHeader ? Number(contentLengthHeader) : undefined;
  if (contentLength !== undefined && (!Number.isSafeInteger(contentLength) || contentLength > POST_PHOTO_MAX_BYTES)) {
    await upstream.body.cancel();
    throw new Error("Cloudinary returned a post photo above the allowed size.");
  }

  return {
    stream: Readable.fromWeb(upstream.body as unknown as NodeReadableStream),
    contentType: contentType as (typeof POST_PHOTO_MIME_TYPES)[number],
    ...(contentLength !== undefined ? { contentLength } : {}),
  };
}

export const cloudinaryPostPhotoStorage: PostPhotoStorage = {
  upload: uploadAuthenticatedImage,
  destroy: destroyAuthenticatedImage,
  download: downloadAuthenticatedImage,
};
