import { v2 as cloudinary } from "cloudinary";

export interface UploadedProfileAsset {
  assetId: string;
}

export interface ProfileImageStorage {
  upload(buffer: Buffer, publicId: string): Promise<UploadedProfileAsset>;
  destroy(assetId: string): Promise<void>;
}

function getConfiguredCloudinary() {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME?.trim();
  const apiKey = process.env.CLOUDINARY_API_KEY?.trim();
  const apiSecret = process.env.CLOUDINARY_API_SECRET?.trim();

  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error("Cloudinary credentials are required for profile image uploads.");
  }

  cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret });
  return cloudinary;
}

function uploadBuffer(buffer: Buffer, publicId: string): Promise<UploadedProfileAsset> {
  const configured = getConfiguredCloudinary();

  return new Promise((resolve, reject) => {
    const stream = configured.uploader.upload_stream(
      {
        folder: "senderi/profiles",
        public_id: publicId,
        resource_type: "image",
        type: "upload",
        overwrite: false,
        unique_filename: false,
      },
      (error, result) => {
        if (error || !result?.public_id) {
          reject(error ?? new Error("Cloudinary did not return an asset ID."));
          return;
        }
        resolve({ assetId: result.public_id });
      },
    );

    stream.end(buffer);
  });
}

async function destroyAsset(assetId: string): Promise<void> {
  const configured = getConfiguredCloudinary();
  await configured.uploader.destroy(assetId, { resource_type: "image", type: "upload" });
}

export const cloudinaryProfileImageStorage: ProfileImageStorage = {
  upload: uploadBuffer,
  destroy: destroyAsset,
};
