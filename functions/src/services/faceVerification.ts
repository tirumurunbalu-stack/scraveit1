import {logger} from "firebase-functions";
import {defineSecret} from "firebase-functions/params";
import {
  CompareFacesCommand,
  CreateCollectionCommand,
  IndexFacesCommand,
  InvalidParameterException,
  RekognitionClient,
  ResourceAlreadyExistsException,
  SearchFacesByImageCommand,
} from "@aws-sdk/client-rekognition";
import {DomainError} from "../errors";

export const AWS_ACCESS_KEY_ID = defineSecret("AWS_ACCESS_KEY_ID");
export const AWS_SECRET_ACCESS_KEY = defineSecret("AWS_SECRET_ACCESS_KEY");

// Mumbai - closest Rekognition region to Nellore, keeps face-check latency down.
const AWS_REKOGNITION_REGION = "ap-south-1";
const COLLECTION_ID = "savrivo-riders";

// A match at signup only ever routes to a human review queue, never an
// automatic rejection (see checkRiderFaceUniqueness) - so this can afford to
// be a little permissive and catch more true duplicates, at the cost of
// occasionally flagging two genuinely different people for a reviewer to
// clear. A false "unique" here is what actually defeats the referral
// program, so this threshold favours catching duplicates over convenience.
const SIGNUP_SIMILARITY_THRESHOLD = 90;
// A login compare has no human in the loop - a wrong accept here lets someone
// into another rider's account and wallet. Set high on purpose; a wrong
// reject just costs the rider a retry.
const LOGIN_SIMILARITY_THRESHOLD = 96;

let collectionEnsured = false;

function rekognitionClient(accessKeyId: string, secretAccessKey: string): RekognitionClient {
  return new RekognitionClient({
    region: AWS_REKOGNITION_REGION,
    credentials: {accessKeyId, secretAccessKey},
  });
}

async function ensureCollection(rekognition: RekognitionClient): Promise<void> {
  if (collectionEnsured) return;
  try {
    await rekognition.send(new CreateCollectionCommand({CollectionId: COLLECTION_ID}));
    logger.info("REKOGNITION_COLLECTION_CREATED", {collectionId: COLLECTION_ID});
  } catch (error) {
    if (!(error instanceof ResourceAlreadyExistsException)) throw error;
  }
  collectionEnsured = true;
}

function faceRejection(error: unknown): DomainError | null {
  if (error instanceof InvalidParameterException) {
    return new DomainError(
      "invalid-argument",
      "No face was detected in that photo. Look directly at the camera in good lighting and try again.",
    );
  }
  return null;
}

export interface FaceMatchCandidate {
  riderUid: string;
  similarity: number;
}

export type FaceUniquenessResult =
  | {status: "unique"; rekognitionFaceId: string}
  | {status: "needs_review"; candidates: FaceMatchCandidate[]};

/**
 * Signup-time check: searches every previously indexed rider face for a
 * match. A match never auto-rejects the application - it comes back as
 * "needs_review" so a human confirms it's really the same person before
 * anyone is blocked on a false positive (two siblings, a bad frame, etc).
 * Only a genuinely new face gets indexed, under this rider's own uid as its
 * ExternalImageId, so a future search can identify who it belongs to.
 */
export async function checkRiderFaceUniqueness(
  accessKeyId: string,
  secretAccessKey: string,
  uid: string,
  imageBuffer: Buffer,
): Promise<FaceUniquenessResult> {
  const rekognition = rekognitionClient(accessKeyId, secretAccessKey);
  await ensureCollection(rekognition);

  let searchResult;
  try {
    searchResult = await rekognition.send(new SearchFacesByImageCommand({
      CollectionId: COLLECTION_ID,
      Image: {Bytes: imageBuffer},
      FaceMatchThreshold: SIGNUP_SIMILARITY_THRESHOLD,
      MaxFaces: 5,
    }));
  } catch (error) {
    const rejection = faceRejection(error);
    if (rejection) throw rejection;
    logger.error("REKOGNITION_SEARCH_FAILED", {uid, error});
    throw new DomainError("unavailable", "Identity verification is temporarily unavailable. Try again shortly.");
  }

  const candidates = (searchResult.FaceMatches ?? [])
    .filter((match) => match.Face?.ExternalImageId && match.Face.ExternalImageId !== uid)
    .map((match) => ({riderUid: match.Face!.ExternalImageId!, similarity: Number(match.Similarity ?? 0)}));
  if (candidates.length > 0) {
    logger.warn("REKOGNITION_POSSIBLE_DUPLICATE_RIDER", {uid, candidates});
    return {status: "needs_review", candidates};
  }

  let indexResult;
  try {
    indexResult = await rekognition.send(new IndexFacesCommand({
      CollectionId: COLLECTION_ID,
      Image: {Bytes: imageBuffer},
      ExternalImageId: uid,
      MaxFaces: 1,
      QualityFilter: "AUTO",
      DetectionAttributes: [],
    }));
  } catch (error) {
    const rejection = faceRejection(error);
    if (rejection) throw rejection;
    logger.error("REKOGNITION_INDEX_FAILED", {uid, error});
    throw new DomainError("unavailable", "Identity verification is temporarily unavailable. Try again shortly.");
  }
  const faceId = indexResult.FaceRecords?.[0]?.Face?.FaceId;
  if (!faceId) {
    throw new DomainError(
      "invalid-argument",
      "That photo was too unclear to verify. Look directly at the camera in good lighting and try again.",
    );
  }
  return {status: "unique", rekognitionFaceId: faceId};
}

/**
 * Admin-review resolution: an owner looked at a flagged signup-time match
 * and confirmed this really is a new, distinct person (not the same rider
 * signing up twice) - so their reference photo is indexed directly, the
 * same way an unmatched signup would have been, without re-running the
 * search (the human review already served that purpose).
 */
export async function indexRiderFaceDirectly(
  accessKeyId: string,
  secretAccessKey: string,
  uid: string,
  imageBuffer: Buffer,
): Promise<{rekognitionFaceId: string}> {
  const rekognition = rekognitionClient(accessKeyId, secretAccessKey);
  await ensureCollection(rekognition);
  let indexResult;
  try {
    indexResult = await rekognition.send(new IndexFacesCommand({
      CollectionId: COLLECTION_ID,
      Image: {Bytes: imageBuffer},
      ExternalImageId: uid,
      MaxFaces: 1,
      QualityFilter: "AUTO",
      DetectionAttributes: [],
    }));
  } catch (error) {
    const rejection = faceRejection(error);
    if (rejection) throw rejection;
    logger.error("REKOGNITION_REVIEW_INDEX_FAILED", {uid, error});
    throw new DomainError("unavailable", "Identity verification is temporarily unavailable. Try again shortly.");
  }
  const faceId = indexResult.FaceRecords?.[0]?.Face?.FaceId;
  if (!faceId) {
    throw new DomainError("invalid-argument", "That photo was too unclear to index. Ask the rider to retake it.");
  }
  return {rekognitionFaceId: faceId};
}

/**
 * Login-time check: a plain 1:1 compare of a fresh selfie against this one
 * rider's own reference photo - deliberately not a collection search, so a
 * login never has to scan every other rider's face just to confirm someone
 * is who their account says they are.
 */
export async function compareRiderLoginFace(
  accessKeyId: string,
  secretAccessKey: string,
  uid: string,
  referenceImageBuffer: Buffer,
  liveImageBuffer: Buffer,
): Promise<{verified: boolean; similarity: number}> {
  const rekognition = rekognitionClient(accessKeyId, secretAccessKey);
  let result;
  try {
    result = await rekognition.send(new CompareFacesCommand({
      SourceImage: {Bytes: referenceImageBuffer},
      TargetImage: {Bytes: liveImageBuffer},
      SimilarityThreshold: LOGIN_SIMILARITY_THRESHOLD,
    }));
  } catch (error) {
    const rejection = faceRejection(error);
    if (rejection) throw rejection;
    logger.error("REKOGNITION_COMPARE_FAILED", {uid, error});
    throw new DomainError("unavailable", "Identity verification is temporarily unavailable. Try again shortly.");
  }
  const bestSimilarity = (result.FaceMatches ?? [])
    .reduce((best, match) => Math.max(best, Number(match.Similarity ?? 0)), 0);
  return {verified: bestSimilarity >= LOGIN_SIMILARITY_THRESHOLD, similarity: bestSimilarity};
}
