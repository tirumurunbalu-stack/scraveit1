/**
 * Owner's switch for the service-hours warm servers (founder 2026-11-14).
 *
 * Cloud Scheduler jobs warm-<service> (07:00 IST) and cold-<service> (00:00 IST)
 * set each Cloud Run service's minimum copies to 1 or 0. This switch has three positions:
 *  - "always":   pauses both timers and keeps every server warm day and night;
 *  - "schedule": resumes both timers and, between 7 AM and midnight IST, warms every server now;
 *  - "cold":     pauses the warm-up timer and sets every server cold now (the midnight
 *                cold timer stays on: going cold is always safe).
 */

import {DomainError} from "../errors";

const PROJECT = "savrivo-app";
const JOB_REGION = "asia-south1";
export const WARM_SERVICES: ReadonlyArray<{service: string; region: string}> = [
  {service: "createorder", region: "asia-south1"},
  {service: "getcheckoutconfiguration", region: "asia-south1"},
  {service: "updateorderstatus", region: "asia-south1"},
  {service: "onordercreated", region: "asia-south1"},
  {service: "onorderupdated", region: "asia-south1"},
  {service: "ondispatchclaimwritten", region: "asia-south1"},
  {service: "ontrackingupdated", region: "asia-southeast1"},
];

export type WarmthMode = "always" | "schedule" | "cold";

export interface WarmthStatus {
  mode: WarmthMode | "mixed";
  servers: Array<{service: string; warmNow: boolean; timerOn: boolean; coldTimerOn: boolean}>;
}

/** 7 AM up to midnight IST. */
export function inServiceHours(now: number): boolean {
  const istHour = new Date(now + 5.5 * 60 * 60 * 1000).getUTCHours();
  return istHour >= 7;
}

async function accessToken(): Promise<string> {
  const res = await fetch(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    {headers: {"Metadata-Flavor": "Google"}},
  );
  if (!res.ok) throw new DomainError("internal", "Could not get server credentials.");
  const body = await res.json() as {access_token?: string};
  if (!body.access_token) throw new DomainError("internal", "Could not get server credentials.");
  return body.access_token;
}

async function call(token: string, method: string, url: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method,
    headers: {"Authorization": `Bearer ${token}`, "Content-Type": "application/json"},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new DomainError("internal", `Google Cloud said ${res.status} for ${url.split("/").slice(-1)[0]}.`);
  return text ? JSON.parse(text) as Record<string, unknown> : {};
}

const jobUrl = (job: string) =>
  `https://cloudscheduler.googleapis.com/v1/projects/${PROJECT}/locations/${JOB_REGION}/jobs/${job}`;
const serviceUrl = (s: {service: string; region: string}) =>
  `https://run.googleapis.com/v2/projects/${PROJECT}/locations/${s.region}/services/${s.service}`;

/** Sets the service's minimum copies. A new revision is needed for the change to apply. */
async function setMinimum(token: string, s: {service: string; region: string}, copies: 0 | 1): Promise<void> {
  await call(token, "PATCH", `${serviceUrl(s)}?updateMask=scaling.minInstanceCount,template.revision`,
    {scaling: {minInstanceCount: copies}, template: {revision: ""}});
}

/** Which switch position one server is in, from its two timers and its minimum. */
export function serverMode(s: {warmNow: boolean; timerOn: boolean; coldTimerOn: boolean}): WarmthMode | "mixed" {
  if (s.timerOn && s.coldTimerOn) return "schedule";
  if (!s.timerOn && !s.coldTimerOn && s.warmNow) return "always";
  if (!s.timerOn && !s.warmNow) return "cold";
  return "mixed";
}

export async function readServerWarmth(): Promise<WarmthStatus> {
  const token = await accessToken();
  const servers = await Promise.all(WARM_SERVICES.map(async (s) => {
    const [warmJob, coldJob, svc] = await Promise.all([
      call(token, "GET", jobUrl(`warm-${s.service}`)),
      call(token, "GET", jobUrl(`cold-${s.service}`)),
      call(token, "GET", serviceUrl(s)),
    ]);
    const scaling = (svc.scaling ?? {}) as {minInstanceCount?: number};
    return {
      service: s.service,
      warmNow: Number(scaling.minInstanceCount ?? 0) > 0,
      timerOn: warmJob.state === "ENABLED",
      coldTimerOn: coldJob.state === "ENABLED",
    };
  }));
  const modes = new Set(servers.map(serverMode));
  return {mode: modes.size === 1 ? [...modes][0] ?? "mixed" : "mixed", servers};
}

export async function setServerWarmth(mode: WarmthMode, now = Date.now()): Promise<WarmthStatus> {
  const token = await accessToken();
  const warm = mode === "always" || (mode === "schedule" && inServiceHours(now));
  // One server at a time keeps the CPU quota steady while copies start or stop.
  for (const s of WARM_SERVICES) {
    await call(token, "POST", `${jobUrl(`warm-${s.service}`)}:${mode === "schedule" ? "resume" : "pause"}`, {});
    await call(token, "POST", `${jobUrl(`cold-${s.service}`)}:${mode === "always" ? "pause" : "resume"}`, {});
    await setMinimum(token, s, warm ? 1 : 0);
  }
  return readServerWarmth();
}
