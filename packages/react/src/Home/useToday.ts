import { useEffect, useState } from 'react';
import { localDateOf, type LocalDate } from '@bendyline/docblocks/properties';

/**
 * Today's date on the person's calendar, moving on at midnight and whenever
 * the page comes back into view (a laptop opened the next morning never ran
 * the midnight timer).
 */
export function useToday(now: () => Date = () => new Date()): LocalDate {
  const [today, setToday] = useState(() => localDateOf(now()));
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const check = () => {
      const current = now();
      setToday(localDateOf(current));
      if (timer !== null) clearTimeout(timer);
      const midnight = new Date(current);
      midnight.setHours(24, 0, 1, 0);
      // Capped, so a clock change or a sleeping machine is caught within the hour.
      timer = setTimeout(check, Math.min(midnight.getTime() - current.getTime(), 3_600_000));
    };
    check();
    const onVisible = () => {
      if (document.visibilityState === 'visible') check();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
    // `now` is a test seam; a new function each render must not restart the timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return today;
}
