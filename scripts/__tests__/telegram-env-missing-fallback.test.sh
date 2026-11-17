#!/usr/bin/env bash
# A TELEGRAM_ENV that names a MISSING file must not silence the alert scripts.
#
# Measured on a live install (2026-11-17): the host watchdog and the OnFailure notifier units still carried
# `Environment=TELEGRAM_ENV=$HOME/.claude/channels/telegram/.env` from a pre-#915 render. The legacy dir had been
# emptied by the channel-state migration, update.sh's strip_legacy_notifier_telegram_env (UPDUNITTGENV930) never
# ran on that host, and five host restarts plus every unit failure went unreported for a week. The scripts now fall
# back to their own resolution when TELEGRAM_ENV names no file, and log that they did.
#
# Hermetic: a throwaway install with install-scoped channel state, an empty legacy $HOME, and a curl stub that
# records its arguments and answers ok -- nothing reaches the network.
#
# Run:  bash scripts/__tests__/telegram-env-missing-fallback.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
FAILS=0
N=0
check() { N=$((N+1)); if [ "$2" = "0" ]; then echo "PASS  $1"; else echo "FAIL  $1${3:+  -- $3}"; FAILS=$((FAILS+1)); fi; }

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/tgenvfb.XXXXXX")"
trap 'rm -rf "$SANDBOX"' EXIT

mk_install() {  # mk_install <dir> <script...>
  local d="$1"; shift
  mkdir -p "$d/scripts/lib" "$d/.claude/channels/telegram" "$d/home/.claude/channels/telegram" "$d/store" "$d/bin"
  for s in "$@"; do cp "$ROOT/scripts/$s" "$d/scripts/"; done
  cp "$ROOT/scripts/lib/send-telegram.sh" "$d/scripts/lib/"
  printf 'TELEGRAM_BOT_TOKEN=123456:INSTALL-SCOPED\n' > "$d/.claude/channels/telegram/.env"
  printf '{"dmPolicy":"allowlist","allowFrom":["111222333"]}' > "$d/.claude/channels/telegram/access.json"
  # lib/send-telegram.sh hands curl the token URL as a config line on STDIN (-K -), never in argv, so the stub
  # records both: the arguments (chat id, text) and the stdin config (which bot token was used).
  cat > "$d/bin/curl" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$@" >> "${STUB_ARGS_FILE:-/dev/null}"
case " $* " in *" -K - "*) cat >> "${STUB_ARGS_FILE:-/dev/null}" ;; esac
echo '{"ok":true,"result":{"message_id":1}}'
exit 0
STUB
  chmod +x "$d/bin/curl"
}

# Every run starts from a clean environment: an exported TELEGRAM_STATE_DIR in the developer's shell would make the
# test read a live install's channel state (felugyeleti-riasztas.test.sh measured exactly that).
run_in() {  # run_in <dir> <script> [args...] -- env assignments come through RUN_ENV (array)
  local d="$1" s="$2"; shift 2
  ( cd "$d" && env -u TELEGRAM_STATE_DIR -u TELEGRAM_ENV -u TELEGRAM_ACCESS -u MARVEEN_ALERT_CHAT_ID \
      PATH="$d/bin:$PATH" HOME="$d/home" STUB_ARGS_FILE="$d/curl-args.txt" MARVEEN_STORE="$d/store" \
      HOSTWD_PROC_STAT="$d/proc-stat" "${RUN_ENV[@]}" bash "$d/scripts/$s" "$@" ) 2>&1
}

# --- host-restart-watchdog.sh -------------------------------------------------------------------------------------
mk_watchdog() {
  mk_install "$1" host-restart-watchdog.sh
  printf '1700000000\n' > "$1/store/.last-btime"
  printf 'cpu 0 0 0\nbtime 1700000999\n' > "$1/proc-stat"
}

W="$SANDBOX/w1"; mk_watchdog "$W"
RUN_ENV=(TELEGRAM_ENV="$W/home/.claude/channels/telegram/.env" MARVEEN_ALERT_CHAT_ID=111222333)
out="$(run_in "$W" host-restart-watchdog.sh)"
check "watchdog: a missing TELEGRAM_ENV falls back and the notice is sent" \
  "$(grep -q 'Telegram sent' <<<"$out" && echo 0 || echo 1)" "$(tail -2 <<<"$out" | tr '\n' ' ')"
check "watchdog: the fallback is named in the log" \
  "$(grep -q 'TELEGRAM_ENV=.* does not exist; using .*/.claude/channels/telegram/.env instead' <<<"$out" && echo 0 || echo 1)"
check "watchdog: the install-scoped token was used" \
  "$(grep -q 'bot123456:INSTALL-SCOPED' "$W/curl-args.txt" 2>/dev/null && echo 0 || echo 1)"
check "watchdog: the btime baseline is stamped after delivery" \
  "$([ "$(cat "$W/store/.last-btime")" = "1700000999" ] && echo 0 || echo 1)"

W="$SANDBOX/w2"; mk_watchdog "$W"
printf 'TELEGRAM_BOT_TOKEN=999:OPERATOR-CHOICE\n' > "$W/operator.env"
RUN_ENV=(TELEGRAM_ENV="$W/operator.env" MARVEEN_ALERT_CHAT_ID=111222333)
out="$(run_in "$W" host-restart-watchdog.sh)"
check "watchdog: an EXISTING TELEGRAM_ENV still wins (operator's choice kept)" \
  "$(grep -q 'bot999:OPERATOR-CHOICE' "$W/curl-args.txt" 2>/dev/null && ! grep -q 'does not exist' <<<"$out" && echo 0 || echo 1)"

W="$SANDBOX/w3"; mk_watchdog "$W"
rm -f "$W/.claude/channels/telegram/.env"
RUN_ENV=(TELEGRAM_ENV="$W/nowhere.env" MARVEEN_ALERT_CHAT_ID=111222333)
out="$(run_in "$W" host-restart-watchdog.sh)"
check "watchdog: no file anywhere -> still the named skip, nothing sent, baseline not stamped" \
  "$(grep -q 'skipping Telegram' <<<"$out" && [ ! -s "$W/curl-args.txt" ] && [ "$(cat "$W/store/.last-btime")" = "1700000000" ] && echo 0 || echo 1)"

# --- unit-fail-notify.sh ------------------------------------------------------------------------------------------
U="$SANDBOX/u1"; mk_install "$U" unit-fail-notify.sh
RUN_ENV=(TELEGRAM_ENV="$U/home/.claude/channels/telegram/.env")
out="$(run_in "$U" unit-fail-notify.sh teszt.service)"
check "notify: a missing TELEGRAM_ENV falls back and the notice is delivered" \
  "$(grep -q 'notice delivered' <<<"$out" && echo 0 || echo 1)" "$(tail -2 <<<"$out" | tr '\n' ' ')"
check "notify: the fallback is named in the log" \
  "$(grep -q '\[unit-fail-notify\] TELEGRAM_ENV=.* does not exist' <<<"$out" && echo 0 || echo 1)"
check "notify: the install-scoped token and the access.json chat were used" \
  "$(grep -q 'bot123456:INSTALL-SCOPED' "$U/curl-args.txt" 2>/dev/null && grep -q '111222333' "$U/curl-args.txt" && echo 0 || echo 1)"

# --- fleet-memory-gate.sh: the resolution block itself, run in isolation --------------------------------------------
# (the gate's alert path needs memory pressure to fire; the block is the same three lines as above, so it is
# extracted from the TG_CHAN_DIR resolution through the fallback's closing fi and run against the sandbox)
M="$SANDBOX/m1"; mk_install "$M" fleet-memory-gate.sh
BLOCK="$(awk '/^TG_CHAN_DIR="\$\{TELEGRAM_STATE_DIR:-\}"/{on=1} on{print} on&&/^  ENV_FILE="\$TG_CHAN_DIR\/.env"/{getline; print; exit}' "$M/scripts/fleet-memory-gate.sh")"
check "memgate: the resolution block with the fallback is present" \
  "$(grep -q 'does not exist; using' <<<"$BLOCK" && echo 0 || echo 1)"
# Never run a block the extraction did not bound: without its closing line awk would hand over the rest of the gate.
res="block not extracted"
if grep -q 'does not exist; using' <<<"$BLOCK" && [ "$(wc -l <<<"$BLOCK")" -lt 20 ]; then
  res="$( cd "$M" && env -u TELEGRAM_STATE_DIR HOME="$M/home" TELEGRAM_ENV="$M/home/.claude/channels/telegram/.env" \
    INSTALL_DIR="$M" bash -c "$BLOCK"$'\necho "ENV_FILE=$ENV_FILE"' 2>&1 )"
fi
check "memgate: a missing TELEGRAM_ENV resolves to the install-scoped .env" \
  "$(grep -qx "ENV_FILE=$M/.claude/channels/telegram/.env" <<<"$res" && echo 0 || echo 1)" "$(tr '\n' ' ' <<<"$res")"

echo ""
echo "Results: $((N - FAILS)) passed, $FAILS failed"
[ "$FAILS" = "0" ]
