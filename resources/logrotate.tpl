/home/{{user}}/logs/*/*.log {
    su root root
    daily
    missingok
    rotate 7
    dateext
    dateformat -%Y-%m-%d
    create 0640 {{user}} {{group}}
    postrotate
      /etc/init.d/nginx reload &> /dev/null || true
    endscript
}