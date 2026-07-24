# Platform S300 Vendor — Pindah ke Server Baru

Cara menegakkan platform inspeksi S300 milik **vendor** (`车辆反藏匿查验平台` /
`customs-platform`) di server baru. Ini software proprietary vendor (Maxvision),
**bukan** platform ANPR kita — ia berjalan berdampingan dengan platform kita dan
backend kita bicara dengannya via HTTP (lihat [`COMMUNICATION.id.md`](./COMMUNICATION.id.md)).

> ⚠️ **Lisensi.** Image aplikasi adalah build proprietary vendor dari registry
> Aliyun privat mereka. Tar image offline sudah dibundel sehingga bisa dipasang
> tanpa akses registry — tapi menjalankan instance kedua mungkin butuh izin
> vendor. Konfirmasi ke vendor sebelum deploy node lain.

> ⚠️ **Arsitektur.** Image yang dibundel adalah **amd64 (x86_64)**. Server baru
> harus x86_64 (ada folder `arm/` kosong, tapi tidak ada tar arm).

---

## 1. Apa isi installer-nya

Di server testing saat ini (`192.168.50.250`), seluruh platform ada sebagai
bundle Docker offline di bawah **`/data/`** (~2,5 GB total). Tiap bundle
mandiri: `docker-compose.yml`, tar image offline di `images/`, dan
`scripts/start.sh` yang `docker load` tar lalu jalankan `compose up`.

| Bundle (di `/data/`) | Isi | Ukuran |
|---|---|---|
| `deploy-docker-engine-amd64-v1.0.0/deploy-docker-engine-amd64` | Docker + Compose offline + `install.sh` | 370M |
| `deploy-mysql-amd64-v1.0.0/deploy-mysql-amd64` | MySQL 8.0.35 | 785M |
| `deploy-redis-amd64-v1.0.0/deploy-redis-amd64` | Redis 7.0.12 | 129M |
| `deploy-s300-amd64-v1.0.0/deploy-customs` | **aplikasinya** (`customs-platform`, Spring Boot, tag image `backend.s300.3002`) | 1.2G |
| `nginx/nginx` | Nginx 1.29 + frontend Vue (`html/dist`) + proxy `/prod/` → backend | 94M |

Port container app (host:container): `18001:8001` (REST API), `18003:8003`
(socket.io), `18004:8004` (media/HTTP), `18888:8888/udp` (push server). Semua
container berbagi network Docker eksternal **`scts-network`**; app menjangkau
MySQL/Redis lewat nama container (`deploy-mysql_mysql:3306`, `deploy-redis_redis`).

---

## 2. Salin bundle ke server baru

Dari server saat ini (SSH `mpi` / sudo). Pakai `rsync` bila ada, atau `scp` /
tar. Salin kelima direktori, jaga file `images/**/*.tar`:

```bash
# di 192.168.50.250, sebagai user dengan sudo
sudo tar czf /tmp/s300-installer.tgz -C /data \
  deploy-docker-engine-amd64-v1.0.0 \
  deploy-mysql-amd64-v1.0.0 \
  deploy-redis-amd64-v1.0.0 \
  deploy-s300-amd64-v1.0.0 \
  nginx
# lalu salin /tmp/s300-installer.tgz ke server baru dan:
#   sudo mkdir -p /data && sudo tar xzf s300-installer.tgz -C /data
```

---

## 3. Urutan instalasi di server baru

### 3.1 Docker engine
```bash
cd /data/deploy-docker-engine-amd64-v1.0.0/deploy-docker-engine-amd64
sudo bash install.sh            # instal offline Docker + Compose + sysctl
docker info                     # pastikan daemon jalan
```

### 3.2 Buat network bersama
```bash
docker network create scts-network
```

### 3.3 MySQL — **edit `.env` dulu** (default-nya nilai template!)
`deploy-mysql-amd64/.env` datang dengan `appdb` / `ChangeMe_Root!` /
`deploy-mysql_net`. Ubah agar cocok dengan yang app harapkan:
```
STACK_NETWORK_NAME=scts-network
MYSQL_ROOT_PASSWORD=Max@123456
MYSQL_DATABASE=bordercollie_customs_s300
```
Lalu:
```bash
cd /data/deploy-mysql-amd64-v1.0.0/deploy-mysql-amd64
bash scripts/start.sh 2>/dev/null || bash start.sh
```
App membuat tabelnya sendiri saat boot pertama (migrasi Spring Boot; tidak ada
init `.sql` di bundle) — Anda hanya perlu database kosongnya ada.

### 3.4 Redis — edit `.env`
Set `STACK_NETWORK_NAME=scts-network`, lalu `bash start.sh`.

### 3.5 Aplikasi — edit `deploy-customs/.env`
Ubah nilai spesifik-lokasi ke **IP server baru**; biarkan hostname service
internal (mereka resolve di `scts-network`):
```
SERVER_IP=<IP_SERVER_BARU>
MEDIA_SERVER_IP=<IP_SERVER_BARU>
PUSH_CLIENT_HOST=<IP_SERVER_BARU>
# biarkan apa adanya:
JDBC_URL=deploy-mysql_mysql:3306
JDBC_USER=root
JDBC_PASSWORD=Max@123456
JDBC_DATABASE=bordercollie_customs_s300
REDIS_HOST=deploy-redis_redis
```
Lalu:
```bash
cd /data/deploy-s300-amd64-v1.0.0/deploy-customs
bash scripts/start.sh           # docker-load tar app, lalu compose up -d
docker logs -f customs-platform  # pantau proses naik + migrasi skema
```

### 3.6 Nginx (frontend + proxy `/prod/`) — edit `conf/nginx.conf`
Ubah `server_name 192.168.50.250;` ke IP/hostname server baru. Target proxy
`proxy_pass http://host.docker.internal:18001/;` biarkan. Lalu:
```bash
cd /data/nginx/nginx
bash start.sh
```
Frontend kini di `http://<IP_SERVER_BARU>/`, API di `/prod/`.

---

## 4. Konfigurasi ulang integrasi setelah pindah

IP berubah, jadi update ini via CP vendor (login `admin` / `Max@123456` di
`http://<IP_SERVER_BARU>/`, atau `POST /prod/customized-setting` per setting):

- **Param alamat mereka sendiri**: `SERVER_IP`, `MEDIA_SERVER_IP` di `.env` app
  (sudah di 3.5) — dan setting CP mana pun yang hardcode IP lama.
- **URL push-ke-kita** (`OVERSEAS_*`) tetap menunjuk ke backend **kita**
  (`192.168.50.148/anpr_backend/...`) — tidak berubah kecuali server kita juga pindah.
- **Di sisi kita**: `anprc_channels.s300_base_url` untuk channel S300 →
  `http://<IP_SERVER_BARU>:18001` (halaman S300 Inspection, atau
  `default_s300_base_url` di Settings). Ini satu-satunya perubahan yang platform
  kita butuhkan.

---

## 5. Opsional: migrasi data lama (bukan sekadar install bersih)

Bila butuh riwayat, bukan box bersih:

- **MySQL**: `mysqldump -uroot -pMax@123456 bordercollie_customs_s300` di server
  lama → import ke yang baru (idealnya setelah 3.3, sebelum boot pertama app).
- **Upload/media**: salin `deploy-customs/customs-platform/upload/` (dan
  `.../data/`) dari lama ke baru.
- **Param setting**: ikut di mysqldump, atau terapkan ulang via CP. Redis cache
  — aman dilewati.

---

## 6. Verifikasi

1. `docker ps` menampilkan `customs-platform`, `deploy-nginx_nginx`,
   `deploy-mysql_mysql`, `deploy-redis_redis` semua Up.
2. `curl http://<IP_SERVER_BARU>/prod/user/login` (multipart `admin`/`Max@123456`)
   mengembalikan token.
3. Dari box kita: `POST /api/s300/come/RJ001` (dengan channel menunjuk ke IP baru)
   mengembalikan `operatingState:0` — round trip berhasil.
