if [[ -n "${_PASEO_ZSH_INTEGRATION_LOADED-}" ]]; then
  return
fi
typeset -g _PASEO_ZSH_INTEGRATION_LOADED=1

autoload -Uz add-zsh-hook

typeset -g _PASEO_ZSH_COMMAND_ACTIVE=0

function _paseo_osc633() {
  printf '\e]633;%s\a' "$1"
}

function _paseo_precmd() {
  local command_status=$?
  if [[ "$_PASEO_ZSH_COMMAND_ACTIVE" == "1" ]]; then
    _paseo_osc633 "D;${command_status}"
    _PASEO_ZSH_COMMAND_ACTIVE=0
  fi
  printf '\e]2;%s\a' "${PWD/#$HOME/~}"
  _paseo_osc633 "A"
}

function _paseo_preexec() {
  _PASEO_ZSH_COMMAND_ACTIVE=1
  _paseo_osc633 "B"
  _paseo_osc633 "C"
  printf '\e]2;%s\a' "$1"
}

add-zsh-hook precmd _paseo_precmd
add-zsh-hook preexec _paseo_preexec

# Orchestra terminal-bin: once the person's rc files have run, put
# $ORCHESTRA_TERMINAL_BIN back at the head of PATH (dropping the duplicate) at
# the first prompt, then remove the hook. No-op when the variable is unset.
if [[ -n "${ORCHESTRA_TERMINAL_BIN-}" ]]; then
  function _paseo_orchestra_path_precmd() {
    add-zsh-hook -d precmd _paseo_orchestra_path_precmd
    if [[ -n "${ORCHESTRA_TERMINAL_BIN-}" ]]; then
      path=("$ORCHESTRA_TERMINAL_BIN" "${(@)path:#${~${(b)ORCHESTRA_TERMINAL_BIN}}}")
    fi
  }
  add-zsh-hook precmd _paseo_orchestra_path_precmd
fi
