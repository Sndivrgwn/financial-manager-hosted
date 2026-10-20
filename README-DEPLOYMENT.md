# Financial Manager — self-hosted frontend + Google Sheets backend

## Struktur
- `public/index.html`: frontend aplikasi (hasil migrasi dari file yang diunggah)
- `server.js`: web server Node.js dan proxy API; secret tidak dikirim ke browser
- `Code.gs`: backend Apps Script, tetap menggunakan Google Sheets
- `.env.example`: contoh konfigurasi; salin menjadi `.env` dan isi nilainya

## 1. Siapkan Google Sheets dan Apps Script
1. Buka project Apps Script yang berisi backend lama. Simpan salinan/backup kode lama.
2. Ganti kode backend dengan isi `Code.gs` dari paket ini (atau salin perubahan API bridge di bagian paling bawah sambil mempertahankan fungsi lama). Perbaiki dua komentar yang salah ketik bila masih ada: `/* Web app entry point. */` dan `/* Aman dijalankan manual... */`.
3. Di **Project Settings → Script properties**, tambahkan `FM_API_KEY` dengan secret acak panjang (minimal 32 karakter). Secret yang sama dimasukkan ke `.env` server, jangan pernah ke HTML atau repository publik.
4. Jalankan `initializeDatabase()` sekali dari editor Apps Script sebagai pemilik, lalu izinkan akses. Ini membuat/memastikan sheet database. Jika database sudah dipakai, jangan menghapus sheet atau mengganti ID-nya.
5. **Deploy → New deployment → Web app**. Execute as: **Me**. Who has access: **Anyone** (API tetap memverifikasi secret pada setiap POST). Deploy dan salin URL berakhiran `/exec`.
6. Setelah perubahan kode, gunakan **Deploy → Manage deployments → Edit → New version → Deploy**.

## 2. Siapkan frontend/server
1. Gunakan Node.js 20 atau lebih baru.
2. Pindahkan `index.html` ke folder `public/index.html`.
3. Salin `.env.example` menjadi `.env`, lalu isi `GAS_WEB_APP_URL` dengan URL `/exec` dan `FM_API_KEY` dengan secret yang sama dengan Script Properties.
4. Jalankan `npm install`, kemudian `npm start`.
5. Buka `http://localhost:3000`. Jangan membuka `index.html` langsung dengan `file://`, karena frontend memanggil endpoint `/api`.

## 3. Hosting sendiri
- Upload seluruh project termasuk `public/index.html`, `server.js`, `package.json`, dan `package-lock.json` setelah `npm install`.
- Set environment variables `PORT`, `GAS_WEB_APP_URL`, dan `FM_API_KEY` di panel hosting; jangan upload file `.env` ke repository publik.
- Jalankan `npm start` menggunakan Node.js app manager/PM2 sesuai panel hosting. Pasang domain dan HTTPS melalui reverse proxy/panel hosting.
- Pastikan hosting mendukung Node.js 20+ dan outbound HTTPS ke `script.google.com`.

## 4. Uji fitur
1. Buka `/health`; hasil yang diharapkan `{"ok":true}`.
2. Buka dashboard dan periksa data kategori, akun, transaksi, template dari Google Sheets.
3. Uji tambah/edit/hapus transaksi, kategori, dan akun; uji simpan/hapus template; refresh browser dan pastikan data tetap ada.
4. Periksa terminal server dan **Apps Script → Executions** jika request gagal.

## Catatan penting
- Kode ini mempertahankan Google Sheets sebagai database dan memakai fungsi bisnis di Apps Script yang sudah ada.
- Template di backend yang diunggah hanya memiliki `createTemplate` dan `deleteTemplate`; UI juga menggunakan create/delete, bukan edit template.
- API key bersama membantu mencegah akses tanpa secret, tetapi ini bukan sistem login/per-user authorization. Siapa pun yang mendapatkan secret bisa memanggil API. Simpan secret di server dan Apps Script properties, rotasi jika bocor, dan pertimbangkan autentikasi aplikasi/rate limiting sebelum aplikasi dibuka untuk publik.
- Apps Script memiliki kuota dan batas eksekusi; aplikasi dengan banyak pengguna atau transaksi tinggi mungkin perlu backend/database khusus di masa depan.
