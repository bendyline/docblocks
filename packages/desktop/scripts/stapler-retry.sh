#!/usr/bin/env bash
# Usage: stapler-retry.sh <staple|validate> <path>
#
# `stapler` fetches or checks the notarization ticket through Apple's CloudKit,
# so a dropped connection fails it with no signing fault (NSURLErrorDomain,
# reported as "Error 68"). Retry only that transport failure; a missing,
# invalid or rejected ticket reports differently and fails on the first attempt.
set -u

if [ $# -ne 2 ] || { [ "$1" != staple ] && [ "$1" != validate ]; }; then
  echo "Usage: stapler-retry.sh <staple|validate> <path>" >&2
  exit 2
fi
action=$1
target=$2
max_attempts=3

for attempt in $(seq 1 "$max_attempts"); do
  output=$(xcrun stapler "$action" "$target" 2>&1)
  status=$?
  printf '%s\n' "$output"
  if [ "$status" -eq 0 ]; then
    exit 0
  fi
  if ! grep -Fq 'NSURLErrorDomain' <<<"$output" || [ "$attempt" -eq "$max_attempts" ]; then
    exit "$status"
  fi
  echo "::warning::stapler $action could not reach Apple's ticket service for $target on attempt $attempt; retrying."
  sleep $((attempt * 15))
done
