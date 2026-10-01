import express from "express";
import { errorHandler } from "./middleware/error-handler";
import { notFoundHandler } from "./middleware/not-found";
import { authRouter } from "./routes/auth";
import { healthRouter } from "./routes/health";
import { usersRouter } from "./routes/users";

export const app = express();

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use("/api/auth", authRouter);
app.use("/api/users", usersRouter);
app.use("/api/health", healthRouter);
app.use(notFoundHandler);
app.use(errorHandler);
