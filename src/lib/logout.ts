import { api } from "@/lib/api";
import { unsubscribePush } from "@/lib/push/client";

/**
 * Logs out THIS device (ADR 0013). Its push subscription goes first, while the session still authorizes the DELETE —
 * otherwise a logged-out phone would keep getting the house's notifications. Best effort: the logout always happens.
 */
export async function logout(): Promise<void> {
  try {
    await unsubscribePush().catch(() => {});
    await api.post("/api/auth/logout");
  } finally {
    window.location.href = "/auth/login";
  }
}
