import { after } from "next/server";
import { pushConfig } from "@/lib/push/config";
import { pushService, type PushNoticeRow } from "@/services/push.service";

// Push after the response (spec 010, criteria 6–7): a slow or failing push service never touches the request that
// produced the notice. In a request (a route, a cron job, or a nested after() such as the expense route's notice
// producer) after() keeps the function alive until the dispatch resolves. Outside one (tests, scripts) after()
// throws, so the dispatch starts right away and is tracked for flushPush() — the pattern of prisma-audit's deferred
// revision writes. Lives here, not in the service: next/server stays out of src/services.

const pending = new Set<Promise<unknown>>();

/** Sends the push copy of exactly these inserted notices once the response is out; a no-op when unconfigured or empty. */
export function schedulePush(rows: readonly PushNoticeRow[]): void {
  if (rows.length === 0 || !pushConfig()) return;
  const dispatch = () => pushService.dispatch(rows); // never rejects: failures are logged inside
  try {
    after(dispatch);
  } catch {
    const tracked = dispatch().finally(() => pending.delete(tracked));
    pending.add(tracked);
  }
}

/** Awaits the dispatches started outside a request. Used by tests; safe to call anywhere. */
export async function flushPush(): Promise<void> {
  await Promise.allSettled([...pending]);
}
