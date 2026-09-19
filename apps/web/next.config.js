/**
 * The workspace packages are plain ES modules that ship no build output, so
 * Next has to compile them along with the app rather than treating them as
 * prebuilt dependencies.
 *
 * @type {import('next').NextConfig}
 */
const config = {
  transpilePackages: [
    '@meridian/core',
    '@meridian/sync',
    '@meridian/storage-idb',
    '@meridian/storage-bridge',
  ],

  // The desktop build is a folder of files with no server behind it, so it is
  // exported rather than served. Only the desktop build sets this; the web
  // build stays an ordinary Next application.
  output: process.env.NEXT_OUTPUT === 'export' ? 'export' : undefined,

  // Without this an exported page asks for `/doc/index.html` as `/doc`, which
  // is a directory on disk and loads nothing when opened from a file.
  trailingSlash: process.env.NEXT_OUTPUT === 'export',

  // The floating dev badge sits on top of the footer and lands in every
  // screenshot taken from a dev server. Nothing is lost by hiding it.
  devIndicators: false,
};

export default config;
