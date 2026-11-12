/home/{{user}}/logs/*/*.log {
    su root root
    daily
    missingok
    rotate 7
    dateext
    dateformat -%Y-%m-%d
    create 0640 {{user}} {{group}}
    sharedscripts
    postrotate
      # Reopen log files (USR1) — not "reload": a reload re-reads the whole config and is refused if any
      # vhost fails `nginx -t`, which left nginx writing into the renamed file and the current log empty.
      # "&>" was also a bashism: logrotate runs /bin/sh, where it backgrounds the command instead.
      invoke-rc.d nginx rotate >/dev/null 2>&1 || true
      for p in /run/php/php*-fpm.pid; do [ -s "$p" ] && kill -USR1 "$(cat "$p")"; done >/dev/null 2>&1 || true
    endscript
}
