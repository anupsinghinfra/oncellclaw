#!/usr/bin/env bash
# The uninstaller lives in the setup driver now (setup/uninstall/).
exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/nanoclaw.sh" --uninstall "$@"
