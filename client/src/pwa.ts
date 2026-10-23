import { useCallback, useEffect, useRef, useState } from "react";

const PWA_UPDATE_READY_EVENT = "senderi:pwa-update-ready";
const UPDATE_NOTIFICATION_SHOWN_KEY = "senderi:pwa-update-notification-shown";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

interface NavigatorWithStandalone extends Navigator {
  standalone?: boolean;
}

function isStandalone(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches ||
    (window.navigator as NavigatorWithStandalone).standalone === true;
}

export function registerSenderiServiceWorker(): void {
  if (!("serviceWorker" in navigator) || !import.meta.env.PROD) return;

  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/service-worker.js", { scope: "/" }).then((registration) => {
      const announceWaitingWorker = () => {
        if (!registration.waiting) {
          try {
            window.localStorage.removeItem(UPDATE_NOTIFICATION_SHOWN_KEY);
          } catch {
            // Update notifications still work when browser storage is disabled.
          }
          return;
        }
        window.dispatchEvent(new Event(PWA_UPDATE_READY_EVENT));
        if (
          window.matchMedia("(max-width: 640px)").matches &&
          "Notification" in window &&
          Notification.permission === "granted"
        ) {
          try {
            if (window.localStorage.getItem(UPDATE_NOTIFICATION_SHOWN_KEY) === "true") return;
            window.localStorage.setItem(UPDATE_NOTIFICATION_SHOWN_KEY, "true");
          } catch {
            // Continue with the system notification if browser storage is disabled.
          }
          void registration.showNotification("Senderi update ready", {
            body: "A new version is ready. Open Senderi and tap Update now.",
            icon: "/senderi-symbol.png",
            badge: "/senderi-symbol.png",
            tag: "senderi-app-update",
            data: { url: "/" },
          }).catch(() => {
            try {
              window.localStorage.removeItem(UPDATE_NOTIFICATION_SHOWN_KEY);
            } catch {
              // Ignore storage failures after a notification delivery failure.
            }
          });
        }
      };
      const watchInstallingWorker = () => {
        const installing = registration.installing;
        installing?.addEventListener("statechange", announceWaitingWorker);
      };

      announceWaitingWorker();
      registration.addEventListener("updatefound", watchInstallingWorker);
      window.addEventListener("focus", () => { void registration.update().catch(() => undefined); });
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") void registration.update().catch(() => undefined);
      });
      window.setInterval(() => { void registration.update().catch(() => undefined); }, 60 * 60 * 1000);
    }).catch((error: unknown) => {
      console.error("Senderi service worker registration failed.", error);
    });
  }, { once: true });
}

export function usePwaUpdate() {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [updating, setUpdating] = useState(false);
  const reloadAfterUpdateRef = useRef(false);

  useEffect(() => {
    if (!("serviceWorker" in navigator) || !import.meta.env.PROD) return;
    let active = true;
    const announceUpdate = () => setUpdateAvailable(true);
    const reloadAfterControllerChange = () => {
      if (reloadAfterUpdateRef.current) window.location.reload();
    };

    window.addEventListener(PWA_UPDATE_READY_EVENT, announceUpdate);
    navigator.serviceWorker.addEventListener("controllerchange", reloadAfterControllerChange);
    void navigator.serviceWorker.getRegistration("/").then((registration) => {
      if (active && registration?.waiting) setUpdateAvailable(true);
    }).catch(() => undefined);

    return () => {
      active = false;
      window.removeEventListener(PWA_UPDATE_READY_EVENT, announceUpdate);
      navigator.serviceWorker.removeEventListener("controllerchange", reloadAfterControllerChange);
    };
  }, []);

  const applyUpdate = useCallback(async () => {
    if (!("serviceWorker" in navigator)) return;
    setUpdating(true);
    try {
      const registration = await navigator.serviceWorker.getRegistration("/");
      if (registration?.waiting) {
        reloadAfterUpdateRef.current = true;
        registration.waiting.postMessage({ type: "SKIP_WAITING" });
      } else {
        window.location.reload();
      }
    } catch {
      setUpdating(false);
    }
  }, []);

  const dismissUpdate = useCallback(() => setUpdateAvailable(false), []);
  return { updateAvailable, updating, applyUpdate, dismissUpdate };
}

export function usePwaInstall() {
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState(() => isStandalone());

  useEffect(() => {
    function captureInstallPrompt(event: Event) {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
    }

    function markInstalled() {
      setInstallPrompt(null);
      setIsInstalled(true);
    }

    const displayMode = window.matchMedia("(display-mode: standalone)");
    const syncDisplayMode = () => setIsInstalled(isStandalone());

    window.addEventListener("beforeinstallprompt", captureInstallPrompt);
    window.addEventListener("appinstalled", markInstalled);
    displayMode.addEventListener("change", syncDisplayMode);
    return () => {
      window.removeEventListener("beforeinstallprompt", captureInstallPrompt);
      window.removeEventListener("appinstalled", markInstalled);
      displayMode.removeEventListener("change", syncDisplayMode);
    };
  }, []);

  const install = useCallback(async (): Promise<"accepted" | "dismissed" | "unavailable"> => {
    if (!installPrompt) return "unavailable";

    await installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    setInstallPrompt(null);
    if (outcome === "accepted") setIsInstalled(true);
    return outcome;
  }, [installPrompt]);

  return { canInstall: installPrompt !== null, install, isInstalled };
}
