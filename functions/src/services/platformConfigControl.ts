import {randomUUID} from "node:crypto";
import type {DecodedIdToken} from "firebase-admin/auth";
import {db} from "../admin";
import {ROOT} from "../config";
import {
  applyPlatformConfigPatch,
  platformConfigHash,
  platformConfigOperationKey,
  platformConfigState,
  updatePlatformConfigSchema,
  type PlatformConfigState,
  type UpdatePlatformConfigInput,
} from "../domain/platformConfigControl";
import {DomainError} from "../errors";
import {
  requirePlatformConfigAdminClaim,
  type PlatformConfigAdminRole,
} from "./authz";
import {clearPlatformConfigCache} from "./platformConfig";

interface ValueSnapshot {
  val(): unknown;
}

interface TransactionResult {
  committed: boolean;
  snapshot: ValueSnapshot;
}

interface ConfigReference {
  get(): Promise<ValueSnapshot>;
  transaction(
    update: (current: unknown) => unknown,
    onComplete?: unknown,
    applyLocally?: boolean,
  ): Promise<TransactionResult>;
}

export interface PlatformConfigDatabase {
  ref(path: string): ConfigReference;
}

interface ConfigOperationRecord {
  operationId: string;
  requestHash: string;
  requestInstanceId: string;
  actorId: string;
  actorRole: PlatformConfigAdminRole;
  at: number;
  revision: number;
  changedSections: Array<"dispatch" | "finance">;
  beforeHash: string;
  afterHash: string;
}

export interface PlatformConfigResponse extends PlatformConfigState {
  idempotent?: boolean;
  changedSections?: Array<"dispatch" | "finance">;
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};
}

function operation(value: unknown): ConfigOperationRecord | null {
  const candidate = record(value);
  if (typeof candidate.operationId !== "string" || typeof candidate.requestHash !== "string" ||
      typeof candidate.actorId !== "string" || typeof candidate.requestInstanceId !== "string" ||
      (candidate.actorRole !== "owner" && candidate.actorRole !== "ops_admin") ||
      !Number.isSafeInteger(candidate.at) || !Number.isSafeInteger(candidate.revision) ||
      !Array.isArray(candidate.changedSections)) return null;
  return candidate as unknown as ConfigOperationRecord;
}

function parseUpdate(value: unknown): UpdatePlatformConfigInput {
  const parsed = updatePlatformConfigSchema.safeParse(value);
  if (!parsed.success) {
    const message = parsed.error.issues.map((issue) => issue.message).join(" ").slice(0, 500);
    throw new DomainError("invalid-argument", message || "Invalid platform configuration update.");
  }
  return parsed.data;
}

function domainPatch(
  current: PlatformConfigState,
  input: UpdatePlatformConfigInput,
): ReturnType<typeof applyPlatformConfigPatch> {
  try {
    return applyPlatformConfigPatch(current, input);
  } catch (error) {
    const message = error instanceof Error ? error.message : "INVALID_PLATFORM_CONFIGURATION";
    throw new DomainError("invalid-argument", message);
  }
}

function defaultDatabase(): PlatformConfigDatabase {
  return db as unknown as PlatformConfigDatabase;
}

/** Reads normalized public operating policy through a custom-claim guarded
 * server path. It never exposes internal operation/audit metadata. */
export async function readPlatformConfiguration(
  token: DecodedIdToken,
  database: PlatformConfigDatabase = defaultDatabase(),
): Promise<PlatformConfigResponse> {
  requirePlatformConfigAdminClaim(token);
  const snapshot = await database.ref(`${ROOT}/platformConfig`).get();
  return platformConfigState(snapshot.val());
}

/**
 * Atomically applies an operations policy patch with optimistic concurrency,
 * idempotency, and an operation record stored in the same transaction. The
 * canonical audit mirror uses the same deterministic id, so a retry repairs a
 * transient audit-write failure without applying the config twice.
 */
export async function updatePlatformConfiguration(
  uid: string,
  token: DecodedIdToken,
  rawInput: unknown,
  database: PlatformConfigDatabase = defaultDatabase(),
  now = Date.now(),
): Promise<PlatformConfigResponse> {
  const actorRole = requirePlatformConfigAdminClaim(token);
  const input = parseUpdate(rawInput);
  const operationKey = platformConfigOperationKey(input.operationId);
  const requestHash = platformConfigHash({
    operationId: input.operationId,
    expectedRevision: input.expectedRevision ?? null,
    dispatch: input.dispatch ?? null,
    finance: input.finance ?? null,
  });
  const requestInstanceId = randomUUID();
  const configRef = database.ref(`${ROOT}/platformConfig`);
  let abort: DomainError | null = null;

  const result = await configRef.transaction((rawCurrent) => {
    abort = null;
    const root = record(rawCurrent);
    const operations = record(root._operations);
    const existing = operation(operations[operationKey]);
    if (existing) {
      if (existing.operationId !== input.operationId || existing.requestHash !== requestHash || existing.actorId !== uid) {
        abort = new DomainError("already-exists", "Operation id was already used for a different configuration change.");
        return undefined;
      }
      return root;
    }

    const current = platformConfigState(root);
    if (input.expectedRevision !== undefined && input.expectedRevision !== current.revision) {
      abort = new DomainError("aborted", "Platform configuration changed; refresh and retry with the latest revision.", {
        expectedRevision: input.expectedRevision,
        actualRevision: current.revision,
      });
      return undefined;
    }

    let nextPolicies: ReturnType<typeof applyPlatformConfigPatch>;
    try {
      nextPolicies = domainPatch(current, input);
    } catch (error) {
      abort = error instanceof DomainError ? error : new DomainError("invalid-argument", "Invalid platform configuration.");
      return undefined;
    }

    const changedSections: Array<"dispatch" | "finance"> = [];
    if (platformConfigHash(current.dispatch) !== platformConfigHash(nextPolicies.dispatch)) changedSections.push("dispatch");
    if (platformConfigHash(current.finance) !== platformConfigHash(nextPolicies.finance)) changedSections.push("finance");
    const revision = current.revision + (changedSections.length ? 1 : 0);
    const beforeHash = platformConfigHash({dispatch: current.dispatch, finance: current.finance});
    const afterHash = platformConfigHash(nextPolicies);
    const operationRecord: ConfigOperationRecord = {
      operationId: input.operationId,
      requestHash,
      requestInstanceId,
      actorId: uid,
      actorRole,
      at: now,
      revision,
      changedSections,
      beforeHash,
      afterHash,
    };
    return {
      ...root,
      dispatch: nextPolicies.dispatch,
      finance: nextPolicies.finance,
      _meta: changedSections.length ? {
        revision,
        updatedAt: now,
        updatedBy: uid,
        updatedByRole: actorRole,
        lastOperationId: input.operationId,
      } : record(root._meta),
      _operations: {...operations, [operationKey]: operationRecord},
    };
  }, undefined, false);

  if (!result.committed) throw abort ?? new DomainError("aborted", "Platform configuration could not be updated safely.");
  const finalRoot = record(result.snapshot.val());
  const finalOperation = operation(record(finalRoot._operations)[operationKey]);
  if (!finalOperation || finalOperation.requestHash !== requestHash || finalOperation.actorId !== uid) {
    throw new DomainError("internal", "Platform configuration operation could not be verified.");
  }

  const auditId = `platform-config-${operationKey.slice(0, 48)}`;
  const auditRecord = {
    id: auditId,
    action: finalOperation.changedSections.length ? "platform_config.update" : "platform_config.noop",
    target: "platformConfig",
    detail: `${finalOperation.changedSections.join(",") || "no policy values"}; revision ${finalOperation.revision}`,
    actorId: uid,
    actorEmail: String(token.email ?? "").slice(0, 254),
    actorRole,
    at: finalOperation.at,
  };
  await database.ref(`${ROOT}/audit/${auditId}`).transaction((current) => current ?? auditRecord, undefined, false);
  clearPlatformConfigCache();

  return {
    ...platformConfigState(finalRoot),
    changedSections: finalOperation.changedSections,
    idempotent: finalOperation.requestInstanceId !== requestInstanceId,
  };
}

