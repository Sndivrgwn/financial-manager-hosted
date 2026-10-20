# Financial Manager — Node.js + Google Sheets API (tanpa Apps Script)

Frontend tetap memakai `public/index.html`. Backend Express berkomunikasi langsung dengan Google Sheets API. Google Apps Script tidak dipakai oleh aplikasi ini.

## Prasyarat
- Node.js 20 atau lebih baru.
- Spreadsheet database yang sudah digunakan aplikasi sebelumnya (jangan buat spreadsheet baru jika ingin mempertahankan data lama).
- Google Cloud project dengan **Google Sheets API** diaktifkan.
- Service account JSON untuk backend.

## 1. Temukan spreadsheet ID yang benar
Buka spreadsheet database yang saat ini menyimpan data Financial Manager. Dari URL `https://docs.google.com/spreadsheets/d/ID_SPREADSHEET/edit`, salin bagian `ID_SPREADSHEET`.

Jika belum tahu spreadsheet yang digunakan Apps Script lama: buka Apps Script lama, periksa nilai `FINANCIAL_MANAGER_SPREADSHEET_ID` di Project Settings → Script properties. Pada kode lama yang memakai `UserProperties`, ID mungkin tersimpan sebagai User Property sehingga tidak terlihat di Script Properties. Dalam hal itu, buka spreadsheet database yang dipakai sebelumnya dari aplikasi/Drive dan gunakan ID-nya. Jangan jalankan inisialisasi database baru sebelum memastikan data lama.

## 2. Siapkan Google Sheets API dan service account
1. Buka Google Cloud Console dan buat/pilih project.
2. Aktifkan **Google Sheets API**.
3. Buat service account pada IAM & Admin → Service Accounts.
4. Buat key tipe JSON dan unduh file-nya.
5. Simpan file JSON sebagai `credentials/service-account.json` di folder project. Jangan commit file ini ke Git atau membagikannya.
6. Buka spreadsheet database, klik Share, lalu bagikan ke email service account (formatnya berakhiran `iam.gserviceaccount.com`) dengan akses **Editor**.

## 3. Konfigurasi dan jalankan
1. Salin `.env.example` menjadi `.env`.
2. Isi `GOOGLE_SHEET_ID` dengan ID spreadsheet lama.
3. Pastikan `GOOGLE_APPLICATION_CREDENTIALS=./credentials/service-account.json` sesuai lokasi file JSON.
4. Jalankan:

```bash
npm install
npm start
```

5. Buka `http://localhost:3000/health`; hasil yang diharapkan `{"ok":true,"provider":"google-sheets-api"}`.
6. Buka `http://localhost:3000` untuk aplikasi.

Backend akan memastikan tab dan header yang diperlukan tersedia, dan menambahkan data default hanya jika sheet Categories, Accounts, atau Settings kosong. Jangan arahkan `GOOGLE_SHEET_ID` ke spreadsheet yang salah.

## 4. Deploy ke hosting
Upload folder project beserta `public/index.html`, `server.js`, `package.json`, dan lockfile. Pasang dependency dengan `npm install`, lalu set environment variables di panel hosting. Letakkan file JSON service account di lokasi privat pada server dan atur `GOOGLE_APPLICATION_CREDENTIALS` ke path absolutnya. Jalankan `npm start` melalui Node.js app manager/PM2. Jangan publikasikan file JSON service account atau `.env`.

## Catatan
- Fitur API yang tersedia: dashboard/data, CRUD transaksi, kategori, akun, create/delete template.
- Template memang hanya memiliki operasi create/delete pada frontend yang disediakan.
- Google Sheets cocok untuk aplikasi kecil/pribadi, tetapi bukan database relasional dan punya kuota API. Untuk banyak pengguna/transaksi, pertimbangkan database seperti PostgreSQL/MySQL.
- Backend ini tidak lagi memakai URL `/exec`, `FM_API_KEY`, atau Google Apps Script. Setelah migrasi, variabel `GAS_WEB_APP_URL` dan `FM_API_KEY` tidak dibutuhkan.
- API ini belum menambahkan autentikasi pengguna aplikasi. Jangan membuka endpoint publik tanpa autentikasi/rate limiting jika data keuangan bersifat pribadi.
