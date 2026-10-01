import { MongoClient, MongoServerError, type Db } from "mongodb";
import { ensureDatabaseIndexes } from "./indexes";

let mongoClient: MongoClient | undefined;
let activeDatabase: Db | undefined;

export async function connectToDatabase(uri = process.env.MONGODB_URI): Promise<Db> {
  if (!uri?.trim()) {
    throw new Error(
      "MONGODB_URI is required. Set it in server/.env for local development or in the server environment for deployment.",
    );
  }

  if (mongoClient && activeDatabase) {
    return activeDatabase;
  }

  let nextClient: MongoClient | undefined;

  try {
    nextClient = new MongoClient(uri, { serverSelectionTimeoutMS: 10_000 });
    await nextClient.connect();
    const nextDatabase = nextClient.db();
    await ensureDatabaseIndexes(nextDatabase);

    mongoClient = nextClient;
    activeDatabase = nextDatabase;
    console.info("Connected to MongoDB; required indexes are ready.");
    return nextDatabase;
  } catch (error) {
    await nextClient?.close().catch(() => undefined);
    if (error instanceof MongoServerError && (error.code === 85 || error.code === 86)) {
      throw new Error(
        "MongoDB has an index with conflicting options. Review existing collection indexes before starting Senderi.",
        { cause: error },
      );
    }
    throw new Error(
      "MongoDB startup failed. Check MONGODB_URI, Atlas network access, and database permissions.",
      { cause: error },
    );
  }
}

export function getDatabase(): Db {
  if (!activeDatabase) {
    throw new Error("MongoDB is not connected. Start the API through server/src/index.ts.");
  }
  return activeDatabase;
}

export async function closeDatabase(): Promise<void> {
  const connectedClient = mongoClient;
  mongoClient = undefined;
  activeDatabase = undefined;

  if (connectedClient) {
    await connectedClient.close();
    console.info("MongoDB connection closed.");
  }
}
