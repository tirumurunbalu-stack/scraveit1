import {randomUUID} from "node:crypto";
import {FieldValue} from "firebase-admin/firestore";
import type {
  CollectionReferenceLike,
  DocumentReferenceLike,
  DocumentSnapshotLike,
  FirestoreLike,
  QueryLike,
  QuerySnapshotLike,
  TransactionLike,
  WhereOp,
  WriteBatchLike,
} from "../../src/firestoreTypes";

/**
 * A plain in-memory stand-in for the real Firestore Admin SDK, implementing
 * just enough of FirestoreLike for this codebase's tests to inject instead
 * of a real Firestore instance - same role the old per-file RTDB
 * `InMemory*Database` test doubles played, now shared across every converted
 * service's tests instead of being reinvented per file.
 *
 * Transactions apply writes immediately rather than buffering until commit -
 * every call site in this codebase's tests runs transactions sequentially,
 * never concurrently, so this simplification never observably differs from
 * real Firestore's buffer-until-commit behavior for what these tests check.
 */
export class InMemoryFirestore implements FirestoreLike {
  private readonly store = new Map<string, unknown>();
  /** Count of runTransaction() invocations - independent of the data store,
   * for tests asserting "no transaction ran" without caring what a seeded
   * fixture already put in the store. */
  transactionCount = 0;
  /**
   * Real Firestore transactions are isolated: two concurrent transactions
   * never interleave their read-then-write on the same document. This
   * fake's transaction body does contain a genuine `await` (`transaction.get`),
   * so without serializing, two `runTransaction` calls kicked off together
   * (e.g. via `Promise.all`) would both read the pre-write state and both
   * commit - a race real Firestore's optimistic concurrency would never
   * allow (the loser retries or aborts). A single global queue is a coarser
   * guarantee than real per-document isolation, but it never lets a test
   * observe MORE concurrency than production would, which is what matters
   * for exercising compare-and-set/abort logic correctly here.
   */
  private transactionQueue: Promise<unknown> = Promise.resolve();

  seed(path: string, data: unknown): void {
    this.store.set(path, structuredClone(data));
  }

  read(path: string): unknown {
    return this.store.has(path) ? structuredClone(this.store.get(path)) : null;
  }

  paths(): string[] {
    return [...this.store.keys()];
  }

  collection(name: string): CollectionReferenceLike {
    return new InMemoryCollection(this.store, name);
  }

  doc(path: string): DocumentReferenceLike {
    const segments = path.split("/").filter(Boolean);
    if (segments.length < 2 || segments.length % 2 !== 0) {
      throw new Error(`INVALID_DOCUMENT_PATH: ${path}`);
    }
    const collectionPath = segments.slice(0, -1).join("/");
    const id = segments[segments.length - 1];
    return new InMemoryDocument(this.store, collectionPath, id);
  }

  async runTransaction<T>(updateFunction: (transaction: TransactionLike) => Promise<T>): Promise<T> {
    const run = this.transactionQueue.then(() => this.executeTransaction(updateFunction));
    this.transactionQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async executeTransaction<T>(updateFunction: (transaction: TransactionLike) => Promise<T>): Promise<T> {
    this.transactionCount += 1;
    const transaction: TransactionLike = {
      get: ((refOrQuery: DocumentReferenceLike | QueryLike) => {
        if ("get" in refOrQuery && typeof (refOrQuery as DocumentReferenceLike).path === "string" &&
          !(refOrQuery instanceof InMemoryQuery)) {
          return (refOrQuery as DocumentReferenceLike).get();
        }
        return (refOrQuery as QueryLike).get();
      }) as TransactionLike["get"],
      set: (ref, data, options) => {
        void (ref as InMemoryDocument).set(data, options);
        return transaction;
      },
      update: (ref, data) => {
        void (ref as InMemoryDocument).update(data);
        return transaction;
      },
      delete: (ref) => {
        void (ref as InMemoryDocument).delete();
        return transaction;
      },
    };
    return updateFunction(transaction);
  }

  batch(): WriteBatchLike {
    const operations: Array<() => Promise<unknown>> = [];
    const batch: WriteBatchLike = {
      set: (ref, data, options) => {
        operations.push(() => (ref as InMemoryDocument).set(data, options));
        return batch;
      },
      update: (ref, data) => {
        operations.push(() => (ref as InMemoryDocument).update(data));
        return batch;
      },
      delete: (ref) => {
        operations.push(() => (ref as InMemoryDocument).delete());
        return batch;
      },
      commit: async () => {
        for (const operation of operations) await operation();
      },
    };
    return batch;
  }
}

class InMemoryDocument implements DocumentReferenceLike {
  constructor(
    private readonly store: Map<string, unknown>,
    private readonly collectionPath: string,
    public readonly id: string,
  ) {}

  get path(): string {
    return `${this.collectionPath}/${this.id}`;
  }

  async get(): Promise<DocumentSnapshotLike> {
    const exists = this.store.has(this.path);
    const value = exists ? structuredClone(this.store.get(this.path)) : undefined;
    return {
      id: this.id,
      exists,
      data: () => value,
    };
  }

  async set(data: unknown, options?: {merge?: boolean}): Promise<unknown> {
    if (options?.merge && this.store.has(this.path)) {
      const current = this.store.get(this.path) as Record<string, unknown>;
      this.store.set(this.path, {...current, ...(data as Record<string, unknown>)});
    } else {
      this.store.set(this.path, structuredClone(data));
    }
    return undefined;
  }

  async update(data: Record<string, unknown>): Promise<unknown> {
    if (!this.store.has(this.path)) throw new Error(`NOT_FOUND: ${this.path}`);
    const current = this.store.get(this.path) as Record<string, unknown>;
    const next = {...current};
    for (const [key, value] of Object.entries(data)) {
      if (value instanceof FieldValue) {
        delete next[key];
      } else {
        next[key] = value;
      }
    }
    this.store.set(this.path, next);
    return undefined;
  }

  async delete(): Promise<unknown> {
    this.store.delete(this.path);
    return undefined;
  }

  collection(name: string): CollectionReferenceLike {
    return new InMemoryCollection(this.store, `${this.path}/${name}`);
  }
}

interface WhereClause {
  field: string;
  op: WhereOp;
  value: unknown;
}

class InMemoryQuery implements QueryLike {
  protected wheres: WhereClause[] = [];
  protected orderByField: string | null = null;
  protected orderDirection: "asc" | "desc" = "asc";
  protected limitCount: number | null = null;
  protected limitLastCount: number | null = null;
  protected startAtValue: unknown;
  protected endAtValue: unknown;

  constructor(protected readonly store: Map<string, unknown>, protected readonly collectionPath: string) {}

  private clone(): InMemoryQuery {
    const next = new InMemoryQuery(this.store, this.collectionPath);
    next.wheres = [...this.wheres];
    next.orderByField = this.orderByField;
    next.orderDirection = this.orderDirection;
    next.limitCount = this.limitCount;
    next.limitLastCount = this.limitLastCount;
    next.startAtValue = this.startAtValue;
    next.endAtValue = this.endAtValue;
    return next;
  }

  where(field: string, op: WhereOp, value: unknown): QueryLike {
    const next = this.clone();
    next.wheres.push({field, op, value});
    return next;
  }

  orderBy(field: string, direction: "asc" | "desc" = "asc"): QueryLike {
    const next = this.clone();
    next.orderByField = field;
    next.orderDirection = direction;
    return next;
  }

  startAt(value: unknown): QueryLike {
    const next = this.clone();
    next.startAtValue = value;
    return next;
  }

  startAfter(value: unknown): QueryLike {
    return this.startAt(value);
  }

  endAt(value: unknown): QueryLike {
    const next = this.clone();
    next.endAtValue = value;
    return next;
  }

  endBefore(value: unknown): QueryLike {
    return this.endAt(value);
  }

  limit(count: number): QueryLike {
    const next = this.clone();
    next.limitCount = count;
    return next;
  }

  limitToLast(count: number): QueryLike {
    const next = this.clone();
    next.limitLastCount = count;
    return next;
  }

  private matches(data: Record<string, unknown>): boolean {
    return this.wheres.every(({field, op, value}) => {
      const actual = data[field];
      switch (op) {
        case "==": return actual === value;
        case "!=": return actual !== value;
        case "<": return (actual as number) < (value as number);
        case "<=": return (actual as number) <= (value as number);
        case ">": return (actual as number) > (value as number);
        case ">=": return (actual as number) >= (value as number);
        case "array-contains": return Array.isArray(actual) && actual.includes(value);
        case "in": return Array.isArray(value) && value.includes(actual);
        case "array-contains-any": return Array.isArray(actual) && Array.isArray(value) &&
          value.some((entry) => (actual as unknown[]).includes(entry));
        default: return false;
      }
    });
  }

  async get(): Promise<QuerySnapshotLike> {
    const prefix = `${this.collectionPath}/`;
    let entries = [...this.store.entries()]
      .filter(([path]) => path.startsWith(prefix) && path.slice(prefix.length).split("/").length === 1)
      .map(([path, value]) => ({id: path.slice(prefix.length), data: value as Record<string, unknown>}))
      .filter((entry) => this.matches(entry.data));

    if (this.orderByField) {
      const field = this.orderByField;
      entries = entries.sort((a, b) => {
        const left = a.data[field] as number | string;
        const right = b.data[field] as number | string;
        const comparison = left < right ? -1 : left > right ? 1 : 0;
        return this.orderDirection === "desc" ? -comparison : comparison;
      });
      if (this.startAtValue !== undefined) {
        entries = entries.filter((entry) => (entry.data[field] as number) >= (this.startAtValue as number));
      }
      if (this.endAtValue !== undefined) {
        entries = entries.filter((entry) => (entry.data[field] as number) <= (this.endAtValue as number));
      }
    }
    if (this.limitLastCount !== null) entries = entries.slice(-this.limitLastCount);
    else if (this.limitCount !== null) entries = entries.slice(0, this.limitCount);

    const docs: DocumentSnapshotLike[] = entries.map((entry) => ({
      id: entry.id,
      exists: true,
      data: () => structuredClone(entry.data),
    }));
    return {
      empty: docs.length === 0,
      size: docs.length,
      docs,
      forEach: (callback) => docs.forEach(callback),
    };
  }
}

class InMemoryCollection extends InMemoryQuery implements CollectionReferenceLike {
  get id(): string {
    return this.collectionPath.split("/").pop() ?? this.collectionPath;
  }

  doc(id?: string): DocumentReferenceLike {
    return new InMemoryDocument(this.store, this.collectionPath, id ?? randomUUID());
  }
}
