#!/usr/bin/env bash
# Put a fresh copy of the exported interface next to the application.
#
# The desktop build is the same web app with no server behind it, so it is
# exported to a folder of files and copied in here rather than being served.
set -euo pipefail
cd "$(dirname "$0")/../.."

NEXT_OUTPUT=export npm run build --workspace @meridian/web
rm -rf apps/desktop/web
cp -r apps/web/out apps/desktop/web
echo "interface copied into apps/desktop/web"

# The SQLite store, copied in rather than resolved as a workspace package.
#
# The packaged application is a sealed archive of whatever the build lists, and
# a workspace dependency is a symlink into a folder outside it. Left as an
# import, it disappeared from the installer -- which then started perfectly and
# failed the moment anybody opened a document. It has no dependencies of its
# own, so a copy is the whole of it.
rm -rf apps/desktop/vendor
mkdir -p apps/desktop/vendor
cp packages/storage-sql/src/index.js apps/desktop/vendor/storage-sql.mjs
echo "storage adapter copied into apps/desktop/vendor"
