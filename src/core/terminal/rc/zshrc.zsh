# worca terminal (zsh), issue #573: your .zshrc, then the markers worca reads (see worca.bash).
# ZDOTDIR goes back to yours first, so a zsh started inside this one loads only your own files.
ZDOTDIR=${WORCA_USER_ZDOTDIR:-$HOME}
unset WORCA_USER_ZDOTDIR
[[ -z ${WORCA_TERMINAL_NORC-} && -f $ZDOTDIR/.zshrc ]] && source $ZDOTDIR/.zshrc   # Ask's shells (#574) skip it
unset WORCA_TERMINAL_NORC

__worca_b64() { builtin printf '%s' "$1" | base64 | tr -d '\n'; }
__worca_preexec() { builtin printf '\033]133;C;%s;%s\007' "$__worca_nonce" "$(__worca_b64 "$1")"; }
__worca_precmd() {
  local ec=$?
  builtin printf '\033]133;D;%s;%s\007\033]133;W;%s;%s\007\033]133;A;%s\007' \
    "$__worca_nonce" "$ec" "$__worca_nonce" "$(__worca_b64 "$PWD")" "$__worca_nonce"
}
typeset -ga preexec_functions precmd_functions
preexec_functions+=(__worca_preexec)
precmd_functions=(__worca_precmd $precmd_functions)   # first, so $? is still the command's
