#!/usr/bin/env bash
set -Eeuo pipefail

: "${TEST_POSTGRES_CONTAINER:?TEST_POSTGRES_CONTAINER is required}"
client=$(basename "$0")
if [ -n "${TEST_POSTGRES_ARGV_LOG:-}" ]; then
  {
    printf '%s' "${client}"
    printf ' <%s>' "$@"
    printf '\n'
  } >> "${TEST_POSTGRES_ARGV_LOG}"
fi
docker_env=()
container_service_file=
container_pass_file=
if [ -n "${PGSERVICEFILE:-}" ] || [ -n "${PGPASSFILE:-}" ]; then
  : "${PGSERVICEFILE:?PGSERVICEFILE is required}"
  : "${PGPASSFILE:?PGPASSFILE is required}"
  container_service_file="/tmp/mbox-pg-service-$$.conf"
  container_pass_file="/tmp/mbox-pg-pass-$$"
  docker cp "${PGSERVICEFILE}" "${TEST_POSTGRES_CONTAINER}:${container_service_file}" >/dev/null
  docker cp "${PGPASSFILE}" "${TEST_POSTGRES_CONTAINER}:${container_pass_file}" >/dev/null
  docker exec "${TEST_POSTGRES_CONTAINER}" chmod 0600 \
    "${container_service_file}" "${container_pass_file}"
  docker_env=(--env "PGSERVICEFILE=${container_service_file}" --env "PGPASSFILE=${container_pass_file}")
  cleanup_libpq_files() {
    docker exec "${TEST_POSTGRES_CONTAINER}" rm -f \
      "${container_service_file}" "${container_pass_file}" >/dev/null 2>&1 || true
  }
  trap cleanup_libpq_files EXIT
fi

case "${client}" in
  psql)
    input=$(cat)
    if [ -n "${TEST_PSQL_FAIL_PATTERN:-}" ] \
      && [[ "${input}" == *"${TEST_PSQL_FAIL_PATTERN}"* ]] \
      && { [ -z "${TEST_PSQL_ONCE_FILE:-}" ] || [ ! -f "${TEST_PSQL_ONCE_FILE}" ]; }; then
      [ -z "${TEST_PSQL_ONCE_FILE:-}" ] || : > "${TEST_PSQL_ONCE_FILE}"
      exit 88
    fi
    status=0
    printf '%s' "${input}" | docker exec -i "${docker_env[@]}" \
      "${TEST_POSTGRES_CONTAINER}" psql "$@" || status=$?
    if [ "${status}" = 0 ] && [ -n "${TEST_PSQL_SIGNAL_PATTERN:-}" ] \
      && [[ "${input}" == *"${TEST_PSQL_SIGNAL_PATTERN}"* ]] \
      && { [ -z "${TEST_PSQL_ONCE_FILE:-}" ] || [ ! -f "${TEST_PSQL_ONCE_FILE}" ]; }; then
      [ -z "${TEST_PSQL_ONCE_FILE:-}" ] || : > "${TEST_PSQL_ONCE_FILE}"
      kill -TERM "${PPID}"
    fi
    if [ "${status}" = 0 ] && [ -n "${TEST_PSQL_AFTER_PATTERN:-}" ] \
      && [[ "${input}" == *"${TEST_PSQL_AFTER_PATTERN}"* ]] \
      && { [ -z "${TEST_PSQL_ONCE_FILE:-}" ] || [ ! -f "${TEST_PSQL_ONCE_FILE}" ]; }; then
      [ -z "${TEST_PSQL_ONCE_FILE:-}" ] || : > "${TEST_PSQL_ONCE_FILE}"
      docker exec "${docker_env[@]}" "${TEST_POSTGRES_CONTAINER}" psql \
        --dbname="service=${TEST_PSQL_AFTER_DATABASE_SERVICE:?}" \
        --set=ON_ERROR_STOP=1 --command="${TEST_PSQL_AFTER_SQL:?}"
    fi
    exit "${status}"
    ;;
  pg_dump)
    container_file="/tmp/mbox-dump-$$.dump"
    rewritten=()
    host_file=
    for argument in "$@"; do
      case "${argument}" in
        --file=*) host_file=${argument#--file=}; rewritten+=("--file=${container_file}") ;;
        *) rewritten+=("${argument}") ;;
      esac
    done
    test -n "${host_file}"
    docker exec "${docker_env[@]}" "${TEST_POSTGRES_CONTAINER}" pg_dump "${rewritten[@]}"
    docker cp "${TEST_POSTGRES_CONTAINER}:${container_file}" "${host_file}" >/dev/null
    docker exec "${TEST_POSTGRES_CONTAINER}" rm -f "${container_file}"
    ;;
  pg_restore)
    container_file="/tmp/mbox-restore-$$.dump"
    host_file=${!#}
    test -f "${host_file}"
    docker cp "${host_file}" "${TEST_POSTGRES_CONTAINER}:${container_file}" >/dev/null
    arguments=("${@:1:$#-1}" "${container_file}")
    status=0
    docker exec "${docker_env[@]}" "${TEST_POSTGRES_CONTAINER}" pg_restore "${arguments[@]}" || status=$?
    docker exec "${TEST_POSTGRES_CONTAINER}" rm -f "${container_file}"
    exit "${status}"
    ;;
  *)
    echo "unsupported postgres client: ${client}" >&2
    exit 64
    ;;
esac
