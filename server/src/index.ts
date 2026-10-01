import "dotenv/config";
import { once } from "node:events";
import type { Server } from "node:http";
import { app } from "./app";
import { closeDatabase, connectToDatabase } from "./db/client";

function readPort(): number {
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }
  return port;
}

function readTrustedProxyHops(): number {
  const configured = process.env.TRUST_PROXY_HOPS;
  const hops = configured === undefined
    ? process.env.NODE_ENV === "production" ? 1 : 0
    : Number(configured);
  if (!Number.isInteger(hops) || hops < 0 || hops > 10) {
    throw new Error("TRUST_PROXY_HOPS must be an integer between 0 and 10.");
  }
  return hops;
}

async function startServer(): Promise<void> {
  const port = readPort();
  app.set("trust proxy", readTrustedProxyHops());
  await connectToDatabase();

  const server = app.listen(port, "0.0.0.0");
  try {
    await once(server, "listening");
  } catch (error) {
    await closeDatabase().catch(() => undefined);
    throw new Error(`Senderi API could not listen on port ${port}.`, { cause: error });
  }

  console.info(`Senderi API listening on port ${port}.`);
  registerShutdownHandlers(server);
}

function registerShutdownHandlers(server: Server): void {
  let isShuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.info(`${signal} received; closing the API and MongoDB connection.`);

    let shutdownFailed = false;
    try {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections();
      });
    } catch {
      console.error("Senderi API could not close its HTTP server cleanly.");
      shutdownFailed = true;
    }

    try {
      await closeDatabase();
    } catch {
      console.error("Senderi API could not close its MongoDB connection cleanly.");
      shutdownFailed = true;
    }

    if (shutdownFailed) {
      process.exitCode = 1;
    }
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

void startServer().catch(async (error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown startup error.";
  console.error(`Senderi API failed to start: ${message}`);
  await closeDatabase().catch(() => undefined);
  process.exitCode = 1;
});
