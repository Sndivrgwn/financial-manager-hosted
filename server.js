import 'dotenv/config';
import express from 'express';
import { google } from 'googleapis';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
const HEADERS = {
  Transactions: ['id','date','type','category','description','amount','account','paymentMethod','notes','createdAt','updatedAt','fromAccount','toAccount'],
  Categories: ['id','name','type','color','icon','budget','createdAt'],
  Accounts: ['id','name','type','initialBalance','createdAt'],
  Settings: ['key','value'],
  Templates: ['id','title','type','categoryId','accountId','amount','createdAt','fromAccountId','toAccountId'],
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

const auth = new google.auth.GoogleAuth({
  keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS || path.join(__dirname, 'credentials', 'service-account.json'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
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
      ['CAT-EX-6','Kesehatan','expense','#14b8a6','heart-pulse',500000,stamp]
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
async function updateReferences(columnName, oldValue, newValue) {
  const { headers, rows } = await rawRows('Transactions');
  const col = headers.indexOf(columnName);
  if (col < 0) return;
  const updates = [];
  rows.forEach((row, i) => { if (String(row[col] ?? '') === String(oldValue)) updates.push({ range: `Transactions!${colLetter(col+1)}${i+2}`, values: [[newValue]] }); });
  if (updates.length) {
    await sheetsApi.spreadsheets.values.batchUpdate({ spreadsheetId: SPREADSHEET_ID, requestBody: { valueInputOption: 'RAW', data: updates } });
    invalidateSheetCache('Transactions');
  }
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
  return { success: true, categories, accounts, transactions, templates: templatesRaw.map(t=>({...t,amount:num(t.amount)})), settings, spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit` };
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
    fromAccount=String(from.name); toAccount=String(to.name); account=fromAccount; category='Transfer';
  } else {
    const cat = await findByIdOrName('Categories', data.categoryId || data.category);
    if (!cat) throw new Error('Kategori tidak ditemukan. Muat ulang data lalu coba lagi.');
    if (cat.type && cat.type !== type) throw new Error(`Kategori "${cat.name}" bukan kategori ${type==='income'?'pemasukan':'pengeluaran'}.`);
    const acc = await findByIdOrName('Accounts', data.accountId || data.account);
    if (!acc) throw new Error('Akun tidak ditemukan. Muat ulang data lalu coba lagi.');
    category=String(cat.name); account=String(acc.name);
  }
  return { date: validateDate(data.date), type, category, description: cellText(description), amount, account, paymentMethod: cellText(data.paymentMethod || '-'), notes: cellText(data.notes || ''), fromAccount, toAccount };
}
async function createTransaction(d={}) {
  return idempotent('createTransaction',d,async()=>{ const rec=await buildTransaction(d); const id=newId('TXN'); const stamp=now(); await appendRows('Transactions',[[id,rec.date,rec.type,rec.category,rec.description,rec.amount,rec.account,rec.paymentMethod,rec.notes,stamp,stamp,rec.fromAccount,rec.toAccount]]); return {success:true,message:'Transaksi berhasil ditambahkan',id}; });
}
async function updateTransaction(d={}) {
  const id=clean(d.id); if(!id) throw new Error('ID transaksi tidak valid.');
  return idempotent('updateTransaction',d,async()=>{ const found=await findRow('Transactions',id); if(!found) throw new Error('Transaksi tidak ditemukan.'); const rec=await buildTransaction(d); const stamp=now(); await writeObjectRow('Transactions',found.rowNumber,{...rec,id,createdAt:found.object.createdAt||stamp,updatedAt:stamp}); return {success:true,message:'Transaksi berhasil diperbarui',id}; });
}
async function deleteTransaction(d={}) { const id=clean(d.id); if(!id) throw new Error('ID transaksi tidak valid.'); return idempotent('deleteTransaction',d,async()=>{const f=await findRow('Transactions',id); if(f) await deleteRow('Transactions',f.rowNumber); return {success:true,message:f?'Transaksi berhasil dihapus':'Transaksi sudah tidak ada',id};}); }
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
async function createAccount(d={}) { const v=validateAccount(d);return idempotent('createAccount',d,async()=>{if(await nameTaken('Accounts',v.name,null))throw new Error(`Akun "${v.name}" sudah ada.`);const id=newId('ACC');await appendRows('Accounts',[[id,cellText(v.name),v.type,v.initialBalance,now()]]);return{success:true,message:'Akun berhasil dibuat',id};}); }
async function updateAccount(d={}) { const id=clean(d.id);if(!id)throw new Error('ID akun tidak valid.');const v=validateAccount(d);return idempotent('updateAccount',d,async()=>{const f=await findRow('Accounts',id);if(!f)throw new Error('Akun tidak ditemukan.');if(await nameTaken('Accounts',v.name,id))throw new Error(`Akun "${v.name}" sudah ada.`);const old=String(f.object.name);await writeObjectRow('Accounts',f.rowNumber,{...f.object,name:cellText(v.name),type:v.type,initialBalance:v.initialBalance});if(old!==v.name){for(const c of ['account','fromAccount','toAccount'])await updateReferences(c,old,v.name);}return{success:true,message:'Akun berhasil diperbarui',id};}); }
async function deleteAccount(d={}) { const id=clean(d.id);if(!id)throw new Error('ID akun tidak valid.');return idempotent('deleteAccount',d,async()=>{const f=await findRow('Accounts',id);if(!f)return{success:true,message:'Akun sudah tidak ada',id};for(const c of ['account','fromAccount','toAccount'])if(await columnContains('Transactions',c,f.object.name))throw new Error(`Akun "${f.object.name}" masih digunakan transaksi.`);await deleteRow('Accounts',f.rowNumber);return{success:true,message:'Akun berhasil dihapus',id};}); }
async function createTemplate(d={}) { const title=clean(d.title),amount=Number(d.amount===undefined||d.amount===''?0:d.amount);if(!title)throw new Error('Nama template wajib diisi.');if(title.length>120)throw new Error('Nama template maksimal 120 karakter.');if(!validType(d.type))throw new Error('Jenis template tidak valid.');if(!Number.isFinite(amount)||amount<0)throw new Error('Nominal template tidak valid.');return idempotent('createTemplate',d,async()=>{const rows=await readRows('Templates');if(rows.length>=MAX_TEMPLATES)throw new Error(`Jumlah template maksimal ${MAX_TEMPLATES}.`);if(rows.some(r=>String(r.title).toLowerCase()===title.toLowerCase()))throw new Error(`Template "${title}" sudah ada.`);const id=newId('TPL');await appendRows('Templates',[[id,cellText(title),d.type,clean(d.categoryId),clean(d.accountId),amount,now(),clean(d.fromAccountId),clean(d.toAccountId)]]);return{success:true,message:'Template berhasil disimpan',id};}); }
async function deleteTemplate(d={}) { const id=clean(d.id);if(!id)throw new Error('ID template tidak valid.');return idempotent('deleteTemplate',d,async()=>{const f=await findRow('Templates',id);if(f)await deleteRow('Templates',f.rowNumber);return{success:true,message:f?'Template berhasil dihapus':'Template sudah tidak ada',id};}); }

const methods = { getAppData, createTransaction, updateTransaction, deleteTransaction, createCategory, updateCategory, deleteCategory, createAccount, updateAccount, deleteAccount, createTemplate, deleteTemplate };
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
