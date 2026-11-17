#!/bin/sh
set -eu
# Fail startup without a usable signature database; never silently bypass antivirus.
freshclam --stdout --log=/tmp/freshclam.log --datadir=/var/lib/clamav
touch /tmp/av-updated
(
  while true; do
    sleep 21600
    if freshclam --stdout --log=/tmp/freshclam.log --datadir=/var/lib/clamav; then touch /tmp/av-updated; fi
  done
) &
exec bun src/documents/processor_server.ts
