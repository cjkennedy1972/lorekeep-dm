import { useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';
export type TextSize = 'normal' | 'large' | 'xlarge';
export interface Prefs {
  theme: Theme;
  palette: 'default' | 'cvd';
  textSize: TextSize;
  dyslexiaFont: boolean;
}

const KEY = 'lorekeep.prefs';

export function loadPrefs(): Prefs {
  const dark =
    typeof matchMedia === 'function' &&
    matchMedia('(prefers-color-scheme: dark)').matches;
  const base: Prefs = {
    theme: dark ? 'dark' : 'light',
    palette: 'default',
    textSize: 'normal',
    dyslexiaFont: false,
  };
  try {
    return { ...base, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return base;
  }
}

export function applyPrefs(p: Prefs) {
  const d = document.documentElement.dataset;
  d.theme = p.theme;
  d.palette = p.palette;
  d.textSize = p.textSize;
  d.dyslexiaFont = p.dyslexiaFont ? 'on' : 'off';
}

export function usePrefs() {
  const [prefs, setPrefs] = useState(loadPrefs);
  useEffect(() => {
    applyPrefs(prefs);
    localStorage.setItem(KEY, JSON.stringify(prefs));
  }, [prefs]);
  return [
    prefs,
    (patch: Partial<Prefs>) => setPrefs((p) => ({ ...p, ...patch })),
  ] as const;
}
