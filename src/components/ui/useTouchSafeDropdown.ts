"use client";

import { useEffect, useRef, useState } from "react";
import type { MouseEventHandler, PointerEventHandler } from "react";

/**
 * Radix opens dropdowns on pointerdown, before a touch browser knows whether the gesture is a tap,
 * scroll or pinch. This hook keeps Radix's immediate mouse/keyboard behavior, but defers touch
 * opening to the native click that browsers emit only for a completed tap.
 */
export function useTouchSafeDropdown(onClosed?: () => void) {
  const [open, setOpen] = useState(false);
  const touchPressRef = useRef(false);
  const touchResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (touchResetRef.current) clearTimeout(touchResetRef.current);
  }, []);

  const onOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) onClosed?.();
  };

  const onPointerDownCapture: PointerEventHandler<HTMLElement> = (event) => {
    if (event.pointerType !== "touch") return;
    touchPressRef.current = true;
    // Keep the native event/default behavior so pan and pinch remain available, but do not let
    // Radix's pointerdown handler open the dropdown before the gesture has been classified.
    event.stopPropagation();
  };

  const onPointerUpCapture: PointerEventHandler<HTMLElement> = (event) => {
    if (event.pointerType !== "touch") return;
    if (touchResetRef.current) clearTimeout(touchResetRef.current);
    // A real tap emits click immediately after pointerup. Scroll and pinch do not.
    touchResetRef.current = setTimeout(() => {
      touchPressRef.current = false;
      touchResetRef.current = null;
    }, 0);
  };

  const onPointerCancelCapture: PointerEventHandler<HTMLElement> = () => {
    touchPressRef.current = false;
  };

  const onClick: MouseEventHandler<HTMLElement> = () => {
    if (!touchPressRef.current) return;
    touchPressRef.current = false;
    if (touchResetRef.current) {
      clearTimeout(touchResetRef.current);
      touchResetRef.current = null;
    }
    onOpenChange(!open);
  };

  return {
    open,
    onOpenChange,
    triggerProps: {
      onPointerDownCapture,
      onPointerUpCapture,
      onPointerCancelCapture,
      onClick,
    },
  };
}
