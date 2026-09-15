#!/usr/bin/env sh
# Runs the SonarQube scanner in Docker against a local server. `npm run sonar` calls it after
# the unit suite has written coverage/lcov.info.
set -eu

# Only published for amd64; Docker emulates it on arm64.
image="sonarsource/sonar-scanner-cli:12.1.0.3233_8.0.1"
# Seen from inside the scanner container, localhost would be the container itself.
host="${SONAR_HOST_URL:-http://host.docker.internal:9000}"

fail() {
	printf '\n\033[31m✖ sonar: %s\033[0m\n\n' "$1" >&2
	exit 1
}

[ -n "${SONAR_TOKEN:-}" ] || fail "SONAR_TOKEN is not set. Create an analysis token for this project on the server and export it."
[ -f coverage/lcov.info ] || fail "coverage/lcov.info is missing. Run npm run test:coverage first."
docker info >/dev/null 2>&1 || fail "Docker is not running."

# Checked before the scan because the scanner reports an unreachable server as a stack trace.
status=$(docker run --rm --platform linux/amd64 --entrypoint curl "$image" -fs -m 10 "$host/api/system/status" 2>/dev/null || true)
case "$status" in
*'"status":"UP"'*) ;;
*) fail "no SonarQube is answering at $host. Start the server, or set SONAR_HOST_URL." ;;
esac

exec docker run --rm --platform linux/amd64 \
	-e SONAR_HOST_URL="$host" \
	-e SONAR_TOKEN \
	-v "$(pwd):/usr/src" \
	"$image"
