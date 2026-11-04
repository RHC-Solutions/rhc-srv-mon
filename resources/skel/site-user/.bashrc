# .bashrc

if [ -f /etc/bashrc/bashrc ]; then
  . /etc/bashrc/bashrc
fi

if [ -f ~/.python_version  ]; then
  . ~/.python_version
fi

# User specific aliases and functions

umask 007

# Claude Code CLI (installed per user by the panel into ~/.local/bin)
export PATH="$HOME/.local/bin:$PATH"
