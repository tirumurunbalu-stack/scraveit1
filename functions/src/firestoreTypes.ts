/**
 * A minimal slice of the Firestore Admin SDK's own shape, used as the
 * dependency-injection type across the services layer instead of the real
 * `Firestore`/`Transaction`/`DocumentReference` classes.
 *
 * Every service in this codebase already followed this pattern for the RTDB
 * `Database`/`Reference` types (see the individual `*Database` interfaces
 * being replaced), specifically so tests can inject a plain in-memory fake
 * instead of talking to a real database. Real `firestoreDb` (from
 * `../admin`) satisfies these interfaces structurally - no adapter needed -
 * because they're subsets of the real SDK's own method signatures.
 */

export interface DocumentSnapshotLike {
  readonly id: string;
  readonly exists: boolean;
  data(): unknown;
}

export interface DocumentReferenceLike {
  readonly id: string;
  readonly path: string;
  get(): Promise<DocumentSnapshotLike>;
  set(data: unknown, options?: {merge?: boolean}): Promise<unknown>;
  update(data: Record<string, unknown>): Promise<unknown>;
  delete(): Promise<unknown>;
  collection(name: string): CollectionReferenceLike;
}

export interface QuerySnapshotLike {
  readonly empty: boolean;
  readonly size: number;
  readonly docs: readonly DocumentSnapshotLike[];
  forEach(callback: (doc: DocumentSnapshotLike) => void): void;
}

export type WhereOp = "==" | "!=" | "<" | "<=" | ">" | ">=" | "array-contains" | "in" | "array-contains-any";

export interface QueryLike {
  where(field: string, op: WhereOp, value: unknown): QueryLike;
  orderBy(field: string, direction?: "asc" | "desc"): QueryLike;
  startAt(value: unknown): QueryLike;
  startAfter(value: unknown): QueryLike;
  endAt(value: unknown): QueryLike;
  endBefore(value: unknown): QueryLike;
  limit(count: number): QueryLike;
  limitToLast(count: number): QueryLike;
  get(): Promise<QuerySnapshotLike>;
}

export interface CollectionReferenceLike extends QueryLike {
  readonly id: string;
  doc(id?: string): DocumentReferenceLike;
}

export interface TransactionLike {
  get(ref: DocumentReferenceLike): Promise<DocumentSnapshotLike>;
  get(query: QueryLike): Promise<QuerySnapshotLike>;
  set(ref: DocumentReferenceLike, data: unknown, options?: {merge?: boolean}): TransactionLike;
  update(ref: DocumentReferenceLike, data: Record<string, unknown>): TransactionLike;
  delete(ref: DocumentReferenceLike): TransactionLike;
}

export interface WriteBatchLike {
  set(ref: DocumentReferenceLike, data: unknown, options?: {merge?: boolean}): WriteBatchLike;
  update(ref: DocumentReferenceLike, data: Record<string, unknown>): WriteBatchLike;
  delete(ref: DocumentReferenceLike): WriteBatchLike;
  commit(): Promise<unknown>;
}

export interface FirestoreLike {
  collection(name: string): CollectionReferenceLike;
  doc(path: string): DocumentReferenceLike;
  runTransaction<T>(updateFunction: (transaction: TransactionLike) => Promise<T>): Promise<T>;
  batch(): WriteBatchLike;
}

/** Firestore represents "no value" as field-absence via a sentinel, not a
 * plain `null` the way RTDB code throughout this codebase wrote to
 * delete/clear a field. Converted files use this instead of a literal
 * `null` when clearing a field with `.update()`. */
export {FieldValue} from "firebase-admin/firestore";
