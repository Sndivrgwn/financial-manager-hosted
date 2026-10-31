import 'dotenv/config';
import express from 'express';
import { google } from 'googleapis';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
const HEADERS = {
  Transactions: ['id','date','type','category','description','amount','account','paymentMethod','notes','createdAt','updatedAt','fromAccount','toAccount','billId','loanId'],
  Categories: ['id','name','type','color','icon','budget','createdAt'],
  Accounts: ['id','name','type','initialBalance','createdAt','loanId'],
  Settings: ['key','value'],
  Templates: ['id','title','type','categoryId','accountId','amount','createdAt','fromAccountId','toAccountId'],
  Bills: ['id','name','category','amount','issueDate','dueDate','status','paidAmount','notes','createdAt','updatedAt','loanId','paymentAccount','paymentTransactionId','transactionIds','paidAt'],
  Loans: ['id','lender','amount','date','account','dueDate','notes','status','paidAmount','createdAt','updatedAt','incomeTransactionId','category','billId','purpose','fundAccountId'],
  ProcessedRequests: ['requestId','method','resultJson','createdAt']
};
const MAX_PROCESSED_REQUESTS = 1000;
const MAX_TEMPLATES = 50;
const SHEET_CACHE_TTL_MS = 5000;
const sheetCache = new Map();
let databaseReadyPromise = null;

function invalidateSheetCache(sheetName) { sheetCache.delete(sheetName); }

async function fetchSheetValues(sheetName) {
  const cached = sheetCache.get(sheetName);
  if (cached && Date.now() - cached.timestamp < SHEET_CACHE_TTL_MS) return cached.values;
  const response = await sheetsApi.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${sheetName}!A:Z`, valueRenderOption: 'FORMATTED_VALUE', dateTimeRenderOption: 'FORMATTED_STRING' });
  const values = response.data.values || [];
  sheetCache.set(sheetName, { timestamp: Date.now(), values });
  return values;
}

if (!SPREADSHEET_ID) {
  console.error('Konfigurasi GOOGLE_SHEET_ID belum diisi di .env.');
  process.exit(1);
}

/* Terima JSON inline (hosting) atau path file (GOOGLE_APPLICATION_CREDENTIALS). */
function loadServiceAccount() {
  const inline = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (inline) {
    try { return JSON.parse(inline); }
    catch (error) {
      console.error('GOOGLE_SERVICE_ACCOUNT_JSON bukan JSON yang valid.');
      process.exit(1);
    }
  }
  const file = process.env.GOOGLE_APPLICATION_CREDENTIALS || './credentials/service-account.json';
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    console.error(`Kredensial service account tidak dapat dibaca dari ${file}. Isi GOOGLE_SERVICE_ACCOUNT_JSON atau GOOGLE_APPLICATION_CREDENTIALS.`);
    process.exit(1);
  }
}
const credentials = loadServiceAccount();

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: [
    'https://www.googleapis.com/auth/spreadsheets'
  ]
});
const sheetsApi = google.sheets({ version: 'v4', auth });
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

const clean = v => v === undefined || v === null ? '' : String(v).trim();
const num = v => { const n = Number(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };
const cellText = v => { const s = clean(v); return /^[=+\-@]/.test(s) ? `'${s}` : s; };
const validType = t => ['income','expense','transfer'].includes(t);
const newId = prefix => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2,10)}`;
const now = () => new Date().toISOString();
const colLetter = n => { let s=''; while(n){const r=(n-1)%26;s=String.fromCharCode(65+r)+s;n=Math.floor((n-1)/26);}return s; };
const localToday = () => { const d = new Date(); const p = n => String(n).padStart(2,'0'); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`; };
const daysFromToday = value => {
  const s = clean(value).slice(0,10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const target = Date.parse(`${s}T00:00:00`);
  const base = Date.parse(`${localToday()}T00:00:00`);
  if (Number.isNaN(target) || Number.isNaN(base)) return null;
  return Math.round((target - base) / 86400000);
};

async function metadata() {
  const r = await sheetsApi.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID, fields: 'spreadsheetId,spreadsheetUrl,sheets(properties(sheetId,title,index))' });
  return r.data;
}
async function initializeDatabaseOnce() {
  let meta = await metadata();
  const existing = new Set((meta.sheets || []).map(s => s.properties.title));
  const requests = [];
  for (const [title, headers] of Object.entries(HEADERS)) {
    if (!existing.has(title)) requests.push({ addSheet: { properties: { title } } });
  }
  if (requests.length) {
    await sheetsApi.spreadsheets.batchUpdate({ spreadsheetId: SPREADSHEET_ID, requestBody: { requests } });
    meta = await metadata();
  }
  for (const [title, headers] of Object.entries(HEADERS)) {
    const current = await sheetsApi.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${title}!1:1`, valueRenderOption: 'FORMATTED_VALUE' });
    const row = current.data.values?.[0] || [];
    if (!row.length) {
      await sheetsApi.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `${title}!A1:${colLetter(headers.length)}1`, valueInputOption: 'RAW', requestBody: { values: [headers] } });
    } else {
      const missing = headers.filter(h => !row.map(v => String(v).trim()).includes(h));
      if (missing.length) {
        const expanded = [...row, ...missing];
        await sheetsApi.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `${title}!A1:${colLetter(expanded.length)}1`, valueInputOption: 'RAW', requestBody: { values: [expanded] } });
      }
    }
  }
  const categories = await readRows('Categories');
  if (!categories.length) {
    const stamp = now();
    await appendRows('Categories', [
      ['CAT-IN-1','Gaji & Bonus','income','#22c55e','wallet',0,stamp],
      ['CAT-IN-2','Investasi','income','#10b981','trending-up',0,stamp],
      ['CAT-IN-3','Pekerjaan Sampingan','income','#3b82f6','laptop',0,stamp],
      ['CAT-EX-1','Makanan & Minuman','expense','#ef4444','utensils',2000000,stamp],
      ['CAT-EX-2','Transportasi','expense','#f97316','car',800000,stamp],
      ['CAT-EX-3','Belanja & Kebutuhan','expense','#ec4899','shopping-bag',1500000,stamp],
      ['CAT-EX-4','Tagihan & Utilitas','expense','#eab308','receipt',1000000,stamp],
      ['CAT-EX-5','Hiburan & Hobi','expense','#06b6d4','film',500000,stamp],
      ['CAT-EX-6','Kesehatan','expense','#14b8a6','heart-pulse',500000,stamp],
      ['CAT-IN-4','Pinjaman','income','#8b5cf6','hand-coins',0,stamp],
      ['CAT-EX-7','Cicilan & Pinjaman','expense','#a855f7','credit-card',0,stamp]
    ]);
  }
  if (!(await readRows('Accounts')).length) {
    const stamp = now();
    await appendRows('Accounts', [['ACC-1','Kas Tunai','cash',1000000,stamp],['ACC-2','Rekening Bank Primary','bank',5000000,stamp],['ACC-3','Dompet Digital / E-Wallet','ewallet',500000,stamp]]);
  }
  if (!(await readRows('Settings')).length) await appendRows('Settings', [['currency','IDR'],['dateFormat','YYYY-MM-DD'],['appName','Financial Manager']]);
  return meta;
}
async function ensureDatabase() {
  if (!databaseReadyPromise) {
    databaseReadyPromise = initializeDatabaseOnce().catch(error => {
      databaseReadyPromise = null;
      throw error;
    });
  }
  return databaseReadyPromise;
}
async function readRows(sheetName) {
  const values = await fetchSheetValues(sheetName);
  if (values.length < 2) return [];
  const headers = values[0].map(v => String(v || '').trim());
  return values.slice(1).filter(row => row.some(v => v !== '' && v !== null && v !== undefined)).map(row => {
    const obj = {};
    headers.forEach((h, i) => { if (h) obj[h] = row[i] ?? ''; });
    return obj;
  });
}
async function rawRows(sheetName) {
  const values = await fetchSheetValues(sheetName);
  return { headers: (values[0] || []).map(v => String(v || '').trim()), rows: values.slice(1) };
}
async function appendRows(sheetName, rows) {
  if (!rows.length) return;
  await sheetsApi.spreadsheets.values.append({ spreadsheetId: SPREADSHEET_ID, range: `${sheetName}!A:Z`, valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS', requestBody: { values: rows } });
  invalidateSheetCache(sheetName);
}
async function writeObjectRow(sheetName, rowNumber, object) {
  const { headers } = await rawRows(sheetName);
  const row = headers.map(h => object[h] ?? '');
  await sheetsApi.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `${sheetName}!A${rowNumber}:${colLetter(headers.length)}${rowNumber}`, valueInputOption: 'USER_ENTERED', requestBody: { values: [row] } });
  invalidateSheetCache(sheetName);
}
async function appendObject(sheetName, object) {
  const { headers } = await rawRows(sheetName);
  await appendRows(sheetName, [headers.map(h => object[h] ?? '')]);
}
async function findRow(sheetName, id) {
  const { headers, rows } = await rawRows(sheetName);
  const idIndex = headers.indexOf('id');
  const idx = rows.findIndex(r => String(r[idIndex] ?? '') === String(id));
  return idx < 0 ? null : { rowNumber: idx + 2, headers, values: rows[idx], object: Object.fromEntries(headers.map((h,i)=>[h,rows[idx][i] ?? ''])) };
}
async function deleteRow(sheetName, rowNumber) {
  const meta = await metadata();
  const sheet = meta.sheets.find(s => s.properties.title === sheetName);
  if (!sheet) throw new Error(`Sheet ${sheetName} tidak ditemukan.`);
  await sheetsApi.spreadsheets.batchUpdate({ spreadsheetId: SPREADSHEET_ID, requestBody: { requests: [{ deleteDimension: { range: { sheetId: sheet.properties.sheetId, dimension: 'ROWS', startIndex: rowNumber - 1, endIndex: rowNumber } } }] } });
  invalidateSheetCache(sheetName);
}
async function findByIdOrName(sheetName, ref) {
  const key = clean(ref); if (!key) return null;
  const rows = await readRows(sheetName);
  return rows.find(r => String(r.id) === key) || rows.find(r => String(r.name) === key) || null;
}
async function nameTaken(sheetName, name, exceptId) {
  return (await readRows(sheetName)).some(r => String(r.name).toLowerCase() === String(name).toLowerCase() && String(r.id) !== String(exceptId));
}
async function columnContains(sheetName, columnName, value) {
  return (await readRows(sheetName)).some(r => String(r[columnName] ?? '') === String(value));
}
/* Ganti nilai satu kolom di sheet mana pun (dipakai saat nama akun berubah). */
async function updateSheetReferences(sheetName, columnName, oldValue, newValue) {
  const { headers, rows } = await rawRows(sheetName);
  const col = headers.indexOf(columnName);
  if (col < 0) return;
  const updates = [];
  rows.forEach((row, i) => { if (String(row[col] ?? '') === String(oldValue)) updates.push({ range: `${sheetName}!${colLetter(col+1)}${i+2}`, values: [[newValue]] }); });
  if (updates.length) {
    await sheetsApi.spreadsheets.values.batchUpdate({ spreadsheetId: SPREADSHEET_ID, requestBody: { valueInputOption: 'RAW', data: updates } });
    invalidateSheetCache(sheetName);
  }
}
async function updateReferences(columnName, oldValue, newValue) {
  await updateSheetReferences('Transactions', columnName, oldValue, newValue);
}
/* Nama akun tidak boleh bentrok dengan akun lain. */
async function uniqueAccountName(desired) {
  const base = clean(desired).slice(0, 60) || 'Pinjaman';
  let candidate = base;
  for (let i = 2; i < 100; i++) {
    if (!(await nameTaken('Accounts', candidate, null))) return candidate;
    candidate = `${base} ${i}`.slice(0, 60);
  }
  return `${base} ${Date.now()}`.slice(0, 60);
}
function validateDate(value) {
  const s = clean(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error('Format tanggal harus YYYY-MM-DD.');
  const [y,m,d] = s.split('-').map(Number); const dt = new Date(y,m-1,d);
  if (dt.getFullYear()!==y || dt.getMonth()!==m-1 || dt.getDate()!==d) throw new Error('Tanggal tidak valid.');
  return s;
}
async function idempotent(method, data, operation) {
  if (data?.requestId) {
    const requests = await readRows('ProcessedRequests');
    const prior = requests.find(r => String(r.requestId) === String(data.requestId) && String(r.method) === method);
    if (prior) { try { return JSON.parse(prior.resultJson); } catch { throw new Error('Catatan idempotensi rusak.'); } }
  }
  const result = await operation();
  if (data?.requestId) {
    await appendRows('ProcessedRequests', [[String(data.requestId),method,JSON.stringify(result),now()]]);
    const reqs = await readRows('ProcessedRequests');
    if (reqs.length > MAX_PROCESSED_REQUESTS) {
      const { rows } = await rawRows('ProcessedRequests');
      const meta = await metadata(); const sh = meta.sheets.find(s=>s.properties.title==='ProcessedRequests');
      await sheetsApi.spreadsheets.batchUpdate({spreadsheetId:SPREADSHEET_ID,requestBody:{requests:[{deleteDimension:{range:{sheetId:sh.properties.sheetId,dimension:'ROWS',startIndex:1,endIndex:Math.min(501, rows.length+1)}}}]}});
    }
  }
  return result;
}
async function getAppData() {
  await ensureDatabase();
  const categoriesRaw = await readRows('Categories');
  const accountsRaw = await readRows('Accounts');
  const txRaw = await readRows('Transactions');
  const settingsRows = await readRows('Settings');
  const templatesRaw = await readRows('Templates');
  const billsRaw = await readRows('Bills');
  const loansRaw = await readRows('Loans');
  const settings = Object.fromEntries(settingsRows.map(r => [r.key, r.value]));
  const catByName = Object.fromEntries(categoriesRaw.map(c => [String(c.name), c]));
  const accByName = Object.fromEntries(accountsRaw.map(a => [String(a.name), a]));
  const categories = categoriesRaw.map(c => ({ ...c, budget: num(c.budget) }));
  const transactions = txRaw.map(tx => {
    const cat = catByName[String(tx.category)]; const acc = accByName[String(tx.account)];
    const from = tx.fromAccount ? accByName[String(tx.fromAccount)] : null; const to = tx.toAccount ? accByName[String(tx.toAccount)] : null;
    return { ...tx, title: tx.description, amount: num(tx.amount), categoryId: cat?.id || '', accountId: acc?.id || '', fromAccountId: from?.id || '', toAccountId: to?.id || '' };
  });
  const accounts = accountsRaw.map(account => {
    const initialBalance = num(account.initialBalance); let net = 0;
    transactions.forEach(tx => {
      const type = String(tx.type).toLowerCase();
      if (type === 'income' && String(tx.account) === String(account.name)) net += tx.amount;
      else if (type === 'expense' && String(tx.account) === String(account.name)) net -= tx.amount;
      else if (type === 'transfer') {
        if (String(tx.fromAccount) === String(account.name) || String(tx.fromAccountId) === String(account.id)) net -= tx.amount;
        if (String(tx.toAccount) === String(account.name) || String(tx.toAccountId) === String(account.id)) net += tx.amount;
      }
    });
    return { ...account, initialBalance, openingBalance: initialBalance, currentBalance: initialBalance + net };
  });
  const bills = billsRaw.map(b => mapBill(b, catByName));
  const accById = Object.fromEntries(accountsRaw.map(a => [String(a.id), a]));
  const loans = loansRaw.map(l => mapLoan(l, accByName, accById));
  return { success: true, categories, accounts, transactions, templates: templatesRaw.map(t=>({...t,amount:num(t.amount)})), bills, loans, settings, spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit` };
}
async function buildTransaction(data) {
  const type = clean(data.type); if (!validType(type) || type === 'transfer' && !validType(type)) throw new Error('Tipe transaksi harus income, expense, atau transfer.');
  const description = clean(data.description || data.title || (type === 'transfer' ? 'Transfer Antar Akun' : ''));
  const amount = Number(data.amount);
  if (!data.date) throw new Error('Tanggal transaksi wajib diisi.');
  if (!description) throw new Error('Deskripsi/Judul transaksi wajib diisi.');
  if (description.length > 150) throw new Error('Deskripsi maksimal 150 karakter.');
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Nominal harus berupa angka positif.');
  if (String(data.notes || '').length > 1000) throw new Error('Catatan terlalu panjang.');
  let category='', account='', fromAccount='', toAccount='';
  if (type === 'transfer') {
    const from = await findByIdOrName('Accounts', data.fromAccountId || data.fromAccount);
    const to = await findByIdOrName('Accounts', data.toAccountId || data.toAccount);
    if (!from || !to) throw new Error('Akun asal dan akun tujuan wajib dipilih.');
    if (String(from.id)===String(to.id) || String(from.name)===String(to.name)) throw new Error('Akun asal dan akun tujuan tidak boleh sama.');
    if (type === 'transfer') await assertLoanFundAvailable(from, amount, data.id);
    fromAccount=String(from.name); toAccount=String(to.name); account=fromAccount; category='Transfer';
  } else {
    const cat = await findByIdOrName('Categories', data.categoryId || data.category);
    if (!cat) throw new Error('Kategori tidak ditemukan. Muat ulang data lalu coba lagi.');
    if (cat.type && cat.type !== type) throw new Error(`Kategori "${cat.name}" bukan kategori ${type==='income'?'pemasukan':'pengeluaran'}.`);
    const acc = await findByIdOrName('Accounts', data.accountId || data.account);
    if (!acc) throw new Error('Akun tidak ditemukan. Muat ulang data lalu coba lagi.');
    category=String(cat.name); account=String(acc.name);
    /* Dana pinjaman tidak boleh terpakai melebihi saldo yang tersedia. */
    if (type === 'expense') await assertLoanFundAvailable(acc, amount, data.id);
  }
  return { date: validateDate(data.date), type, category, description: cellText(description), amount, account, paymentMethod: cellText(data.paymentMethod || '-'), notes: cellText(data.notes || ''), fromAccount, toAccount };
}
async function createTransaction(d={}) {
  return idempotent('createTransaction',d,async()=>{ const rec=await buildTransaction(d); const id=newId('TXN'); const stamp=now(); await appendTransactionRecord({...rec,id,createdAt:stamp,updatedAt:stamp,billId:'',loanId:''}); return {success:true,message:'Transaksi berhasil ditambahkan',id}; });
}
async function updateTransaction(d={}) {
  const id=clean(d.id); if(!id) throw new Error('ID transaksi tidak valid.');
  return idempotent('updateTransaction',d,async()=>{
    const found=await findRow('Transactions',id);
    if(!found) throw new Error('Transaksi tidak ditemukan.');
    /* Transaksi turunan tagihan/pinjaman dijaga agar relasi dan saldo tetap konsisten. */
    if(clean(found.object.billId)||clean(found.object.loanId)) throw new Error('Transaksi pembayaran tagihan/pinjaman tidak dapat diedit. Hapus transaksi bila perlu dikoreksi.');
    const rec=await buildTransaction(d); const stamp=now();
    await writeObjectRow('Transactions',found.rowNumber,{...rec,id,createdAt:found.object.createdAt||stamp,updatedAt:stamp,billId:found.object.billId||'',loanId:found.object.loanId||''});
    return {success:true,message:'Transaksi berhasil diperbarui',id};
  });
}
async function deleteTransaction(d={}) {
  const id=clean(d.id); if(!id) throw new Error('ID transaksi tidak valid.');
  return idempotent('deleteTransaction',d,async()=>{
    const f=await findRow('Transactions',id);
    if(!f) return {success:true,message:'Transaksi sudah tidak ada',id};
    /* Pemasukan pinjaman hanya boleh dibatalkan lewat menu Pinjaman. */
    if(clean(f.object.loanId) && String(f.object.type)==='income') throw new Error('Transaksi pemasukan pinjaman tidak dapat dihapus di sini. Hapus pinjamannya melalui menu Pinjaman.');
    const billId=clean(f.object.billId);
    await deleteRow('Transactions',f.rowNumber);
    /* Transaksi pembayaran: kembalikan nominal tagihan/pinjaman agar konsisten. */
    if(billId){
      try{ await revertBillPayment(billId,num(f.object.amount),id); }
      catch(error){ try{ await restoreRow('Transactions',f.values); } catch(_){ /* best effort */ } throw error; }
    }
    return {success:true,message:'Transaksi berhasil dihapus',id};
  });
}
async function createCategory(d={}) {
  const name=clean(d.name); if(!name || !['income','expense'].includes(d.type)) throw new Error('Nama kategori dan jenis income/expense wajib diisi.'); const budget=num(d.budget);
  return idempotent('createCategory',d,async()=>{if(await nameTaken('Categories',name,null)) throw new Error(`Kategori "${name}" sudah ada.`); const id=newId('CAT'); await appendRows('Categories',[[id,cellText(name),d.type,clean(d.color||'#ec643d'),clean(d.icon||'folder'),budget,now()]]); return {success:true,message:'Kategori berhasil dibuat',id};});
}
async function updateCategory(d={}) {
  const id=clean(d.id), name=clean(d.name); if(!id) throw new Error('ID kategori tidak valid.'); if(!name || !['income','expense'].includes(d.type)) throw new Error('Nama kategori dan jenis income/expense wajib diisi.');
  return idempotent('updateCategory',d,async()=>{const f=await findRow('Categories',id);if(!f)throw new Error('Kategori tidak ditemukan.');if(await nameTaken('Categories',name,id))throw new Error(`Kategori "${name}" sudah ada.`);const oldName=String(f.object.name);if(f.object.type!==d.type && await columnContains('Transactions','category',oldName))throw new Error('Jenis kategori tidak dapat diubah karena sudah dipakai transaksi.');await writeObjectRow('Categories',f.rowNumber,{...f.object,name:cellText(name),type:d.type,color:clean(d.color||f.object.color||'#ec643d'),icon:clean(d.icon||f.object.icon||'folder'),budget:num(d.budget)});if(oldName!==name)await updateReferences('category',oldName,name);return {success:true,message:'Kategori berhasil diperbarui',id};});
}
async function deleteCategory(d={}) { const id=clean(d.id);if(!id)throw new Error('ID kategori tidak valid.');return idempotent('deleteCategory',d,async()=>{const f=await findRow('Categories',id);if(!f)return{success:true,message:'Kategori sudah tidak ada',id};if(await columnContains('Transactions','category',f.object.name))throw new Error(`Kategori "${f.object.name}" masih digunakan transaksi.`);await deleteRow('Categories',f.rowNumber);return{success:true,message:'Kategori berhasil dihapus',id};}); }
function validateAccount(d={}) { const name=clean(d.name),type=clean(d.type);if(!name||!type)throw new Error('Nama dan jenis akun wajib diisi.');const raw=d.initialBalance!==undefined?d.initialBalance:d.openingBalance;const initialBalance=Number(raw===undefined||raw===''?0:raw);if(!Number.isFinite(initialBalance))throw new Error('Saldo awal harus berupa angka.');return{name,type,initialBalance}; }
async function createAccount(d={}) { const v=validateAccount(d);return idempotent('createAccount',d,async()=>{if(v.type==='loan')throw new Error('Akun sumber dana pinjaman hanya dibuat otomatis saat mencatat pinjaman.');if(await nameTaken('Accounts',v.name,null))throw new Error(`Akun "${v.name}" sudah ada.`);const id=newId('ACC');await appendRows('Accounts',[[id,cellText(v.name),v.type,v.initialBalance,now(),'']]);return{success:true,message:'Akun berhasil dibuat',id};}); }async function updateAccount(d = {}) { const id=clean(d.id);if(!id)throw new Error('ID akun tidak valid.');const v=validateAccount(d);return idempotent('updateAccount',d,async()=>{const f=await findRow('Accounts',id);if(!f)throw new Error('Akun tidak ditemukan.');
  /* Akun sumber dana pinjaman dijaga: jenis dan saldonya mengikuti pinjaman. */
  const loanId=clean(f.object.loanId);
  if(loanId){
    if(v.type!=='loan')throw new Error('Jenis akun sumber dana pinjaman tidak dapat diubah.');
    if(v.initialBalance!==num(f.object.initialBalance))throw new Error('Saldo akun sumber dana pinjaman dihitung otomatis dari transaksi dan tidak dapat diubah manual.');
  }
  if(await nameTaken('Accounts',v.name,id))throw new Error(`Akun "${v.name}" sudah ada.`);const old=String(f.object.name);await writeObjectRow('Accounts',f.rowNumber,{...f.object,name:cellText(v.name),type:v.type,initialBalance:v.initialBalance});if(old!==v.name){for(const c of ['account','fromAccount','toAccount'])await updateReferences(c,old,v.name);await updateSheetReferences('Loans','account',old,v.name);await updateSheetReferences('Bills','paymentAccount',old,v.name);}return{success:true,message:'Akun berhasil diperbarui',id};}); }
async function deleteAccount(d={}) { const id=clean(d.id);if(!id)throw new Error('ID akun tidak valid.');return idempotent('deleteAccount',d,async()=>{const f=await findRow('Accounts',id);if(!f)return{success:true,message:'Akun sudah tidak ada',id};if(clean(f.object.loanId))throw new Error('Akun sumber dana pinjaman tidak dapat dihapus. Hapus pinjamannya melalui menu Pinjaman.');for(const c of ['account','fromAccount','toAccount'])if(await columnContains('Transactions',c,f.object.name))throw new Error(`Akun "${f.object.name}" masih digunakan transaksi.`);await deleteRow('Accounts',f.rowNumber);return{success:true,message:'Akun berhasil dihapus',id};}); }
async function createTemplate(d={}) { const title=clean(d.title),amount=Number(d.amount===undefined||d.amount===''?0:d.amount);if(!title)throw new Error('Nama template wajib diisi.');if(title.length>120)throw new Error('Nama template maksimal 120 karakter.');if(!validType(d.type))throw new Error('Jenis template tidak valid.');if(!Number.isFinite(amount)||amount<0)throw new Error('Nominal template tidak valid.');return idempotent('createTemplate',d,async()=>{const rows=await readRows('Templates');if(rows.length>=MAX_TEMPLATES)throw new Error(`Jumlah template maksimal ${MAX_TEMPLATES}.`);if(rows.some(r=>String(r.title).toLowerCase()===title.toLowerCase()))throw new Error(`Template "${title}" sudah ada.`);const id=newId('TPL');await appendRows('Templates',[[id,cellText(title),d.type,clean(d.categoryId),clean(d.accountId),amount,now(),clean(d.fromAccountId),clean(d.toAccountId)]]);return{success:true,message:'Template berhasil disimpan',id};}); }
async function deleteTemplate(d={}) { const id=clean(d.id);if(!id)throw new Error('ID template tidak valid.');return idempotent('deleteTemplate',d,async()=>{const f=await findRow('Templates',id);if(f)await deleteRow('Templates',f.rowNumber);return{success:true,message:f?'Template berhasil dihapus':'Template sudah tidak ada',id};}); }

/* ========================================================================
 * TAGIHAN & PINJAMAN
 * Satu tagihan = satu kewajiban. Satu pinjaman selalu menghasilkan:
 *   1 akun sumber dana (tipe 'loan') + 1 transaksi pemasukan (dana diterima)
 *   + 1 tagihan pembayaran (relasi loanId).
 * Pembayaran tagihan selalu menghasilkan 1 transaksi pengeluaran (relasi billId).
 * ===================================================================== */

/* Akun sumber dana pinjaman: tipe 'loan' atau terikat pada satu pinjaman. */
function isLoanFundAccount(account) {
  return Boolean(account) && (String(account.type || '').toLowerCase() === 'loan' || Boolean(clean(account.loanId)));
}

/* Saldo dana pinjaman selalu diturunkan dari transaksi, bukan angka statis.
   excludeTxId dipakai saat transaksi sedang diedit agar tidak dihitung dua kali. */
async function loanFundBalance(account, excludeTxId) {
  const rows = await readRows('Transactions');
  const name = String(account.name);
  let net = 0;
  for (const tx of rows) {
    if (excludeTxId && String(tx.id || '') === String(excludeTxId)) continue;
    const amount = num(tx.amount);
    const type = String(tx.type || '').toLowerCase();
    if (type === 'income' && String(tx.account) === name) net += amount;
    else if (type === 'expense' && String(tx.account) === name) net -= amount;
    else if (type === 'transfer') {
      if (String(tx.fromAccount) === name) net -= amount;
      if (String(tx.toAccount) === name) net += amount;
    }
  }
  return num(account.initialBalance) + net;
}

/* Pengeluaran/transfer tidak boleh menghabiskan dana pinjaman melebihi saldo tersedia. */
async function assertLoanFundAvailable(account, amount, excludeTxId) {
  if (!isLoanFundAccount(account)) return;
  const balance = await loanFundBalance(account, excludeTxId);
  if (Number(amount) > balance) {
    const short = Math.max(0, Math.floor(balance));
    throw new Error(`Nominal melebihi saldo dana pinjaman pada akun "${account.name}" (${short}).`);
  }
}

/* Cari kategori berdasarkan id/nama; buat kategori bawaan bila belum ada. */
async function resolveCategory(ref, type, fallbackName) {
  const key = clean(ref);
  if (key) {
    const found = await findByIdOrName('Categories', key);
    if (found && String(found.type) === type) return found;
  }
  const rows = await readRows('Categories');
  const typed = rows.filter(r => String(r.type) === type);
  const wanted = clean(fallbackName);
  if (wanted) {
    const exact = typed.find(r => String(r.name).toLowerCase() === wanted.toLowerCase());
    if (exact) return exact;
    const clash = rows.some(r => String(r.name).toLowerCase() === wanted.toLowerCase());
    if (!clash) {
      const id = newId('CAT');
      await appendRows('Categories', [[id, cellText(wanted), type, type === 'income' ? '#8b5cf6' : '#ef4444', type === 'income' ? 'hand-coins' : 'credit-card', 0, now()]]);
      return { id, name: wanted, type };
    }
  }
  if (typed.length) return typed[0];
  throw new Error(`Kategori ${type === 'income' ? 'pemasukan' : 'pengeluaran'} belum tersedia. Tambahkan kategori terlebih dahulu.`);
}

function billStatusOf(row) {
  const total = num(row.amount), paid = num(row.paidAmount);
  if (total > 0 && paid >= total) return 'paid';
  const left = daysFromToday(row.dueDate);
  if (left !== null && left < 0) return 'overdue';
  return paid > 0 ? 'partial' : 'unpaid';
}

function mapBill(row, catByName) {
  const total = num(row.amount), paid = num(row.paidAmount);
  const status = billStatusOf(row);
  const cat = catByName ? catByName[String(row.category)] : null;
  return {
    ...row,
    amount: total,
    paidAmount: paid,
    remaining: Math.max(0, total - paid),
    status,
    isOverdue: status === 'overdue',
    daysLeft: daysFromToday(row.dueDate),
    categoryId: cat ? cat.id : ''
  };
}

function mapLoan(row, accByName, accById) {
  const total = num(row.amount), paid = num(row.paidAmount);
  const status = total > 0 && paid >= total ? 'paid' : paid > 0 ? 'partial' : 'unpaid';
  const acc = accByName ? accByName[String(row.account)] : null;
  const fund = accById ? accById[String(row.fundAccountId || '')] : null;
  return {
    ...row,
    amount: total,
    paidAmount: paid,
    remaining: Math.max(0, total - paid),
    status,
    accountId: acc ? acc.id : (fund ? fund.id : ''),
    fundAccountId: fund ? fund.id : clean(row.fundAccountId),
    fundAccountName: fund ? fund.name : ''
  };
}

/* Tulis satu transaksi lengkap (termasuk relasi tagihan/pinjaman). */
async function appendTransactionRecord(rec) {
  await appendRows('Transactions', [[
    rec.id, rec.date, rec.type, rec.category, cellText(rec.description), rec.amount, rec.account,
    cellText(rec.paymentMethod || '-'), cellText(rec.notes || ''), rec.createdAt, rec.updatedAt,
    rec.fromAccount || '', rec.toAccount || '', rec.billId || '', rec.loanId || ''
  ]]);
}

async function restoreRow(sheetName, values) {
  await sheetsApi.spreadsheets.values.append({ spreadsheetId: SPREADSHEET_ID, range: `${sheetName}!A:Z`, valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS', requestBody: { values: [values] } });
  invalidateSheetCache(sheetName);
}

async function rollbackCreated(pairs) {
  for (const [sheetName, id] of pairs) {
    try {
      const found = await findRow(sheetName, id);
      if (found) await deleteRow(sheetName, found.rowNumber);
    } catch (error) {
      console.error(`[rollback:${sheetName}]`, id, error?.message || error);
    }
  }
}

async function applyLoanPayment(loanId, delta) {
  const id = clean(loanId);
  if (!id) return;
  const found = await findRow('Loans', id);
  if (!found) return;
  const loan = found.object;
  const total = num(loan.amount);
  const paid = Math.min(total, Math.max(0, num(loan.paidAmount) + Number(delta || 0)));
  await writeObjectRow('Loans', found.rowNumber, {
    ...loan,
    paidAmount: paid,
    status: paid <= 0 ? 'unpaid' : paid >= total ? 'paid' : 'partial',
    updatedAt: now()
  });
}

/* Kebalikan dari pembayaran: dipakai saat transaksi pembayaran dihapus. */
async function revertBillPayment(billId, amount, transactionId) {
  const found = await findRow('Bills', billId);
  if (!found) return;
  const bill = found.object;
  const total = num(bill.amount);
  const newPaid = Math.max(0, num(bill.paidAmount) - num(amount));
  const ids = String(bill.transactionIds || '').split(',').map(s => s.trim()).filter(x => x && x !== String(transactionId));
  const status = newPaid <= 0 ? 'unpaid' : newPaid >= total ? 'paid' : 'partial';
  await writeObjectRow('Bills', found.rowNumber, {
    ...bill,
    paidAmount: newPaid,
    status,
    transactionIds: ids.join(','),
    paymentTransactionId: ids.length ? ids[ids.length - 1] : '',
    paidAt: status === 'paid' ? (bill.paidAt || now()) : '',
    updatedAt: now()
  });
  if (clean(bill.loanId)) await applyLoanPayment(bill.loanId, -Number(amount || 0));
}

function validateBill(d = {}) {
  const name = clean(d.name);
  const amount = Number(d.amount);
  if (!name) throw new Error('Nama tagihan wajib diisi.');
  if (name.length > 120) throw new Error('Nama tagihan maksimal 120 karakter.');
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Nominal tagihan harus berupa angka positif.');
  if (!d.issueDate) throw new Error('Tanggal tagihan wajib diisi.');
  const issueDate = validateDate(d.issueDate);
  if (!d.dueDate) throw new Error('Tanggal jatuh tempo wajib diisi.');
  const dueDate = validateDate(d.dueDate);
  if (dueDate < issueDate) throw new Error('Jatuh tempo tidak boleh sebelum tanggal tagihan.');
  if (String(d.notes || '').length > 1000) throw new Error('Catatan terlalu panjang.');
  return { name, amount, issueDate, dueDate, notes: clean(d.notes) };
}

async function createBill(d = {}) {
  return idempotent('createBill', d, async () => {
    const v = validateBill(d);
    const cat = await resolveCategory(d.category || d.categoryId, 'expense', 'Tagihan & Utilitas');
    const id = newId('BILL');
    const stamp = now();
    await appendRows('Bills', [[id, cellText(v.name), String(cat.name), v.amount, v.issueDate, v.dueDate, 'unpaid', 0, cellText(v.notes), stamp, stamp, '', '', '', '', '']]);
    return { success: true, message: 'Tagihan berhasil dibuat', id };
  });
}

async function updateBill(d = {}) {
  const id = clean(d.id);
  if (!id) throw new Error('ID tagihan tidak valid.');
  return idempotent('updateBill', d, async () => {
    const v = validateBill(d);
    const found = await findRow('Bills', id);
    if (!found) throw new Error('Tagihan tidak ditemukan.');
    const bill = found.object;
    const paid = num(bill.paidAmount);
    const loanId = clean(bill.loanId);
    if (loanId && v.amount !== num(bill.amount)) throw new Error('Nominal tagihan pinjaman mengikuti data pinjaman dan tidak dapat diubah di sini.');
    if (v.amount < paid) throw new Error('Nominal tagihan tidak boleh lebih kecil dari jumlah yang sudah dibayar.');
    const catName = loanId ? String(bill.category) : String((await resolveCategory(d.category || d.categoryId, 'expense', clean(bill.category) || 'Tagihan & Utilitas')).name);
    const status = paid <= 0 ? 'unpaid' : paid >= v.amount ? 'paid' : 'partial';
    await writeObjectRow('Bills', found.rowNumber, {
      ...bill,
      name: cellText(v.name),
      category: catName,
      amount: v.amount,
      issueDate: v.issueDate,
      dueDate: v.dueDate,
      notes: cellText(v.notes),
      status,
      updatedAt: now()
    });
    if (loanId) {
      const loanRow = await findRow('Loans', loanId);
      if (loanRow) await writeObjectRow('Loans', loanRow.rowNumber, { ...loanRow.object, dueDate: v.dueDate, updatedAt: now() });
    }
    return { success: true, message: 'Tagihan berhasil diperbarui', id };
  });
}

async function deleteBill(d = {}) {
  const id = clean(d.id);
  if (!id) throw new Error('ID tagihan tidak valid.');
  return idempotent('deleteBill', d, async () => {
    const found = await findRow('Bills', id);
    if (!found) return { success: true, message: 'Tagihan sudah tidak ada', id };
    if (clean(found.object.loanId)) throw new Error('Tagihan ini terikat pada pinjaman. Kelola melalui menu Pinjaman.');
    if (num(found.object.paidAmount) > 0) throw new Error('Tagihan yang sudah memiliki pembayaran tidak dapat dihapus.');
    await deleteRow('Bills', found.rowNumber);
    return { success: true, message: 'Tagihan berhasil dihapus', id };
  });
}

async function payBill(d = {}) {
  const billId = clean(d.id || d.billId);
  if (!billId) throw new Error('ID tagihan tidak valid.');
  return idempotent('payBill', d, async () => {
    const found = await findRow('Bills', billId);
    if (!found) throw new Error('Tagihan tidak ditemukan.');
    const bill = found.object;
    const total = num(bill.amount);
    const paid = num(bill.paidAmount);
    const remaining = Math.max(0, total - paid);
    if (remaining <= 0) throw new Error('Tagihan ini sudah dibayar penuh.');
    const amount = d.amount === undefined || d.amount === null || d.amount === '' ? remaining : Number(d.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('Nominal pembayaran harus berupa angka positif.');
    if (amount > remaining) throw new Error(`Nominal pembayaran melebihi sisa tagihan (${remaining}).`);
    const acc = await findByIdOrName('Accounts', d.accountId || d.account);
    if (!acc) throw new Error('Akun pembayaran tidak ditemukan.');
    /* Pembayaran pinjaman tidak boleh mengurangi saldo akun sumber dana pinjaman itu sendiri. */
    if (clean(bill.loanId)) {
      const loanRow = await findRow('Loans', clean(bill.loanId));
      if (loanRow) {
        const fundId = clean(loanRow.object.fundAccountId);
        const fundName = clean(loanRow.object.account);
        if ((fundId && String(acc.id) === fundId) || (fundName && String(acc.name) === fundName)) {
          throw new Error('Pembayaran pinjaman tidak boleh menggunakan akun sumber dana pinjaman itu sendiri. Pilih rekening bank, e-wallet, atau tunai lain.');
        }
      }
    }
    await assertLoanFundAvailable(acc, amount);
    const cat = await resolveCategory(bill.category, 'expense', clean(bill.category) || 'Tagihan & Utilitas');
    const date = d.date ? validateDate(d.date) : localToday();
    const stamp = now();
    const txId = newId('TXN');
    const label = String(bill.name || 'tagihan').slice(0, 90);
    const alreadyPrefixed = /^pembayaran\b/i.test(label);
    const notes = clean(d.notes) || (alreadyPrefixed ? label : `Pembayaran tagihan ${label}`).slice(0, 1000);
    await appendTransactionRecord({
      id: txId,
      date,
      type: 'expense',
      category: String(cat.name),
      description: (alreadyPrefixed ? label : `Pembayaran ${label}`).slice(0, 150),
      amount,
      account: String(acc.name),
      paymentMethod: '-',
      notes,
      createdAt: stamp,
      updatedAt: stamp,
      billId,
      loanId: clean(bill.loanId)
    });
    const newPaid = paid + amount;
    const status = newPaid >= total ? 'paid' : 'partial';
    const ids = [clean(bill.transactionIds), txId].filter(Boolean).join(',');
    try {
      await writeObjectRow('Bills', found.rowNumber, {
        ...bill,
        paidAmount: newPaid,
        status,
        paymentAccount: String(acc.name),
        paymentTransactionId: txId,
        transactionIds: ids,
        paidAt: status === 'paid' ? stamp : clean(bill.paidAt),
        updatedAt: stamp
      });
    } catch (error) {
      await rollbackCreated([['Transactions', txId]]);
      throw error;
    }
    if (clean(bill.loanId)) await applyLoanPayment(bill.loanId, amount);
    return {
      success: true,
      message: status === 'paid' ? 'Tagihan berhasil dibayar dan lunas.' : 'Pembayaran sebagian berhasil dicatat.',
      billId,
      transactionId: txId,
      amount,
      remaining: Math.max(0, total - newPaid)
    };
  });
}

function validateLoan(d = {}) {
  const lender = clean(d.lender || d.name);
  if (!lender) throw new Error('Nama pemberi pinjaman wajib diisi.');
  if (lender.length > 100) throw new Error('Nama pemberi pinjaman maksimal 100 karakter.');
  const purpose = clean(d.purpose || d.loanPurpose);
  if (purpose.length > 120) throw new Error('Nama/tujuan pinjaman maksimal 120 karakter.');
  const amount = Number(d.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Nominal pinjaman harus berupa angka positif.');
  if (!d.date) throw new Error('Tanggal pinjaman wajib diisi.');
  const date = validateDate(d.date);
  if (!d.dueDate) throw new Error('Tanggal jatuh tempo wajib diisi.');
  const dueDate = validateDate(d.dueDate);
  if (dueDate < date) throw new Error('Jatuh tempo tidak boleh sebelum tanggal pinjaman.');
  if (String(d.notes || '').length > 1000) throw new Error('Catatan terlalu panjang.');
  return { lender, purpose, amount, date, dueDate, notes: clean(d.notes) };
}

async function createLoan(d = {}) {
  return idempotent('createLoan', d, async () => {
    const v = validateLoan(d);
    const incomeCat = await resolveCategory(d.category || d.categoryId, 'income', 'Pinjaman');
    const payCat = await resolveCategory('', 'expense', 'Cicilan & Pinjaman');
    const loanId = newId('LOAN');
    const billId = newId('BILL');
    const txId = newId('TXN');
    const accId = newId('ACC');
    const stamp = now();
    const label = v.lender.length > 90 ? `${v.lender.slice(0, 90)}…` : v.lender;
    /* Satu akun sumber dana per pinjaman; dana diterima sebagai saldo awal lewat transaksi pemasukan. */
    const accName = await uniqueAccountName(v.purpose ? `Pinjaman: ${v.purpose}` : `Pinjaman dari ${v.lender}`);
    try {
      await appendRows('Accounts', [[accId, cellText(accName), 'loan', 0, stamp, loanId]]);
      await appendTransactionRecord({
        id: txId,
        date: v.date,
        type: 'income',
        category: String(incomeCat.name),
        description: `Pinjaman dari ${label}`.slice(0, 150),
        amount: v.amount,
        account: accName,
        paymentMethod: '-',
        notes: v.notes,
        createdAt: stamp,
        updatedAt: stamp,
        billId: '',
        loanId
      });
      await appendRows('Loans', [[loanId, cellText(v.lender), v.amount, v.date, cellText(accName), v.dueDate, cellText(v.notes), 'unpaid', 0, stamp, stamp, txId, String(incomeCat.name), billId, cellText(v.purpose), accId]]);
      await appendRows('Bills', [[billId, cellText(`Pembayaran pinjaman ${label}`.slice(0, 120)), String(payCat.name), v.amount, v.date, v.dueDate, 'unpaid', 0, cellText(`Tagihan otomatis untuk pinjaman dari ${label}`.slice(0, 1000)), stamp, stamp, loanId, '', '', '', '']]);
    } catch (error) {
      await rollbackCreated([['Bills', billId], ['Loans', loanId], ['Transactions', txId], ['Accounts', accId]]);
      throw error;
    }
    return { success: true, message: 'Pinjaman berhasil dicatat', id: loanId, billId, transactionId: txId, accountId: accId };
  });
}

async function updateLoan(d = {}) {
  const id = clean(d.id);
  if (!id) throw new Error('ID pinjaman tidak valid.');
  return idempotent('updateLoan', d, async () => {
    const v = validateLoan(d);
    const found = await findRow('Loans', id);
    if (!found) throw new Error('Pinjaman tidak ditemukan.');
    const loan = found.object;
    const paid = num(loan.paidAmount);
    const billId = clean(loan.billId);
    const billRow = billId ? await findRow('Bills', billId) : null;
    if (paid > 0) {
      if (v.amount !== num(loan.amount) || v.date !== clean(loan.date).slice(0, 10)) throw new Error('Pinjaman yang sudah memiliki pembayaran hanya dapat diubah nama, jatuh tempo, dan catatannya.');
      await writeObjectRow('Loans', found.rowNumber, { ...loan, lender: cellText(v.lender), purpose: cellText(v.purpose), dueDate: v.dueDate, notes: cellText(v.notes), updatedAt: now() });
      if (billRow) await writeObjectRow('Bills', billRow.rowNumber, { ...billRow.object, dueDate: v.dueDate, updatedAt: now() });
      return { success: true, message: 'Pinjaman berhasil diperbarui', id };
    }
    /* Pinjaman baru selalu berakun pada akun sumber dananya sendiri; akun penerima tidak dapat dipindah. */
    const fundAccId = clean(loan.fundAccountId);
    const acc = fundAccId ? await findByIdOrName('Accounts', fundAccId) : await findByIdOrName('Accounts', d.accountId || d.account);
    if (!acc) throw new Error(fundAccId ? 'Akun sumber dana pinjaman tidak ditemukan.' : 'Akun penerima dana tidak ditemukan.');
    const txId = clean(loan.incomeTransactionId);
    const txRow = txId ? await findRow('Transactions', txId) : null;
    const stamp = now();
    try {
      await writeObjectRow('Loans', found.rowNumber, { ...loan, lender: cellText(v.lender), purpose: cellText(v.purpose), amount: v.amount, date: v.date, account: String(acc.name), dueDate: v.dueDate, notes: cellText(v.notes), updatedAt: stamp });
      if (txRow) await writeObjectRow('Transactions', txRow.rowNumber, { ...txRow.object, date: v.date, amount: v.amount, account: String(acc.name), description: cellText(`Pinjaman dari ${v.lender}`.slice(0, 150)), notes: cellText(v.notes), updatedAt: stamp });
      if (billRow) await writeObjectRow('Bills', billRow.rowNumber, { ...billRow.object, name: cellText(`Pembayaran pinjaman ${v.lender}`.slice(0, 120)), amount: v.amount, issueDate: v.date, dueDate: v.dueDate, updatedAt: stamp });
    } catch (error) {
      try { await writeObjectRow('Loans', found.rowNumber, loan); } catch (_) { /* best effort */ }
      if (txRow) { try { await writeObjectRow('Transactions', txRow.rowNumber, txRow.object); } catch (_) { /* best effort */ } }
      if (billRow) { try { await writeObjectRow('Bills', billRow.rowNumber, billRow.object); } catch (_) { /* best effort */ } }
      throw error;
    }
    return { success: true, message: 'Pinjaman berhasil diperbarui', id };
  });
}

async function deleteLoan(d = {}) {
  const id = clean(d.id);
  if (!id) throw new Error('ID pinjaman tidak valid.');
  return idempotent('deleteLoan', d, async () => {
    const found = await findRow('Loans', id);
    if (!found) return { success: true, message: 'Pinjaman sudah tidak ada', id };
    const loan = found.object;
    const total = num(loan.amount);
    const paid = num(loan.paidAmount);
    if (paid > 0 && paid < total) throw new Error('Pinjaman dengan pembayaran sebagian tidak dapat dihapus.');
    const billId = clean(loan.billId);
    const incomeTxId = clean(loan.incomeTransactionId);
    /* Akun sumber dana hanya boleh hilang bersama pinjaman jika belum pernah dipakai. */
    const fundAccId = clean(loan.fundAccountId);
    const fundAccRow = fundAccId ? await findRow('Accounts', fundAccId) : null;
    if (fundAccRow) {
      const usage = (await readRows('Transactions')).filter(t =>
        String(t.account || '') === String(fundAccRow.object.name) && String(t.id || '') !== incomeTxId);
      if (usage.length) {
        throw new Error(`Pinjaman ini sudah dipakai untuk ${usage.length} transaksi penggunaan dana. Hapus atau pindahkan transaksi tersebut terlebih dahulu agar saldo akun tidak rusak.`);
      }
    }
    if (billId) {
      const billRow = await findRow('Bills', billId);
      if (billRow) await deleteRow('Bills', billRow.rowNumber);
    }
    if (paid <= 0) {
      /* Pinjaman belum dibayar: pemasukan dan akun sumber dananya ikut dibatalkan. */
      if (incomeTxId) {
        const txRow = await findRow('Transactions', incomeTxId);
        if (txRow) await deleteRow('Transactions', txRow.rowNumber);
      }
      if (fundAccRow) await deleteRow('Accounts', fundAccRow.rowNumber);
    } else if (fundAccRow) {
      /* Lunas: pemasukan tetap sebagai riwayat, akun dipertahankan namun dilepas dari pinjaman. */
      await writeObjectRow('Accounts', fundAccRow.rowNumber, { ...fundAccRow.object, loanId: '' });
    }
    await updateReferences('loanId', id, '');
    if (billId) await updateReferences('billId', billId, '');
    await deleteRow('Loans', found.rowNumber);
    return { success: true, message: 'Pinjaman berhasil dihapus', id };
  });
}

const methods = { getAppData, createTransaction, updateTransaction, deleteTransaction, createCategory, updateCategory, deleteCategory, createAccount, updateAccount, deleteAccount, createTemplate, deleteTemplate, createBill, updateBill, deleteBill, payBill, createLoan, updateLoan, deleteLoan };
app.get('/health', (_req,res)=>res.json({ok:true,provider:'google-sheets-api'}));
app.post('/api', async (req,res)=>{
  const {method,payload=null}=req.body||{};
  if(typeof method!=='string'||!Object.hasOwn(methods,method)) return res.status(400).json({success:false,message:'Metode API tidak dikenal.'});
  try { const result=await methods[method](payload||{}); res.json(result===undefined?{success:true}:result); }
  catch(error) { console.error(`[${method}]`,error?.stack||error); const msg=error?.response?.data?.error?.message || error?.message || 'Terjadi kesalahan server.'; res.status(400).json({success:false,message:msg}); }
});
app.use(express.static(path.join(__dirname,'public')));
app.get('*',(_req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.listen(PORT,'0.0.0.0',()=>console.log(`Financial Manager berjalan di http://localhost:${PORT}`));
