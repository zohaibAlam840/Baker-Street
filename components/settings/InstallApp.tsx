"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

import { Card, CardHeader } from "@/components/charts";

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

function isInstalled() {
  const standaloneNavigator = navigator as Navigator & { standalone?: boolean };
  return window.matchMedia("(display-mode: standalone)").matches
    || standaloneNavigator.standalone === true;
}

function subscribeToInstallState(onChange: () => void) {
  const displayMode = window.matchMedia("(display-mode: standalone)");
  displayMode.addEventListener("change", onChange);
  window.addEventListener("appinstalled", onChange);
  return () => {
    displayMode.removeEventListener("change", onChange);
    window.removeEventListener("appinstalled", onChange);
  };
}

export function InstallApp() {
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null);
  const installed = useSyncExternalStore(
    subscribeToInstallState,
    isInstalled,
    () => false,
  );

  useEffect(() => {
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setPrompt(event as InstallPromptEvent);
    };
    const onInstalled = () => {
      setPrompt(null);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  async function install() {
    if (!prompt) return;
    await prompt.prompt();
    await prompt.userChoice;
    setPrompt(null);
  }

  return (
    <Card>
      <CardHeader
        title="Install on this device"
        sub="Use a full-screen app while keeping all patient data on the server"
      />
      <p className="mt-3 text-sm leading-relaxed text-[var(--ink-secondary)]">
        {installed
          ? "This device is already running the installed app."
          : prompt
            ? "Your browser is ready to install Baker Street Scheduling."
            : "On iPhone or iPad, choose Share, then Add to Home Screen. In other supported browsers, use Install app from the browser menu."}
      </p>
      {prompt && !installed ? (
        <button
          type="button"
          onClick={install}
          className="mt-4 min-h-11 rounded-full bg-[var(--brand)] px-5 text-sm font-medium text-white"
        >
          Install app
        </button>
      ) : null}
      <p className="mt-3 text-xs leading-relaxed text-[var(--ink-muted)]">
        Offline access shows only the safe reconnect screen. Patient records and queued writes are never cached on this device.
      </p>
    </Card>
  );
}
