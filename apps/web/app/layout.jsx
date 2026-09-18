import './globals.css';

export const metadata = {
  title: 'Meridian',
  description: 'A shared workspace that keeps working when the internet does not.',
};

/**
 * @param {{children: React.ReactNode}} props
 */
export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
