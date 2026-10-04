# worca terminal (bash), issue #573: load the system and personal bashrc, then print the markers worca
# reads to record each command as a block. Every mark carries this session's nonce, so output that merely
# contains a mark (a `cat` of a file) is never mistaken for one: OSC 133 C;<nonce>;<base64 command> = a
# command starts, D;<nonce>;<exit> = it ended, W;<nonce>;<base64 folder> = the folder, A;<nonce> = the
# prompt. Started as `bash --rcfile <this file> -i` by src/core/terminal/shell.mjs.
__worca_nonce=${WORCA_TERMINAL_NONCE-}
unset WORCA_TERMINAL_NONCE                                     # programs started here never see it
if [ -r /etc/bash.bashrc ]; then . /etc/bash.bashrc; fi        # Debian/Ubuntu: --rcfile skips it
if [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi

__worca_ready=0
__worca_hist=

__worca_trim() { local s="$1"; s="${s#"${s%%[![:space:]]*}"}"; builtin printf '%s' "$s"; }
__worca_b64() { builtin printf '%s' "$1" | base64 | tr -d '\n'; }

# DEBUG trap: runs before every simple command. Only the first one after a prompt is the command the
# person typed (__worca_ready); the PROMPT_COMMAND's own commands never are.
__worca_preexec() {
  [ "$__worca_ready" = 1 ] || return 0
  __worca_ready=0
  case "$BASH_COMMAND" in __worca_precmd*) return 0 ;; esac   # an empty Enter: no command ran
  local line num cmd
  line=$(__worca_trim "$(HISTTIMEFORMAT= builtin history 1)")
  num=${line%%[!0-9]*}
  if [ -n "$num" ] && [ "$num" != "$__worca_hist" ]; then
    __worca_hist=$num
    cmd=$(__worca_trim "${line#"$num"}")                      # the whole line, e.g. `make && make test`
  else
    cmd=$BASH_COMMAND                                          # history off or unchanged: the first command
  fi
  builtin printf '\033]133;C;%s;%s\007' "$__worca_nonce" "$(__worca_b64 "$cmd")"
}

__worca_precmd() {
  local ec=$?
  builtin printf '\033]133;D;%s;%s\007\033]133;W;%s;%s\007\033]133;A;%s\007' \
    "$__worca_nonce" "$ec" "$__worca_nonce" "$(__worca_b64 "$PWD")" "$__worca_nonce"
}

trap '__worca_preexec' DEBUG
# __worca_precmd must run first (it reads $?) and __worca_ready=1 last. bash 5.1+ runs every element of
# an array PROMPT_COMMAND, so there it is extended as an array; a plain assignment would only replace
# element 0 and leave the others to run after __worca_ready=1 (recorded as if typed).
if (( BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 1) )) \
   && [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
  PROMPT_COMMAND=(__worca_precmd "${PROMPT_COMMAND[@]}" '__worca_ready=1')
else
  PROMPT_COMMAND="__worca_precmd${PROMPT_COMMAND:+; $PROMPT_COMMAND}; __worca_ready=1"
fi
