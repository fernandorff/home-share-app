"use client";

import { useEffect } from "react";
import { startInstallPromptCapture } from "@/lib/install-prompt";

/**
 * Starts the install-prompt capture (spec 009, criterion 2) once, from the root layout: Chromium fires
 * `beforeinstallprompt` a single time after some engagement — on a first visit often while the person is still on
 * /auth/login or /auth/register (outside the (app) group; login only soft-navigates) — so the deferred event is kept
 * in the store until the Notices page offers the install. Renders nothing.
 */
export function InstallPromptCapture() {
  useEffect(() => startInstallPromptCapture(), []);
  return null;
}
