'use client';

import { useEffect, useState } from 'react';

/**
 * Light and dark, remembered.
 *
 * The theme is written to `data-theme` on the root element, which is the only
 * thing the stylesheet reads. Nothing else in the app knows or cares which
 * theme is on.
 */

/** Runs before the first paint. See the note in `layout.jsx`. */
export const NO_FLASH = `
(function () {
  try {
    var saved = localStorage.getItem('meridian-theme');
    var system = matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme =
      saved || (system ? 'dark' : 'light');
  } catch (e) {
    document.documentElement.dataset.theme = 'light';
  }
})();
`;

export function ThemeToggle() {
  const [theme, setTheme] = useState('light');

  // Read what the pre-paint script already decided, rather than deciding
  // again — otherwise the button and the page could disagree for a moment.
  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  }, []);

  /** @param {string} next */
  const apply = (next) => {
    document.documentElement.dataset.theme = next;
    setTheme(next);
    try {
      localStorage.setItem('meridian-theme', next);
    } catch {
      // A browser with storage switched off still gets the theme, just not
      // the memory of it. Not worth telling anyone about.
    }
  };

  const dark = theme === 'dark';

  return (
    <button
      type="button"
      className="theme"
      onClick={() => apply(dark ? 'light' : 'dark')}
      aria-label={dark ? 'Switch to light' : 'Switch to dark'}
      title={dark ? 'Switch to light' : 'Switch to dark'}
    >
      {dark ? <Sun /> : <Moon />}
    </button>
  );
}

function Sun() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <circle cx="12" cy="12" r="4.2" />
      <path
        strokeLinecap="round"
        d="M12 2.6v2.2M12 19.2v2.2M21.4 12h-2.2M4.8 12H2.6M18.6 5.4l-1.6 1.6M7 17l-1.6 1.6M18.6 18.6L17 17M7 7L5.4 5.4"
      />
    </svg>
  );
}

function Moon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M20 14.2A8.4 8.4 0 0 1 9.8 4a8.4 8.4 0 1 0 10.2 10.2Z"
      />
    </svg>
  );
}
