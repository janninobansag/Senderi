import type { RequestHandler } from "express";
import { HttpError } from "../errors/http-error";

export function requireClientOrigin(
  getAllowedOrigins: () => readonly string[] = () =>
    (process.env.CLIENT_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
): RequestHandler {
  return (request, _response, next) => {
    const origin = request.get("Origin");

    if (!origin || !getAllowedOrigins().includes(origin)) {
      next(new HttpError(403, "origin_not_allowed", "This request origin is not allowed."));
      return;
    }

    next();
  };
}
