#!/bin/sh
# Fixture stand-in for curl in tests/provider_cli.rs.
#
# rdsh invokes `curl -q --config -`, so the request URL arrives on stdin as a
# config line rather than in argv. Answer GET {base}/models with a model list
# and fail every other request closed, so --discover never reaches a network.
config=$(cat)
url=$(printf '%s\n' "$config" | sed -n 's/^url = "\(.*\)"$/\1/p' | head -1)
case "$url" in
  */models) printf '{"data":[{"id":"fixture-model"}]}' ;;
  *)
    printf 'fixture curl: unexpected request %s\n' "$url" >&2
    exit 22
    ;;
esac
