import type { RequestHandler } from "express";
import { HttpError } from "../errors/http-error";

export const notFoundHandler: RequestHandler = (_request, _response, next) => {
  next(
    new HttpError(
      404,
      "not_found",
      "Requested resource was not found.",
    ),
  );
};
