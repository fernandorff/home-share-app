"use client";

import { useRef, useState } from "react";
import type { PointerEventHandler } from "react";

const TAP_SLOP_PX = 10;

interface TouchGesture {
  pointerId: number;
  startX: number;
  startY: number;
  moved: boolean;
  multiTouch: boolean;
}

/**
 * Radix opens dropdowns on pointerdown, before a touch browser knows whether the gesture is a tap,
 * scroll or pinch. This hook keeps Radix's immediate mouse/keyboard behavior, but defers touch
 * opening to the native click that browsers emit only for a completed tap.
 */
export function useTouchSafeDropdown(onClosed?: () => void) {
  const [open, setOpen] = useState(false);
  const touchGestureRef = useRef<TouchGesture | null>(null);

  const onOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) onClosed?.();
  };

  const onPointerDownCapture: PointerEventHandler<HTMLElement> = (event) => {
    if (event.pointerType !== "touch") return;

    if (touchGestureRef.current) {
      touchGestureRef.current.multiTouch = true;
    } else {
      touchGestureRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        moved: false,
        multiTouch: false,
      };
    }

    // Keep the native event/default behavior so pan and pinch remain available, but do not let
    // Radix's pointerdown handler open the dropdown before the gesture has been classified.
    event.stopPropagation();
  };

  const onPointerMoveCapture: PointerEventHandler<HTMLElement> = (event) => {
    const gesture = touchGestureRef.current;
    if (event.pointerType !== "touch" || !gesture) return;
    if (event.pointerId !== gesture.pointerId) {
      gesture.multiTouch = true;
      return;
    }

    const deltaX = event.clientX - gesture.startX;
    const deltaY = event.clientY - gesture.startY;
    if (deltaX * deltaX + deltaY * deltaY > TAP_SLOP_PX * TAP_SLOP_PX) {
      gesture.moved = true;
    }
  };

  const onPointerUpCapture: PointerEventHandler<HTMLElement> = (event) => {
    const gesture = touchGestureRef.current;
    if (event.pointerType !== "touch" || !gesture) return;
    if (event.pointerId !== gesture.pointerId) {
      gesture.multiTouch = true;
      return;
    }

    touchGestureRef.current = null;
    if (!gesture.moved && !gesture.multiTouch) onOpenChange(!open);
  };

  const onPointerCancelCapture: PointerEventHandler<HTMLElement> = () => {
    touchGestureRef.current = null;
  };

  return {
    open,
    onOpenChange,
    triggerProps: {
      onPointerDownCapture,
      onPointerMoveCapture,
      onPointerUpCapture,
      onPointerCancelCapture,
    },
  };
}
