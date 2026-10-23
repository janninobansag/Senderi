import type { RequestHandler } from "express";
import { ObjectId } from "mongodb";
import type { AuthenticatedSessionContext } from "./session";
import { HttpError } from "../errors/http-error";

export function isAdminId(userId: ObjectId): boolean {
  const ids = (process.env.ADMIN_USER_IDS ?? "").split(",").map((value) => value.trim());
  if (ids.length === 0 || ids.some((id) => !/^[a-f\d]{24}$/i.test(id))) return false;
  return ids.some((id) => id.toLowerCase() === userId.toHexString());
}

export const requireAdmin: RequestHandler = (_request, response, next) => {
  const context = response.locals.authenticatedSession as AuthenticatedSessionContext | undefined;
  if (!context || !isAdminId(context.user._id)) {
    next(new HttpError(403, "forbidden", "Admin access is required."));
    return;
  }
  next();
};
