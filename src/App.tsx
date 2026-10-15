import { useCallback, useEffect, useState } from "react";
import {
  clearAuthToken,
  getCurrentUser,
  HttpError,
  login,
  setAuthToken,
  type AuthUser,
} from "./api/client";
import DatabaseInspectorPage from "./pages/DatabaseInspectorPage";
import LoginPage from "./pages/LoginPage";
import PrintWeekPage from "./pages/PrintWeekPage";
import PrintWeeksPage from "./pages/PrintWeeksPage";
import PublicWeekPage from "./pages/PublicWeekPage";
import WeeklySchedulePage from "./pages/WeeklySchedulePage";
import { APP_BUILD, APP_VERSION } from "./version";

/** Subtle build identifier at the bottom of the app. Not rendered on
 * print/public/export routes to keep those documents clean, and hidden on
 * phones, where it would sit on right-aligned plan content (hours). */
function VersionBadge() {
  return (
    <div
      className="pointer-events-none fixed bottom-1 right-2 z-50 hidden select-none text-[10px] tabular-nums text-slate-400/80 dark:text-slate-500/80 sm:block"
      aria-label={`App version ${APP_VERSION} build ${APP_BUILD}`}
    >
      v{APP_VERSION} ({APP_BUILD})
    </div>
  );
}

export default function App() {
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    if (typeof window === "undefined") return "light";
    const stored = window.localStorage.getItem("theme");
    if (stored === "light" || stored === "dark") return stored;
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });

  const [serverUnreachable, setServerUnreachable] = useState(false);

  const checkSession = useCallback(() => {
    setLoading(true);
    setServerUnreachable(false);
    getCurrentUser()
      .then((user) => setCurrentUser(user))
      .catch((error) => {
        // Only drop the token when the server rejects it (401 invalid/expired,
        // 403 disabled). Transient failures (deploy restart, network) keep it
        // and offer a retry instead of the login page.
        if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
          clearAuthToken();
        } else {
          setServerUnreachable(true);
        }
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    checkSession();
  }, [checkSession]);

  useEffect(() => {
    const handler = () => setCurrentUser(null);
    window.addEventListener("auth-expired", handler);
    return () => window.removeEventListener("auth-expired", handler);
  }, []);

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.classList.toggle("dark", theme === "dark");
    window.localStorage.setItem("theme", theme);
  }, [theme]);

  const pathname = typeof window !== "undefined" ? window.location.pathname : "";
  const isPrintWeekRoute = pathname.startsWith("/print/week");
  const isPrintWeeksRoute = pathname.startsWith("/print/weeks");
  const isDbInspectorRoute = pathname === "/db-inspector";
  const publicMatch = pathname.match(/^\/public\/([^/]+)\/?$/);

  if (isPrintWeekRoute || isPrintWeeksRoute || isDbInspectorRoute) {
    if (loading) {
      return (
        <div className="min-h-screen bg-white px-6 py-10 text-sm text-slate-500">
          Loading...
        </div>
      );
    }
    if (!currentUser) {
      return (
        <div className="min-h-screen bg-white px-6 py-10 text-sm text-rose-600">
          Unauthorized.
        </div>
      );
    }
    if (isDbInspectorRoute) {
      return (
        <DatabaseInspectorPage
          theme={theme}
          onBack={() => {
            window.location.href = "/";
          }}
        />
      );
    }
    return isPrintWeeksRoute ? <PrintWeeksPage theme={theme} /> : <PrintWeekPage theme={theme} />;
  }

  if (publicMatch) {
    return <PublicWeekPage token={publicMatch[1]} theme={theme} />;
  }

  const toggleTheme = () =>
    setTheme((prev) => (prev === "dark" ? "light" : "dark"));

  const handleLogin = async (username: string, password: string) => {
    const result = await login(username, password);
    setAuthToken(result.access_token);
    setCurrentUser(result.user);
  };

  const handleLogout = () => {
    clearAuthToken();
    setCurrentUser(null);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
        <div className="mx-auto flex min-h-screen max-w-xl items-center px-6 text-slate-600 dark:text-slate-300">
          Loading...
        </div>
      </div>
    );
  }

  if (!currentUser && serverUnreachable) {
    return (
      <>
        <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
          <div className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-4 px-6 text-slate-600 dark:text-slate-300">
            <p role="alert">
              The server is not reachable right now (it may be restarting). You are
              still signed in; please try again in a moment.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={checkSession}
                className="rounded-xl bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-700"
              >
                Retry
              </button>
              <button
                type="button"
                onClick={() => setServerUnreachable(false)}
                className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                Go to sign in
              </button>
            </div>
          </div>
        </div>
        <VersionBadge />
      </>
    );
  }

  if (!currentUser) {
    return (
      <>
        <LoginPage onLogin={handleLogin} theme={theme} onToggleTheme={toggleTheme} />
        <VersionBadge />
      </>
    );
  }

  return (
    <>
      <WeeklySchedulePage
        currentUser={currentUser}
        onLogout={handleLogout}
        theme={theme}
        onToggleTheme={toggleTheme}
      />
      <VersionBadge />
    </>
  );
}
