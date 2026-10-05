# worca terminal (zsh), issue #573: worca points ZDOTDIR at a folder holding this file (as .zshenv)
# and zshrc.zsh (as .zshrc). Keep the session's marker nonce out of the environment, load your own
# .zshenv from your real ZDOTDIR, remember where that is, and keep worca's ZDOTDIR so zsh reads
# worca's .zshrc next.
typeset -g __worca_nonce=${WORCA_TERMINAL_NONCE-}
unset WORCA_TERMINAL_NONCE
__worca_zdot=$ZDOTDIR
ZDOTDIR=${WORCA_USER_ZDOTDIR:-$HOME}
[[ -f $ZDOTDIR/.zshenv ]] && source $ZDOTDIR/.zshenv
export WORCA_USER_ZDOTDIR=$ZDOTDIR
ZDOTDIR=$__worca_zdot
unset __worca_zdot
