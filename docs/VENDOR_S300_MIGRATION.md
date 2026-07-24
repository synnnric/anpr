# Vendor S300 Platform — Move to a New Server

How to stand up the **vendor's** S300 inspection platform (`车辆反藏匿查验平台` /
`customs-platform`) on a new server. This is the vendor's proprietary software
(Maxvision), **not** our ANPR platform — it runs alongside ours and our backend
talks to it over HTTP (see [`COMMUNICATION.md`](./COMMUNICATION.md)).

> ⚠️ **Licensing.** The application image is a proprietary vendor build pulled
> from their private Aliyun registry. The offline image tar is bundled so it
> installs without registry access — but running a second instance may need the
> vendor's authorization. Confirm with the vendor before deploying another node.

> ⚠️ **Architecture.** The bundled images are **amd64 (x86_64)**. The new server
> must be x86_64 (there are empty `arm/` dirs, but no arm tars are present).

---

## 1. What the installer is

On the current test server (`192.168.50.250`) the whole platform lives as offline
Docker bundles under **`/data/`** (~2.5 GB total). Each bundle is self-contained:
a `docker-compose.yml`, the offline image `.tar` under `images/`, and a
`scripts/start.sh` that `docker load`s the tar and runs `compose up`.

| Bundle (under `/data/`) | Contents | Size |
|---|---|---|
| `deploy-docker-engine-amd64-v1.0.0/deploy-docker-engine-amd64` | offline Docker + Compose + `install.sh` | 370M |
| `deploy-mysql-amd64-v1.0.0/deploy-mysql-amd64` | MySQL 8.0.35 | 785M |
| `deploy-redis-amd64-v1.0.0/deploy-redis-amd64` | Redis 7.0.12 | 129M |
| `deploy-s300-amd64-v1.0.0/deploy-customs` | **the app** (`customs-platform`, Spring Boot, image tag `backend.s300.3002`) | 1.2G |
| `nginx/nginx` | Nginx 1.29 + the Vue frontend (`html/dist`) + `/prod/` → backend proxy | 94M |

App container ports (host:container): `18001:8001` (REST API), `18003:8003`
(socket.io), `18004:8004` (media/HTTP), `18888:8888/udp` (push server). All
containers share an external Docker network **`scts-network`**; the app reaches
MySQL/Redis by container name (`deploy-mysql_mysql:3306`, `deploy-redis_redis`).

---

## 2. Copy the bundles to the new server

From the current server (SSH `mpi` / sudo). `rsync` if available, else `scp` /
tar. Copy all five directories, preserving the `images/**/*.tar` files:

```bash
# on 192.168.50.250, as a user with sudo
sudo tar czf /tmp/s300-installer.tgz -C /data \
  deploy-docker-engine-amd64-v1.0.0 \
  deploy-mysql-amd64-v1.0.0 \
  deploy-redis-amd64-v1.0.0 \
  deploy-s300-amd64-v1.0.0 \
  nginx
# then copy /tmp/s300-installer.tgz to the new server and:
#   sudo mkdir -p /data && sudo tar xzf s300-installer.tgz -C /data
```

---

## 3. Install order on the new server

### 3.1 Docker engine
```bash
cd /data/deploy-docker-engine-amd64-v1.0.0/deploy-docker-engine-amd64
sudo bash install.sh            # offline install of Docker + Compose + sysctl
docker info                     # confirm the daemon is up
```

### 3.2 Create the shared network
```bash
docker network create scts-network
```

### 3.3 MySQL — **edit `.env` first** (defaults are template values!)
`deploy-mysql-amd64/.env` ships with `appdb` / `ChangeMe_Root!` /
`deploy-mysql_net`. Change to match what the app expects:
```
STACK_NETWORK_NAME=scts-network
MYSQL_ROOT_PASSWORD=Max@123456
MYSQL_DATABASE=bordercollie_customs_s300
```
Then:
```bash
cd /data/deploy-mysql-amd64-v1.0.0/deploy-mysql-amd64
bash scripts/start.sh 2>/dev/null || bash start.sh
```
The app creates its own tables on first boot (Spring Boot migration; there is no
init `.sql` in the bundle) — you only need the empty database to exist.

### 3.4 Redis — edit `.env`
Set `STACK_NETWORK_NAME=scts-network`, then `bash start.sh`.

### 3.5 The app — edit `deploy-customs/.env`
Change the site-specific values to the **new server's IP**; leave the internal
service hostnames alone (they resolve on `scts-network`):
```
SERVER_IP=<NEW_SERVER_IP>
MEDIA_SERVER_IP=<NEW_SERVER_IP>
PUSH_CLIENT_HOST=<NEW_SERVER_IP>
# keep as-is:
JDBC_URL=deploy-mysql_mysql:3306
JDBC_USER=root
JDBC_PASSWORD=Max@123456
JDBC_DATABASE=bordercollie_customs_s300
REDIS_HOST=deploy-redis_redis
```
Then:
```bash
cd /data/deploy-s300-amd64-v1.0.0/deploy-customs
bash scripts/start.sh           # docker-loads the app tar, then compose up -d
docker logs -f customs-platform  # watch it come up + migrate the schema
```

### 3.6 Nginx (frontend + `/prod/` proxy) — edit `conf/nginx.conf`
Change `server_name 192.168.50.250;` to the new server's IP/hostname. The proxy
target `proxy_pass http://host.docker.internal:18001/;` stays as-is. Then:
```bash
cd /data/nginx/nginx
bash start.sh
```
Frontend is now at `http://<NEW_SERVER_IP>/`, API at `/prod/`.

---

## 4. Reconfigure the integration after the move

The IP changed, so update these via the vendor CP (login `admin` / `Max@123456`
at `http://<NEW_SERVER_IP>/`, or `POST /prod/customized-setting` per setting):

- **Their own address params**: `SERVER_IP`, `MEDIA_SERVER_IP` in the app `.env`
  (already done in 3.5) — and any CP setting that hardcodes the old IP.
- **The push-to-us URLs** (`OVERSEAS_*`) still point at **our** backend
  (`192.168.50.148/anpr_backend/...`) — unchanged unless our server also moves.
- **On our side**: `anprc_channels.s300_base_url` for the S300 channel →
  `http://<NEW_SERVER_IP>:18001` (S300 Inspection page, or `default_s300_base_url`
  in Settings). This is the only change our platform needs.

---

## 5. Optional: migrate existing data (not just a fresh install)

If you need the history, not a clean box:

- **MySQL**: `mysqldump -uroot -pMax@123456 bordercollie_customs_s300` on the old
  server → import into the new one (after 3.3, before first app boot ideally).
- **Uploads/media**: copy `deploy-customs/customs-platform/upload/` (and
  `.../data/`) from old to new.
- **Settings params**: either come across in the mysqldump, or re-apply via the
  CP. Redis is a cache — safe to skip.

---

## 6. Verify

1. `docker ps` shows `customs-platform`, `deploy-nginx_nginx`,
   `deploy-mysql_mysql`, `deploy-redis_redis` all Up.
2. `curl http://<NEW_SERVER_IP>/prod/user/login` (multipart `admin`/`Max@123456`)
   returns a token.
3. From our box: a `POST /api/s300/come/RJ001` (with the channel pointed at the
   new IP) returns `operatingState:0` — the round trip works.
