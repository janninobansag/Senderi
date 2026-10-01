import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { z } from "zod";
import { app } from "../src/app";
import { errorHandler } from "../src/middleware/error-handler";
import { notFoundHandler } from "../src/middleware/not-found";
import { validateBody } from "../src/middleware/validate-body";

test("GET /api/health returns the documented status", async () => {
  const response = await request(app).get("/api/health");

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { status: "ok" });
});

test("malformed JSON uses the shared error envelope", async () => {
  const response = await request(app)
    .post("/api/health")
    .set("Content-Type", "application/json")
    .send('{"unfinished":');

  assert.equal(response.status, 400);
  assert.deepEqual(response.body, {
    error: {
      code: "invalid_json",
      message: "Request body must contain valid JSON.",
    },
  });
});

test("body validation uses the shared error envelope", async () => {
  const validationApp = express();
  validationApp.use(express.json());
  validationApp.post(
    "/test",
    validateBody(z.object({ displayName: z.string().min(1) })),
    (requestHandler, response) => response.json(requestHandler.body),
  );
  validationApp.use(notFoundHandler);
  validationApp.use(errorHandler);

  const response = await request(validationApp)
    .post("/test")
    .send({ displayName: "" });

  assert.equal(response.status, 400);
  assert.deepEqual(response.body, {
    error: {
      code: "validation_error",
      message: "Request body is invalid.",
    },
  });
});

test("unknown routes use the shared error envelope", async () => {
  const response = await request(app).get("/api/missing");

  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, "not_found");
});
