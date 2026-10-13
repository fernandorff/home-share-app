"use client";

import { createContext, useContext, useState, useCallback } from "react";
import { cn } from "./cn";

type ToastType = "success" | "error" | "info";
interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
}

type ToastFn = (message: string, type?: ToastType) => void;

const ToastContext = createContext<ToastFn>(() => {});

const TONE: Record<ToastType, string> = {
  success: "border-l-credit",
  error: "border-l-debt",
  info: "border-l-ink",
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const push = useCallback<ToastFn>((message, type = "info") => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3800);
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toast-region pointer-events-none fixed inset-x-0 z-[60] flex flex-col items-center gap-2 px-4">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={cn(
              // No interactive content, so no pointer-events-auto — a toast never intercepts taps
              // meant for whatever is underneath it (e.g. a dialog footer button, U1).
              "anim-toast w-full max-w-sm rounded-md border border-rule border-l-4 bg-card px-4 py-3 text-sm text-ink shadow-[3px_3px_0_rgba(22,20,15,0.14)]",
              TONE[t.type]
            )}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastFn {
  return useContext(ToastContext);
}
