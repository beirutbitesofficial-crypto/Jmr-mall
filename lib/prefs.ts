"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { Lang } from "@/lib/i18n";

export type Theme = "light" | "dark";
type Prefs = { lang: Lang; theme: Theme };

const LANG_KEY = "jmr-lang";
const THEME_KEY = "jmr-theme";
const listeners = new Set<() => void>();
let cached: string | null = null;

// localStorage can throw (private mode, blocked storage); the app must still work.
function readStorage(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function writeStorage(key: string, value: string) {
  try { window.localStorage.setItem(key, value); } catch { /* preference just isn't remembered */ }
}

function snapshot(): string {
  const lang: Lang = readStorage(LANG_KEY) === "ar" ? "ar" : "en";
  const stored = readStorage(THEME_KEY);
  const theme: Theme = stored === "dark" || stored === "light" ? stored
    : window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  const next = `${lang}|${theme}`;
  if (next !== cached) cached = next;
  return cached;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => { listeners.delete(listener); window.removeEventListener("storage", listener); };
}

// English and light on the server; the inline script in the layout applies the stored choice
// before the first paint, so there is no flash of the wrong language or theme.
export function usePrefs() {
  const value = useSyncExternalStore(subscribe, snapshot, () => "en|light");
  const [lang, theme] = value.split("|") as [Lang, Theme];
  useEffect(() => {
    const root = document.documentElement;
    root.lang = lang;
    root.dir = lang === "ar" ? "rtl" : "ltr";
    root.dataset.theme = theme;
  }, [lang, theme]);
  const set = useCallback((next: Partial<Prefs>) => {
    if (next.lang) writeStorage(LANG_KEY, next.lang);
    if (next.theme) writeStorage(THEME_KEY, next.theme);
    listeners.forEach(listener => listener());
  }, []);
  return {
    lang, theme,
    toggleLang: () => set({ lang: lang === "ar" ? "en" : "ar" }),
    toggleTheme: () => set({ theme: theme === "dark" ? "light" : "dark" }),
  };
}
