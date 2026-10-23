import { useEffect, useMemo, useRef, useState } from "react";

type ProfileImageKind = "avatar" | "cover";

interface CropPoint {
  x: number;
  y: number;
}

interface CropSize {
  width: number;
  height: number;
}

interface CropGeometry {
  left: number;
  top: number;
  width: number;
  height: number;
  scale: number;
}

interface DragStart {
  pointerId: number;
  pointerX: number;
  pointerY: number;
  center: CropPoint;
  imageWidth: number;
  imageHeight: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function ProfileImageCropDialog({
  file,
  imageUrl,
  kind,
  onCancel,
  onCrop,
}: {
  file?: File;
  imageUrl?: string;
  kind: ProfileImageKind;
  onCancel: () => void;
  onCrop: (croppedFile: File) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const dragStartRef = useRef<DragStart | null>(null);
  const [imageSource, setImageSource] = useState<string | null>(null);
  const [imageSize, setImageSize] = useState<CropSize | null>(null);
  const [frameSize, setFrameSize] = useState<CropSize>({ width: 0, height: 0 });
  const [center, setCenter] = useState<CropPoint>({ x: 0.5, y: 0.5 });
  const [zoom, setZoom] = useState(1);
  const [isCropping, setIsCropping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!file && !imageUrl) return;
    const source = file ? URL.createObjectURL(file) : imageUrl!;
    setImageSource(source);
    setImageSize(null);
    setFrameSize({ width: 0, height: 0 });
    setCenter({ x: 0.5, y: 0.5 });
    setZoom(1);
    setError(null);
    return () => {
      if (file) URL.revokeObjectURL(source);
    };
  }, [file, imageUrl]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const measure = () => setFrameSize({ width: frame.clientWidth, height: frame.clientHeight });
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    measure();
    return () => observer.disconnect();
  }, [kind]);

  const geometry = useMemo<CropGeometry | null>(() => {
    if (!imageSize || frameSize.width <= 0 || frameSize.height <= 0) return null;
    const baseScale = Math.max(frameSize.width / imageSize.width, frameSize.height / imageSize.height);
    const scale = baseScale * zoom;
    const width = imageSize.width * scale;
    const height = imageSize.height * scale;
    return {
      left: clamp(frameSize.width / 2 - center.x * width, frameSize.width - width, 0),
      top: clamp(frameSize.height / 2 - center.y * height, frameSize.height - height, 0),
      width,
      height,
      scale,
    };
  }, [center, frameSize, imageSize, zoom]);

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (!geometry) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStartRef.current = {
      pointerId: event.pointerId,
      pointerX: event.clientX,
      pointerY: event.clientY,
      center,
      imageWidth: geometry.width,
      imageHeight: geometry.height,
    };
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragStartRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - drag.pointerX;
    const deltaY = event.clientY - drag.pointerY;
    const minCenterX = frameSize.width / (2 * drag.imageWidth);
    const minCenterY = frameSize.height / (2 * drag.imageHeight);
    setCenter({
      x: clamp(drag.center.x - deltaX / drag.imageWidth, minCenterX, 1 - minCenterX),
      y: clamp(drag.center.y - deltaY / drag.imageHeight, minCenterY, 1 - minCenterY),
    });
  }

  function handlePointerEnd(event: React.PointerEvent<HTMLDivElement>) {
    if (dragStartRef.current?.pointerId !== event.pointerId) return;
    dragStartRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  async function applyCrop() {
    const image = imageRef.current;
    if (!image || !geometry || !imageSize || isCropping) return;
    setIsCropping(true);
    setError(null);
    try {
      const canvas = document.createElement("canvas");
      const outputSize = kind === "avatar" ? { width: 512, height: 512 } : { width: 1600, height: 480 };
      canvas.width = outputSize.width;
      canvas.height = outputSize.height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("This browser couldn’t prepare the cropped image.");

      const sourceX = clamp(-geometry.left / geometry.scale, 0, imageSize.width);
      const sourceY = clamp(-geometry.top / geometry.scale, 0, imageSize.height);
      const sourceWidth = Math.min(frameSize.width / geometry.scale, imageSize.width - sourceX);
      const sourceHeight = Math.min(frameSize.height / geometry.scale, imageSize.height - sourceY);
      context.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, outputSize.width, outputSize.height);

      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
      if (!blob) throw new Error("This browser couldn’t prepare the cropped image.");
      onCrop(new File([blob], `${kind}-crop.jpg`, { type: "image/jpeg", lastModified: Date.now() }));
    } catch (cropError: unknown) {
      setError(cropError instanceof Error ? cropError.message : "Couldn’t crop this image. Try another image.");
    } finally {
      setIsCropping(false);
    }
  }

  const title = kind === "avatar" ? "Crop profile picture" : "Crop cover photo";

  return (
    <dialog
      ref={dialogRef}
      className="profile-image-crop-dialog"
      aria-labelledby="profile-image-crop-title"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div className="profile-image-crop-header">
        <div>
          <span className="eyebrow">Profile image</span>
          <h2 id="profile-image-crop-title">{title}</h2>
        </div>
        <button className="icon-button" type="button" aria-label="Cancel crop" onClick={onCancel}>
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18" /></svg>
        </button>
      </div>
      <div className="profile-image-crop-body">
        <p className="profile-image-crop-help">Drag the image to reposition it. Use the slider to zoom.</p>
        <div
          ref={frameRef}
          className={`profile-image-crop-frame profile-image-crop-frame-${kind}`}
          style={{ aspectRatio: kind === "avatar" ? "1 / 1" : "10 / 3" }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
        >
          {imageSource && (
            <img
              ref={imageRef}
              src={imageSource}
              crossOrigin={file ? undefined : "anonymous"}
              alt="Crop preview"
              draggable={false}
              onLoad={(event) => {
                setImageSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight });
                setError(null);
              }}
              onError={() => setError("This image couldn’t be opened. Try another JPEG, PNG, or WebP image.")}
              style={geometry ? {
                left: geometry.left,
                top: geometry.top,
                width: geometry.width,
                height: geometry.height,
              } : undefined}
            />
          )}
          {!imageSize && !error && <span className="profile-image-crop-loading">Preparing image…</span>}
        </div>
        <label className="profile-image-crop-zoom">
          <span>Zoom</span>
          <input
            type="range"
            min="1"
            max="3"
            step="0.05"
            value={zoom}
            onChange={(event) => setZoom(Number(event.currentTarget.value))}
            disabled={!imageSize || isCropping}
          />
        </label>
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>
      <div className="profile-image-crop-footer">
        <button className="button-secondary" type="button" disabled={isCropping} onClick={onCancel}>Cancel</button>
        <button className="button-accent" type="button" disabled={!geometry || Boolean(error) || isCropping} onClick={() => void applyCrop()}>
          {isCropping ? "Cropping…" : "Use crop"}
        </button>
      </div>
    </dialog>
  );
}
