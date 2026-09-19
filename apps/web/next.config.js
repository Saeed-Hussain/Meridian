/**
 * The workspace packages are plain ES modules that ship no build output, so
 * Next has to compile them along with the app rather than treating them as
 * prebuilt dependencies.
 *
 * @type {import('next').NextConfig}
 */
const config = {
  transpilePackages: ['@meridian/core', '@meridian/sync', '@meridian/storage-idb'],

  // The floating dev badge sits on top of the footer and lands in every
  // screenshot taken from a dev server. Nothing is lost by hiding it.
  devIndicators: false,
};

export default config;
