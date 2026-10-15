import { useEffect, useState } from "react";

/**
 * Current time, refreshed at every full minute (and when the tab becomes
 * visible again, since timers are throttled in background tabs). Drives the
 * now-line, "today" and the "Next up" countdown.
 */
export function useMinuteClock(): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let timer: number | undefined;
    const schedule = () => {
      const current = new Date();
      const msToNextMinute = 60_000 - (current.getSeconds() * 1000 + current.getMilliseconds());
      timer = window.setTimeout(() => {
        setNow(new Date());
        schedule();
      }, msToNextMinute + 50);
    };
    const resync = () => {
      if (document.visibilityState !== "visible") return;
      window.clearTimeout(timer);
      setNow(new Date());
      schedule();
    };
    schedule();
    document.addEventListener("visibilitychange", resync);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", resync);
    };
  }, []);

  return now;
}
