export type ApiErrorBody = {
  error: {
    code: string;
    message: string;
  };
};

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
    public readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type ApiRequestInit = Omit<RequestInit, "body"> & {
  body?: unknown;
};

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (!value || typeof value !== "object" || !("error" in value)) {
    return false;
  }

  const error = value.error;
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "message" in error &&
    typeof error.code === "string" &&
    typeof error.message === "string"
  );
}

export async function apiFetch<T>(path: string, options: ApiRequestInit = {}): Promise<T> {
  const { body, headers, ...requestInit } = options;
  const requestHeaders = new Headers(headers);
  requestHeaders.set("Accept", "application/json");

  if (body !== undefined && !(body instanceof FormData)) {
    requestHeaders.set("Content-Type", "application/json");
  }

  const response = await fetch(path, {
    ...requestInit,
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    credentials: "include",
    headers: requestHeaders,
  });

  const contentType = response.headers.get("content-type") ?? "";
  const responseBody: unknown = contentType.includes("application/json")
    ? await response.json()
    : undefined;

  if (!response.ok) {
    const retryAfterHeader = response.headers.get("Retry-After");
    const retryAfterSeconds = retryAfterHeader && /^\d+$/.test(retryAfterHeader)
      ? Number(retryAfterHeader)
      : null;
    if (isApiErrorBody(responseBody)) {
      throw new ApiError(responseBody.error.message, response.status, responseBody.error.code, retryAfterSeconds);
    }

    throw new ApiError("The request could not be completed.", response.status, "request_failed", retryAfterSeconds);
  }

  return responseBody as T;
}

export async function apiUpload<T>(
  path: string,
  body: FormData,
  onProgress?: (percent: number) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", path);
    request.withCredentials = true;
    request.setRequestHeader("Accept", "application/json");
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress?.(Math.round((event.loaded / event.total) * 100));
    });
    request.addEventListener("error", () => reject(new ApiError("The request could not be completed.", 0, "request_failed")));
    request.addEventListener("load", () => {
      let responseBody: unknown;
      try {
        responseBody = request.responseText ? JSON.parse(request.responseText) : undefined;
      } catch {
        responseBody = undefined;
      }
      if (request.status >= 200 && request.status < 300) {
        resolve(responseBody as T);
        return;
      }
      if (isApiErrorBody(responseBody)) {
        reject(new ApiError(responseBody.error.message, request.status, responseBody.error.code));
        return;
      }
      reject(new ApiError("The request could not be completed.", request.status, "request_failed"));
    });
    request.send(body);
  });
}
