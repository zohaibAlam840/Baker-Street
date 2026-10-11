"use client";

import { useEffect, useRef, useState } from "react";

const key = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
const READY_TIMEOUT_MS = 10_000;
const BROWSER_OPERATION_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 15_000;
const PERMISSION_TIMEOUT_MS = 60_000;
const CLEANUP_RETRY_DELAY_MS = 1_000;

type PushSupport = "checking" | "ready" | "unavailable" | "error";
type Feedback = { text: string; tone: "notice" | "error" } | null;

function bytes(value: string) {
  const padded = value
    .padEnd(Math.ceil(value.length / 4) * 4, "=")
    .replaceAll("-", "+")
    .replaceAll("_", "/");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function abortError() {
  return new DOMException("The notification operation was cancelled.", "AbortError");
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function withTimeout<T>(
  promise: PromiseLike<T>,
  timeoutMs: number,
  message: string,
  signal?: AbortSignal,
) {
  if (signal?.aborted) return Promise.reject<T>(abortError());

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timeout = window.setTimeout(
      () => settle(() => reject(new Error(message))),
      timeoutMs,
    );

    function cleanup() {
      window.clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    }
    function settle(complete: () => void) {
      if (settled) return;
      settled = true;
      cleanup();
      complete();
    }
    function onAbort() {
      settle(() => reject(abortError()));
    }

    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    Promise.resolve(promise).then(
      (value) => settle(() => resolve(value)),
      (error) => settle(() => reject(error)),
    );
  });
}

async function pushRequest(input: RequestInfo | URL, init: RequestInit, signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();

  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (signal?.aborted) throw abortError();
    if (timedOut) {
      throw new Error("The notification request timed out. Check your connection and try again.");
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function responseError(response: Response, fallback: string, signal?: AbortSignal) {
  try {
    const payload = await withTimeout(
      response.json().catch(() => null) as Promise<{ error?: string } | null>,
      REQUEST_TIMEOUT_MS,
      fallback,
      signal,
    );
    return payload?.error ?? fallback;
  } catch (error) {
    if (isAbortError(error)) throw error;
    return fallback;
  }
}

async function storeSubscription(subscription: PushSubscription, signal?: AbortSignal) {
  const response = await pushRequest("/api/push/subscription", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(subscription),
  }, signal);
  if (!response.ok) {
    throw new Error(await responseError(
      response,
      "Push notifications could not be saved.",
      signal,
    ));
  }
}

async function removeServerSubscription(endpoint: string, signal?: AbortSignal) {
  const response = await pushRequest("/api/push/subscription", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint }),
  }, signal);
  if (!response.ok) {
    throw new Error(await responseError(
      response,
      "The server subscription could not be removed.",
      signal,
    ));
  }
}

async function readyRegistration(signal?: AbortSignal) {
  return withTimeout(
    navigator.serviceWorker.ready,
    READY_TIMEOUT_MS,
    "The notification service did not become ready in time.",
    signal,
  );
}

async function currentSubscription(
  registration: ServiceWorkerRegistration,
  signal?: AbortSignal,
) {
  return withTimeout(
    registration.pushManager.getSubscription(),
    BROWSER_OPERATION_TIMEOUT_MS,
    "The browser did not finish checking notification status.",
    signal,
  );
}

async function rollbackSubscription(
  registration: ServiceWorkerRegistration,
  subscription: PushSubscription,
) {
  let browserClean = false;
  let serverClean = false;

  try {
    await withTimeout(
      subscription.unsubscribe(),
      BROWSER_OPERATION_TIMEOUT_MS,
      "The browser did not finish removing the notification subscription.",
    );
    const remaining = await currentSubscription(registration);
    browserClean = remaining?.endpoint !== subscription.endpoint;
  } catch {
    // The server cleanup below still prevents this failed attempt from being
    // treated as enabled by Baker Street.
  }

  // The POST may have committed after the client timed out. Delete once now
  // and once after a short delay so a late upsert cannot recreate an orphaned
  // server record after the first cleanup request wins the race.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) {
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, CLEANUP_RETRY_DELAY_MS);
      });
    }
    try {
      await removeServerSubscription(subscription.endpoint);
      serverClean = true;
    } catch {
      serverClean = false;
    }
  }

  return browserClean && serverClean;
}

async function createSubscription(
  registration: ServiceWorkerRegistration,
  applicationServerKey: string,
  signal: AbortSignal,
) {
  let abandoned = false;
  const pending = registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: bytes(applicationServerKey),
  });

  // PushManager operations cannot be aborted. If our bounded wrapper stops
  // waiting, remove a subscription that the browser creates afterward.
  void pending.then((subscription) => {
    if (abandoned) void rollbackSubscription(registration, subscription);
  }, () => undefined);

  try {
    return await withTimeout(
      pending,
      BROWSER_OPERATION_TIMEOUT_MS,
      "The browser did not finish creating the notification subscription.",
      signal,
    );
  } catch (error) {
    abandoned = true;
    throw error;
  }
}

export function PushNotifications() {
  const [support, setSupport] = useState<PushSupport>("checking");
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState<"enabling" | "disabling" | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const lifecycleRef = useRef<AbortController | null>(null);
  const operationRef = useRef<symbol | null>(null);

  useEffect(() => {
    const lifecycle = new AbortController();
    lifecycleRef.current = lifecycle;

    const isCurrent = () => lifecycleRef.current === lifecycle && !lifecycle.signal.aborted;

    async function checkSupport() {
      const available = "serviceWorker" in navigator
        && "PushManager" in window
        && "Notification" in window
        && Boolean(key);
      if (!available) {
        if (isCurrent()) setSupport("unavailable");
        return;
      }

      try {
        const registration = await readyRegistration(lifecycle.signal);
        const subscription = await currentSubscription(registration, lifecycle.signal);

        // A browser subscription alone is not enough to claim that delivery
        // is enabled. Reconcile it with the authenticated server record first.
        if (subscription) await storeSubscription(subscription, lifecycle.signal);
        if (!isCurrent()) return;
        setEnabled(Boolean(subscription));
        setSupport("ready");
        setFeedback(null);
      } catch (error) {
        if (!isCurrent() || isAbortError(error)) return;
        setEnabled(false);
        setSupport("error");
        setFeedback({
          tone: "error",
          text: `${errorMessage(error, "Push notification status could not be verified.")} Select Retry push setup to try again.`,
        });
      }
    }

    void checkSupport();
    return () => {
      lifecycle.abort();
      operationRef.current = null;
      if (lifecycleRef.current === lifecycle) lifecycleRef.current = null;
    };
  }, []);

  async function enable() {
    const lifecycle = lifecycleRef.current;
    if (
      !lifecycle
      || lifecycle.signal.aborted
      || operationRef.current
      || !key
      || (support !== "ready" && support !== "error")
    ) return;

    const operation = Symbol("enable-push");
    operationRef.current = operation;
    setBusy("enabling");
    setFeedback(null);

    let registration: ServiceWorkerRegistration | null = null;
    let subscription: PushSubscription | null = null;
    let created = false;

    try {
      if (Notification.permission === "denied") {
        throw new Error("Notifications are blocked in browser settings.");
      }
      if (Notification.permission !== "granted") {
        const permission = await withTimeout(
          Notification.requestPermission(),
          PERMISSION_TIMEOUT_MS,
          "The browser did not finish asking for notification permission.",
          lifecycle.signal,
        );
        if (permission !== "granted") {
          throw new Error("Notification permission was not granted.");
        }
      }

      registration = await readyRegistration(lifecycle.signal);
      const existing = await currentSubscription(registration, lifecycle.signal);
      subscription = existing ?? await createSubscription(registration, key, lifecycle.signal);
      created = !existing;
      await storeSubscription(subscription, lifecycle.signal);
      if (lifecycle.signal.aborted) throw abortError();

      setEnabled(true);
      setSupport("ready");
      setFeedback({ text: "Push notifications enabled on this device.", tone: "notice" });
      void pushRequest("/api/push/test", { method: "POST" }, lifecycle.signal)
        .catch(() => undefined);
    } catch (error) {
      let rollbackClean = true;
      if (created && registration && subscription) {
        rollbackClean = await rollbackSubscription(registration, subscription);
      }

      if (!lifecycle.signal.aborted && !isAbortError(error)) {
        setEnabled(false);
        setSupport("error");
        setFeedback({
          tone: "error",
          text: rollbackClean
            ? `${errorMessage(error, "Push could not be enabled.")} You can safely try again.`
            : `${errorMessage(error, "Push could not be enabled.")} Cleanup could not be fully confirmed; refresh before trying again.`,
        });
      }
    } finally {
      if (operationRef.current === operation) operationRef.current = null;
      if (!lifecycle.signal.aborted) setBusy(null);
    }
  }

  async function disable() {
    const lifecycle = lifecycleRef.current;
    if (
      !lifecycle
      || lifecycle.signal.aborted
      || operationRef.current
      || (support !== "ready" && support !== "error")
    ) return;

    const operation = Symbol("disable-push");
    operationRef.current = operation;
    setBusy("disabling");
    setFeedback(null);

    let browserDisabled = false;

    try {
      const registration = await readyRegistration(lifecycle.signal);
      const subscription = await currentSubscription(registration, lifecycle.signal);
      if (!subscription) {
        setEnabled(false);
        setSupport("ready");
        setFeedback({ text: "Push notifications are already disabled on this device.", tone: "notice" });
        return;
      }

      await withTimeout(
        subscription.unsubscribe(),
        BROWSER_OPERATION_TIMEOUT_MS,
        "The browser did not finish disabling notifications.",
        lifecycle.signal,
      );
      const remaining = await currentSubscription(registration, lifecycle.signal);
      if (remaining?.endpoint === subscription.endpoint) {
        throw new Error("The browser could not confirm that notifications were disabled.");
      }
      if (remaining) {
        throw new Error("The browser changed its notification subscription. Try disabling again.");
      }
      browserDisabled = true;

      // Delete only after the browser has confirmed it can no longer receive.
      await removeServerSubscription(subscription.endpoint, lifecycle.signal);
      setEnabled(false);
      setSupport("ready");
      setFeedback({ text: "Push notifications disabled on this device.", tone: "notice" });
    } catch (error) {
      if (!lifecycle.signal.aborted && !isAbortError(error)) {
        setEnabled(!browserDisabled);
        setSupport(browserDisabled ? "ready" : "error");
        setFeedback({
          tone: "error",
          text: browserDisabled
            ? "Notifications are off on this device, but the old server record could not be removed. It can no longer deliver and will be cleaned up when rejected by the push provider."
            : `${errorMessage(error, "Push could not be disabled.")} Notifications remain enabled; try again.`,
        });
      }
    } finally {
      if (operationRef.current === operation) operationRef.current = null;
      if (!lifecycle.signal.aborted) setBusy(null);
    }
  }

  const label = support === "checking"
    ? "Checking support…"
    : support === "unavailable"
      ? "Not supported on this device"
      : busy === "enabling"
        ? "Enabling notifications…"
        : busy === "disabling"
          ? "Disabling notifications…"
          : support === "error"
            ? enabled
              ? "Retry disabling notifications"
              : "Retry push setup"
            : enabled
              ? "Disable notifications"
              : "Enable notifications";

  return (
    <section className="card p-4" aria-busy={busy !== null || support === "checking"}>
      <h2 className="text-sm font-semibold">Mobile push notifications</h2>
      <p className="mt-1 text-xs text-[var(--ink-secondary)]">
        Receive work-queue alerts even when the app is closed. Patient details are not included in lock-screen messages.
      </p>
      <button
        type="button"
        disabled={support === "checking" || support === "unavailable" || busy !== null}
        onClick={enabled ? disable : enable}
        className="mt-4 inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-[var(--brand)] px-4 text-sm font-medium text-white disabled:cursor-wait disabled:opacity-60"
      >
        {(busy || support === "checking") && (
          <span
            aria-hidden
            className="size-4 shrink-0 animate-spin rounded-full border-2 border-white/40 border-t-white motion-reduce:animate-none"
          />
        )}
        {label}
      </button>
      <span className="sr-only" role="status" aria-live="polite">
        {busy ? label : support === "checking" ? label : ""}
      </span>
      {feedback && (
        <p
          role={feedback.tone === "error" ? "alert" : "status"}
          className={`mt-2 text-xs ${feedback.tone === "error" ? "text-[var(--status-critical)]" : "text-[var(--ink-secondary)]"}`}
        >
          {feedback.text}
        </p>
      )}
    </section>
  );
}
