import {HttpsError, type FunctionsErrorCode} from "firebase-functions/v2/https";

export class DomainError extends Error {
  constructor(
    public readonly code: FunctionsErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export function asHttpsError(error: unknown): HttpsError {
  if (error instanceof HttpsError) return error;
  if (error instanceof DomainError) return new HttpsError(error.code, error.message, error.details);
  const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
  const knownInvalid = new Set([
    "ITEM_UNAVAILABLE", "INVALID_CATALOG_PRICE", "VARIANT_REQUIRED", "CUSTOMIZATION_UNAVAILABLE",
    "DUPLICATE_ADD_ON", "EMPTY_OR_FREE_ORDER",
  ]);
  if (knownInvalid.has(message)) return new HttpsError("failed-precondition", message);
  return new HttpsError("internal", "The operation could not be completed safely.");
}
