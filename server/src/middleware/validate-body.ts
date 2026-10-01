import type { RequestHandler } from "express";
import type { ZodType } from "zod";
import { HttpError } from "../errors/http-error";

export function validateBody(schema: ZodType): RequestHandler {
  return (request, _response, next) => {
    const result = schema.safeParse(request.body);

    if (!result.success) {
      next(new HttpError(400, "validation_error", "Request body is invalid."));
      return;
    }

    request.body = result.data;
    next();
  };
}
