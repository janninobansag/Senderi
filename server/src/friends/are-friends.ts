import { ObjectId, type Db } from "mongodb";
import { collectionNames, type FriendshipDocument } from "../db/documents";

/** Return the canonical pair used by the friendship unique index. */
export function orderedUserPair(first: ObjectId, second: ObjectId): [ObjectId, ObjectId] {
  return first.toHexString() < second.toHexString()
    ? [first, second]
    : [second, first];
}

/** Check the persisted mutual-friendship record for two distinct users. */
export async function areFriends(
  database: Db,
  firstUserId: ObjectId,
  secondUserId: ObjectId,
): Promise<boolean> {
  if (firstUserId.equals(secondUserId)) return false;
  const [userIdLow, userIdHigh] = orderedUserPair(firstUserId, secondUserId);
  const friendship = await database
    .collection<FriendshipDocument>(collectionNames.friendships)
    .findOne({ userIdLow, userIdHigh }, { projection: { _id: 1 } });
  return friendship !== null;
}
