import './globals.css';
import { NO_FLASH } from './theme.jsx';

export const metadata = {
  title: 'Meridian',
  description: 'A shared workspace that keeps working when the internet does not.',
};

export const viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0b0b0c' },
  ],
};

/**
 * @param {{children: React.ReactNode}} props
 */
export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/*
          The theme has to be on the element before anything is painted.
          Setting it in React instead means the page renders light first and
          then snaps to dark, which is the flash everyone recognises. This runs
          synchronously, before the body exists.
        */}
        <script dangerouslySetInnerHTML={{ __html: NO_FLASH }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
