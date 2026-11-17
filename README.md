# Balai

A small web panel that keeps a Debian or Ubuntu server clean and healthy.

Balai runs on the server it looks after. It shows what is wrong, lets you act on
it, and frees disk space, without agents, accounts or outside services.

## What it does

- **Overview**: CPU, memory, swap and disk at a glance, with a usage chart for the last hour, day or week.
- **Health checks**: full disks, exhausted inodes, low memory, heavy swap, high load, failed services, zombie processes, pending security updates, a needed restart, out-of-memory kills and an unsynchronised clock.
- **Processes**: see what uses CPU and memory, and stop or force stop a process.
- **Services**: start, stop, restart, enable or disable systemd services and read their recent logs.
- **Cleanup**: apt cache, unused packages and old kernels, the systemd journal, rotated logs, old temporary files, crash reports, trash, Docker leftovers, user caches and the memory page cache. Each item shows how much it would free before you run it.
- **Disk**: every filesystem, and a folder browser that shows where the space goes.
- **Packages**: available updates, with security updates marked.
- **Ports**: which programs are listening, and whether they are reachable from outside.
- **Activity**: a record of everything done from the panel.
- **Updates**: Balai checks for new versions and installs them from the interface, on request or automatically.

## Requirements

- Debian, Ubuntu or a derivative, with systemd
- Root access

## Install

```bash
git clone https://github.com/toscani-tenekeu/balai.git /opt/balai
sudo bash /opt/balai/install.sh
```

The script installs [Bun](https://bun.sh) if it is missing, builds the interface
and starts Balai as a systemd service. When it finishes it prints two things:

```
Setup link:      http://203.0.113.10:7070/setup?token=…
Admin password:  …
```

Open the setup link once to choose your own password. If you would rather keep
the generated password, sign in with it; the link stops working either way.

The same information is kept in `/opt/balai/data/first-run.txt` until setup is
done.

### Settings

Pass these as environment variables to `install.sh`:

| Variable     | Default      | Meaning                                         |
| ------------ | ------------ | ----------------------------------------------- |
| `BALAI_DIR`  | `/opt/balai` | Where Balai is installed                        |
| `BALAI_HOST` | `0.0.0.0`    | Address to listen on                            |
| `BALAI_PORT` | `7070`       | Port to listen on                               |
| `BALAI_URL`  | none         | Public address, used to print the setup link    |

## Using a domain name

Balai works with just the server's IP address, but then your password travels
over plain HTTP. A domain name with HTTPS is recommended. Make Balai listen
locally and put a web server in front of it:

```bash
sudo BALAI_HOST=127.0.0.1 BALAI_URL=https://balai.example.com bash /opt/balai/install.sh
```

```nginx
server {
    server_name balai.example.com;

    location / {
        proxy_pass http://127.0.0.1:7070;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Then get a certificate, for example with `sudo certbot --nginx -d balai.example.com`.

## Updating

Open **Settings** and choose **Check for updates**, then **Install update**. Balai
downloads the new version, builds it next to the running one, swaps it in and
restarts. If anything fails, it stays on the version it had.

Turn on **Install updates automatically** to have this done every six hours.

## Day to day

```bash
systemctl status balai            # is it running
journalctl -u balai -f            # logs
cd /opt/balai && bun run passwd   # reset a forgotten password
```

## Uninstall

```bash
sudo systemctl disable --now balai
sudo rm /etc/systemd/system/balai.service
sudo rm -rf /opt/balai
```

## How it is built

- **Server**: [Bun](https://bun.sh), with its built-in SQLite driver. No other runtime dependencies.
- **Interface**: Vue 3 with [shadcn-vue](https://www.shadcn-vue.com) components and Tailwind CSS.
- **Data**: one SQLite file in `data/`, holding the password hash, sessions, usage readings (7 days) and the activity record (90 days).

System commands are always started with an explicit argument list and never
through a shell.

### Development

```bash
bun install && (cd web && bun install)
bun run build          # build the interface once
bun run dev:server     # API on http://127.0.0.1:7070
bun run dev:web        # interface with hot reload, proxying /api
```

## License

MIT
