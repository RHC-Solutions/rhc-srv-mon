# .bashrc

if [ -f /etc/bashrc/bashrc ]; then
  . /etc/bashrc/bashrc
fi

if [ -f ~/.python_version  ]; then
  . ~/.python_version
fi

# User specific aliases and functions

umask 007