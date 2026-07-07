"use client";

import { useCallback, useEffect, useState } from "react";

export type AppLanguage = "zh" | "en";

export const APP_LANGUAGE_STORAGE_KEY = "gpt_upi_lang";

function detectBrowserLanguage(): AppLanguage {
  if (typeof window === "undefined") return "zh";
  return window.navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function useAppLanguage() {
  const [language, setLanguage] = useState<AppLanguage>("zh");

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const saved = window.localStorage.getItem(APP_LANGUAGE_STORAGE_KEY);
      if (saved === "zh" || saved === "en") {
        setLanguage(saved);
        return;
      }

      setLanguage(detectBrowserLanguage());
    }, 0);

    return () => window.clearTimeout(timer);
  }, []);

  const toggleLanguage = useCallback(() => {
    setLanguage((current) => {
      const next = current === "zh" ? "en" : "zh";
      window.localStorage.setItem(APP_LANGUAGE_STORAGE_KEY, next);
      return next;
    });
  }, []);

  return { language, setLanguage, toggleLanguage };
}
