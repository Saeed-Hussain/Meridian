/**
 * The workspace packages are plain ES modules that ship no build output, so
 * Next has to compile them along with the app rather than treating them as
 * prebuilt dependencies.
 *
 * @type {import('next').NextConfig}
 */
const config = {
  transpilePackages: ['@meridian/core', '@meridian/sync', '@meridian/storage-idb'],
};

export default config;
