# Panduan Login untuk Pengembangan

Platform ini dirancang untuk **disematkan ke dalam portal induk**. Di produksi,
portal induk meneruskan username melalui parameter query `?username=<nilai>`
dan backend melakukan pencarian user tersebut di database portal induk.

Untuk **pengembangan lokal** — sebelum portal induk tersedia — backend memiliki
mode "dev bypass" yang menerima username apa pun dan memberikan peran admin.
Dokumen ini menjelaskan cara menggunakannya, cara menonaktifkan, dan cara
beralih kembali ke SSO produksi.

---

## 1. Alur autentikasi sekilas

```
┌────────────────┐   ?username=alice    ┌────────────────────┐
│ Portal induk   │ ───────────────────► │  Frontend (Vite)   │
│  (produksi)    │                      │  http://…:5173     │
└────────────────┘                      └─────────┬──────────┘
                                                  │ POST /api/auth/sso
                                                  │  { username: "alice" }
                                                  ▼
                                        ┌─────────────────────┐
                                        │   Backend PHP       │
                                        │   /api/auth/sso     │
                                        ├─────────────────────┤
                                        │ jika dev_bypass:    │
                                        │   role = admin      │
                                        │ jika tidak:         │
                                        │   cari di DB        │
                                        │   portal induk      │
                                        ├─────────────────────┤
                                        │ upsert baris users  │
                                        │ lokal (shadow row)  │
                                        │ → terbitkan token   │
                                        │   HMAC              │
                                        └─────────────────────┘
                                                  │
                                                  │ { user, token }
                                                  ▼
                                          frontend menyimpan token
                                          di localStorage, menghapus
                                          ?username= dari URL, lalu
                                          memuat dashboard.
```

Token digunakan ulang untuk setiap pemanggilan API selanjutnya
(`Authorization: Bearer …`). Me-refresh tab tetap menjaga sesi aktif
hingga token kedaluwarsa (default 7 hari).

---

## 2. Aktifkan dev bypass

Buka `backend/config/config.php` (di-gitignore — hanya salinan lokal Anda)
dan setel:

```php
'auth' => [
    'secret'    => '<string acak panjang>',
    'token_ttl' => 86400 * 7,
    'dev_bypass' => true,           // ← BARIS INI
    'parent_db'  => [ /* … */ ],
],
```

Alternatif: setel variabel environment untuk proses Apache:

```bash
# Linux / macOS
export AUTH_DEV_BYPASS=1
sudo systemctl restart apache2

# Windows (PowerShell, persisten)
[Environment]::SetEnvironmentVariable('AUTH_DEV_BYPASS', '1', 'User')
# lalu restart modul Apache di XAMPP
```

Salah satu flag cukup; nilai di config menang jika keduanya disetel.

> File contoh `backend/config/config.example.php` sudah berisi
> `dev_bypass => true`, jadi `cp config.example.php config.php` baru
> bisa langsung dipakai untuk pengembangan.

---

## 3. Login secara lokal

Dengan frontend berjalan (`cd frontend && npm run dev`) dan Apache melayani
backend di `http://127.0.0.1/anpr_backend`, buka:

```
http://localhost:5173/?username=admin
```

Anda seharusnya melihat:

1. URL berubah menjadi `http://localhost:5173/` (parameter dihapus setelah
   token diterbitkan)
2. Dashboard tampil dengan badge "admin" di StatusBar kanan atas
3. Me-refresh halaman tetap masuk (token bertahan di `localStorage`)

Username apa pun bekerja di dev — coba `?username=alice` atau
`?username=operator` untuk menguji record shadow-user yang berbeda. Setiap
username unik akan membuat baris di tabel `users` lokal.

### Uji cepat dengan curl

```bash
# 1. Cetak token
curl -sX POST http://127.0.0.1/anpr_backend/api/auth/sso \
     -H "Content-Type: application/json" \
     -d '{"username":"admin"}'
# → {"code":200,"data":{"user":{…},"token":"abcd.xyz"}}

# 2. Pastikan token bekerja
curl -s http://127.0.0.1/anpr_backend/api/auth/me \
     -H "Authorization: Bearer abcd.xyz"
# → {"code":200,"data":{"id":1,"username":"admin","role":"admin",…}}
```

Jika langkah 1 mengembalikan `501 SSO parent-DB lookup not yet configured`,
artinya `dev_bypass` **mati**. Periksa ulang `config.php`.

---

## 4. Sign out / ganti pengguna

Menu profil di StatusBar memiliki **Sign out**. Aksi ini membersihkan token
dari `localStorage` dan kembali ke layar SSO access-denied.

Untuk ganti pengguna, sign out lalu kunjungi URL lagi dengan parameter
`?username=…` yang berbeda.

---

## 5. Nonaktifkan dev bypass untuk produksi

Saat DB portal induk dapat diakses dari produksi:

1. Edit `config.php`:
   ```php
   'auth' => [
       'dev_bypass' => false,
       'parent_db'  => [
           'driver' => 'mysql',
           'host'   => '<host induk>',
           'name'   => '<nama DB induk>',
           'user'   => '<user read-only>',
           'password' => '<…>',
           'table'      => '<tabel users>',
           'col_id'     => 'id',
           'col_uname'  => 'username',
           'col_display'=> 'full_name',
           'col_role'   => 'role',
           'col_active' => 'is_active',
       ],
   ],
   ```
2. Ganti blok `TODO` di `backend/src/Controllers/AuthController.php`
   (method `sso`) dengan lookup nyata. Kerangka kode ada di komentar method
   yang sama.
3. Role yang keluar dari DB induk harus dipetakan ke salah satu
   `admin / operator / viewer` — sesuaikan helper `mapRole()` (perlu Anda
   tambahkan) untuk menerjemahkan nama peran induk ke milik kita.

---

## 6. Troubleshooting

| Gejala | Penyebab | Perbaikan |
|---|---|---|
| Layar `Akses Ditolak` tanpa error | URL tidak punya `?username=` DAN tidak ada token di localStorage | Kunjungi dengan `?username=admin` sekali untuk mencetak token |
| 501 `SSO parent-DB lookup not yet configured` | `dev_bypass` mati tetapi parent_db belum diimplementasi | Setel `dev_bypass => true` di `config.php` (dev) atau selesaikan TODO (prod) |
| 401 dari `/api/auth/me` setelah refresh | Token kedaluwarsa atau `auth.secret` berubah | Kunjungi dengan `?username=…` untuk cetak token baru |
| 400 `username is required` | Frontend memanggil `/api/auth/sso` dengan body kosong | Periksa nilai parameter — kosong / whitespace ditolak |
| Login berhasil sekali tapi refresh berikutnya kembali ke blocked | localStorage tidak persistent (mode private?) | Gunakan jendela browser normal |

---

Lihat juga:
- [`DEPLOYMENT.id.md`](./DEPLOYMENT.id.md) — setup produksi
- [`ARCHITECTURE.id.md`](./ARCHITECTURE.id.md) §9 — daftar API lengkap
- [`DATABASE.id.md`](./DATABASE.id.md) §10 — tabel `users` (shadow row SSO)
- [`DATABASE.id.md`](./DATABASE.id.md) §12 — `operation_log` (audit siapa melakukan apa)
