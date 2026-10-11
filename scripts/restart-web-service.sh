#!/bin/sh
# Hand off the restart before the calling Web service and its tools are stopped.
set -eu

if [ "$#" -gt 1 ]; then
    echo "Usage: $0 [dsh-web.service|other.service]" >&2
    exit 2
fi
service=${1:-dsh-web.service}
case "$service" in
    -*|*[!a-zA-Z0-9_.@-]*)
        echo 'Expected a systemd service name, without paths or options.' >&2
        exit 2
        ;;
esac
case "$service" in
    *.service) ;;
    *) echo 'Expected a unit name ending in .service.' >&2; exit 2 ;;
esac

# A transient service is independent of the caller's cgroup. Do not use
# --scope, which keeps the work attached to the caller's process lifecycle.
systemd-run --user --collect --no-block --property=Type=oneshot \
    --description="Restart $service independently of its tools" \
    -- systemctl --user restart -- "$service"
