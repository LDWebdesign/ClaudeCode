const pad = (n: number, w = 2) => String(Math.floor(n)).padStart(w, '0');

/** Elapsed seconds as H:MM:SS (or MM:SS under an hour). */
export function elapsed(seconds: number, alwaysHours = false): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 || alwaysHours ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

/** Timecode with frames, for the camera HUD. */
export function timecode(seconds: number, fps = 30): string {
  const s = Math.max(0, seconds);
  return `${elapsed(s, true)}:${pad((s % 1) * fps)}`;
}

/** Wall-clock time such as "11:42 PM", in the device locale. */
export function clockTime(epochMs: number, withSeconds = false): string {
  return new Date(epochMs).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    ...(withSeconds ? { second: '2-digit' } : {}),
  });
}

export function longDate(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function uid(prefix = ''): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}${Date.now().toString(36)}${rand}`;
}
