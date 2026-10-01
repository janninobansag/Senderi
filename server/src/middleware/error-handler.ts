import type { ErrorRequestHandler } from "express";
import multer from "multer";
import { HttpError } from "../errors/http-error";

type BodyParserError = Error & {
  status?: number;
  type?: string;
};

function isMalformedJsonError(error: unknown): error is BodyParserError {
  return (
    error instanceof Error &&
    "type" in error &&
    error.type === "entity.parse.failed"
  );
}

export const errorHandler: ErrorRequestHandler = (error, _request, response, next) => {
  if (response.headersSent) {
    next(error);
    return;
  }

  if (isMalformedJsonError(error)) {
    response.status(400).json({
      error: {
        code: "invalid_json",
        message: "Request body must contain valid JSON.",
      },
    });
    return;
  }

  if (error instanceof multer.MulterError) {
    const tooLarge = error.code === "LIMIT_FILE_SIZE";
    response.status(tooLarge ? 413 : 400).json({
      error: {
        code: tooLarge ? "file_too_large" : "invalid_multipart",
        message: tooLarge ? "Profile images must be 5 MB or smaller." : "Invalid image upload.",
      },
    });
    return;
  }

  if (
    error instanceof Error &&
    "type" in error &&
    error.type === "entity.too.large"
  ) {
    response.status(413).json({
      error: {
        code: "payload_too_large",
        message: "Request body exceeds the allowed size.",
      },
    });
    return;
  }

  if (error instanceof HttpError) {
    response.status(error.statusCode).json({
      error: {
        code: error.code,
        message: error.message,
      },
    });
    return;
  }

  console.error("Unhandled request error", error);
  response.status(500).json({
    error: {
      code: "internal_error",
      message: "An unexpected error occurred.",
    },
  });
};
