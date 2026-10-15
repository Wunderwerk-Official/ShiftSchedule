import { useState, type FormEvent } from "react";
import { HttpError } from "../api/client";
import { cx } from "../lib/classNames";

type LoginPageProps = {
  onLogin: (username: string, password: string) => Promise<void>;
  theme: "light" | "dark";
  onToggleTheme: () => void;
};

export default function LoginPage({ onLogin, theme, onToggleTheme }: LoginPageProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await onLogin(username.trim(), password);
    } catch (err) {
      // Only a 401 means wrong credentials; network errors and 5xx (e.g.
      // during a deploy) must not tell staff their password is wrong.
      setError(
        err instanceof HttpError && err.status === 401
          ? "Login failed. Check your username and password."
          : "Could not reach the server. Please try again in a moment.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      <div className="mx-auto flex min-h-screen max-w-xl items-center px-6">
        <div className="relative w-full rounded-3xl border border-slate-200 bg-white p-8 shadow-sm dark:border-slate-700 dark:bg-slate-900">
          <button
            type="button"
            onClick={onToggleTheme}
            aria-label="Toggle theme"
            className={cx(
              "absolute right-6 top-6 rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-600",
              "hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800",
            )}
          >
            {theme === "dark" ? "☀" : "☾"}
          </button>
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
            Sign in
          </h1>

          <form onSubmit={handleSubmit} className="mt-6 space-y-4">
            <div>
              <label
                htmlFor="login-username"
                className="text-sm font-semibold text-slate-700 dark:text-slate-200"
              >
                Username
              </label>
              <input
                id="login-username"
                type="text"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                className={cx(
                  "mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 text-sm",
                  "focus:border-sky-300 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100",
                )}
                autoComplete="username"
                required
              />
            </div>
            <div>
              <label
                htmlFor="login-password"
                className="text-sm font-semibold text-slate-700 dark:text-slate-200"
              >
                Password
              </label>
              <div className="relative mt-2">
                <input
                  id="login-password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className={cx(
                    "w-full rounded-xl border border-slate-200 px-4 py-3 pr-14 text-sm",
                    "focus:border-sky-300 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100",
                  )}
                  autoComplete="current-password"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((prev) => !prev)}
                  aria-pressed={showPassword}
                  className={cx(
                    "absolute right-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-slate-500",
                    "hover:text-slate-700 dark:text-slate-300 dark:hover:text-slate-100",
                  )}
                >
                  {showPassword ? "Hide" : "Show"}
                </button>
              </div>
            </div>

            {error ? (
              <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-500/40 dark:bg-rose-900/40 dark:text-rose-200">
                {error}
              </div>
            ) : null}

            <button
              type="submit"
              disabled={submitting}
              className={cx(
                "w-full rounded-xl bg-sky-600 px-4 py-3 text-sm font-semibold text-white",
                "hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-70",
              )}
            >
              {submitting ? "Signing in..." : "Sign in"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
