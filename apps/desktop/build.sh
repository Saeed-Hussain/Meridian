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
