const DB_PROPERTY_KEY = 'FINANCIAL_MANAGER_SPREADSHEET_ID';

const SHEETS = Object.freeze({
  TRANSACTIONS: 'Transactions',
  CATEGORIES: 'Categories',
  ACCOUNTS: 'Accounts',
  SETTINGS: 'Settings',
  TEMPLATES: 'Templates',
  REQUESTS: 'ProcessedRequests'
});

const HEADERS = Object.freeze({
  Transactions: [
    'id', 'date', 'type', 'category', 'description', 'amount',
    'account', 'paymentMethod', 'notes', 'createdAt', 'updatedAt',
    'fromAccount', 'toAccount'
  ],
  Categories: ['id', 'name', 'type', 'color', 'icon', 'budget', 'createdAt'],
  Accounts: ['id', 'name', 'type', 'initialBalance', 'createdAt'],
  Settings: ['key', 'value'],
  Templates: ['id', 'title', 'type', 'categoryId', 'accountId', 'amount', 'createdAt', 'fromAccountId', 'toAccountId'],
  ProcessedRequests: ['requestId', 'method', 'resultJson', 'createdAt']
});

const MAX_PROCESSED_REQUESTS = 1000;

/* Web app entry point. */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('Financial Manager - Dashboard')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/* ============================ DATABASE SETUP ============================== */

function getSpreadsheet() {
  const id = PropertiesService.getUserProperties().getProperty(DB_PROPERTY_KEY);
  if (!id) {
    const init = initializeDatabase();
    return SpreadsheetApp.openById(init.spreadsheetId);
  }

  let ss;
  try {
    ss = SpreadsheetApp.openById(id);
  } catch (err) {
    throw new Error('Spreadsheet database tidak dapat dibuka (ID: ' + id +
      '). Periksa izin akses atau coba lagi. Data tidak diubah.');
  }

  const cache = CacheService.getUserCache();
  const cacheKey = 'fm_ready_v3_' + id;
  if (!cache.get(cacheKey)) {
    ensureSheets_(ss);
    cache.put(cacheKey, '1', 21600);
  }
  return ss;
}

/* Aman dijalankan manual. Tidak menghapus data yang sudah ada. */
function initializeDatabase() {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const props = PropertiesService.getUserProperties();
    let id = props.getProperty(DB_PROPERTY_KEY);
    let ss;

    if (id) {
      try {
        ss = SpreadsheetApp.openById(id);
      } catch (err) {
        throw new Error('Spreadsheet database tersimpan tetapi tidak dapat dibuka. ' +
          'Hapus properti ' + DB_PROPERTY_KEY + ' secara manual hanya jika Anda yakin ingin membuat database baru.');
      }
    } else {
      ss = SpreadsheetApp.create('Financial Manager Database');
      id = ss.getId();
      props.setProperty(DB_PROPERTY_KEY, id);
    }

    ensureSheets_(ss);
    return { success: true, spreadsheetId: ss.getId(), spreadsheetUrl: ss.getUrl() };


  } finally {
    lock.releaseLock();
  }
}

function ensureSheets_(ss) {
  ensureSheet_(ss, SHEETS.TRANSACTIONS, HEADERS.Transactions);
  ensureSheet_(ss, SHEETS.CATEGORIES, HEADERS.Categories);
  ensureSheet_(ss, SHEETS.ACCOUNTS, HEADERS.Accounts);
  ensureSheet_(ss, SHEETS.SETTINGS, HEADERS.Settings);
  ensureSheet_(ss, SHEETS.TEMPLATES, HEADERS.Templates);
  ensureSheet_(ss, SHEETS.REQUESTS, HEADERS.ProcessedRequests);

  const categories = ss.getSheetByName(SHEETS.CATEGORIES);
  if (categories.getLastRow() < 2) {
    const now = new Date().toISOString();
    const defaults = [
      ['CAT-IN-1', 'Gaji & Bonus', 'income', '#22c55e', 'wallet', 0, now],
      ['CAT-IN-2', 'Investasi', 'income', '#10b981', 'trending-up', 0, now],
      ['CAT-IN-3', 'Pekerjaan Sampingan', 'income', '#3b82f6', 'laptop', 0, now],
      ['CAT-EX-1', 'Makanan & Minuman', 'expense', '#ef4444', 'utensils', 2000000, now],
      ['CAT-EX-2', 'Transportasi', 'expense', '#f97316', 'car', 800000, now],
      ['CAT-EX-3', 'Belanja & Kebutuhan', 'expense', '#ec4899', 'shopping-bag', 1500000, now],
      ['CAT-EX-4', 'Tagihan & Utilitas', 'expense', '#eab308', 'receipt', 1000000, now],
      ['CAT-EX-5', 'Hiburan & Hobi', 'expense', '#06b6d4', 'film', 500000, now],
      ['CAT-EX-6', 'Kesehatan', 'expense', '#14b8a6', 'heart-pulse', 500000, now]
    ];
    categories.getRange(2, 1, defaults.length, defaults[0].length).setValues(defaults);
  }

  const accounts = ss.getSheetByName(SHEETS.ACCOUNTS);
  if (accounts.getLastRow() < 2) {
    const now = new Date().toISOString();
    const defaults = [
      ['ACC-1', 'Kas Tunai', 'cash', 1000000, now],
      ['ACC-2', 'Rekening Bank Primary', 'bank', 5000000, now],
      ['ACC-3', 'Dompet Digital / E-Wallet', 'ewallet', 500000, now]
    ];
    accounts.getRange(2, 1, defaults.length, defaults[0].length).setValues(defaults);
  }

  const settings = ss.getSheetByName(SHEETS.SETTINGS);
  if (settings.getLastRow() < 2) {
    settings.getRange(2, 1, 3, 2).setValues([
      ['currency', 'IDR'],
      ['dateFormat', 'YYYY-MM-DD'],
      ['appName', 'Financial Manager']
    ]);
  }

  const defaultSheet = ss.getSheetByName('Sheet1');
  if (defaultSheet && ss.getSheets().length > 1 && defaultSheet.getLastRow() === 0) {
    ss.deleteSheet(defaultSheet);
  }
}

function ensureSheet_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    if (name === SHEETS.TRANSACTIONS) sheet.getRange('B:B').setNumberFormat('@');
    return sheet;
  }

  // Update header jika ada kolom baru yang ditambahkan
  const lastCol = sheet.getLastColumn();
  const currentHeaders = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(v => String(v || '').trim());
  let modified = false;

  headers.forEach(h => {
    if (!currentHeaders.includes(h)) {
      currentHeaders.push(h);
      modified = true;
    }
  });

  if (modified) {
    sheet.getRange(1, 1, 1, currentHeaders.length).setValues([currentHeaders]).setFontWeight('bold');
  }

  return sheet;
}

/* ================================ READ DATA =============================== */

function getAppData() {
  const ss = getSpreadsheet();
  const categoriesRaw = getRowsAsObjects(ss.getSheetByName(SHEETS.CATEGORIES));
  const accountsRaw = getRowsAsObjects(ss.getSheetByName(SHEETS.ACCOUNTS));
  const txRaw = getRowsAsObjects(ss.getSheetByName(SHEETS.TRANSACTIONS));
  const settingsRows = getRowsAsObjects(ss.getSheetByName(SHEETS.SETTINGS));
  const templatesRaw = getRowsAsObjects(ss.getSheetByName(SHEETS.TEMPLATES));

  const settings = {};
  settingsRows.forEach(row => { settings[row.key] = row.value; });

  const catByName = {};
  const categories = categoriesRaw.map(c => {
    const item = Object.assign({}, c, { budget: toNumber_(c.budget) });
    catByName[String(c.name)] = item;
    return item;
  });

  const accByName = {};
  accountsRaw.forEach(a => { accByName[String(a.name)] = a; });

  const transactions = txRaw.map(tx => {
    const cat = catByName[String(tx.category)];
    const acc = accByName[String(tx.account)];
    const fromAcc = tx.fromAccount ? accByName[String(tx.fromAccount)] : null;
    const toAcc = tx.toAccount ? accByName[String(tx.toAccount)] : null;

    return Object.assign({}, tx, {
      title: tx.description,
      amount: toNumber_(tx.amount),
      categoryId: cat ? cat.id : '',
      accountId: acc ? acc.id : '',
      fromAccountId: fromAcc ? fromAcc.id : '',
      toAccountId: toAcc ? toAcc.id : ''
    });


  });

  const accounts = accountsRaw.map(account => {
    const initialBalance = toNumber_(account.initialBalance);
    let net = 0;
    transactions.forEach(tx => {
      const type = String(tx.type).toLowerCase();
      if (type === 'income') {
        if (String(tx.account) === String(account.name)) net += tx.amount;
      } else if (type === 'expense') {
        if (String(tx.account) === String(account.name)) net -= tx.amount;
      } else if (type === 'transfer') {
        if ((tx.fromAccount && String(tx.fromAccount) === String(account.name)) ||
          (tx.fromAccountId && String(tx.fromAccountId) === String(account.id))) {
          net -= tx.amount;
        }
        if ((tx.toAccount && String(tx.toAccount) === String(account.name)) ||
          (tx.toAccountId && String(tx.toAccountId) === String(account.id))) {
          net += tx.amount;
        }
      }
    });
    return Object.assign({}, account, {
      initialBalance,
      openingBalance: initialBalance,
      currentBalance: initialBalance + net
    });
  });

  const templates = templatesRaw.map(t => Object.assign({}, t, { amount: toNumber_(t.amount) }));

  return {
    success: true,
    categories,
    accounts,
    transactions,
    templates,
    settings,
    spreadsheetUrl: ss.getUrl()
  };
}

/* ============================== TRANSACTIONS ============================== */

function createTransaction(data) {
  data = data || {};
  return runLocked_('createTransaction', data.requestId, ss => {
    const rec = buildTransaction_(ss, data);
    const now = new Date().toISOString();
    const id = newId_('TXN');
    ss.getSheetByName(SHEETS.TRANSACTIONS).appendRow(txRow_(id, rec, now, now));
    return { success: true, message: 'Transaksi berhasil ditambahkan', id };
  });
}

function updateTransaction(a, b) {
  const req = unpack_(a, b);
  if (!req.id) throw new Error('ID transaksi tidak valid.');
  return runLocked_('updateTransaction', req.data.requestId, ss => {
    const rec = buildTransaction_(ss, req.data);
    const sheet = ss.getSheetByName(SHEETS.TRANSACTIONS);
    const rowIndex = findRowIndexById(sheet, req.id);
    if (rowIndex === -1) throw new Error('Transaksi tidak ditemukan.');

    const createdAt = sheet.getRange(rowIndex, 10).getValue();
    const now = new Date().toISOString();
    const row = txRow_(String(req.id), rec, createdAt || now, now);
    sheet.getRange(rowIndex, 1, 1, row.length).setValues([row]);
    return { success: true, message: 'Transaksi berhasil diperbarui', id: String(req.id) };


  });
}

function deleteTransaction(a, b) {
  const req = unpackDelete_(a, b);
  if (!req.id) throw new Error('ID transaksi tidak valid.');
  return runLocked_('deleteTransaction', req.requestId, ss => {
    const sheet = ss.getSheetByName(SHEETS.TRANSACTIONS);
    const rowIndex = findRowIndexById(sheet, req.id);
    if (rowIndex === -1) {
      return { success: true, message: 'Transaksi sudah tidak ada', id: String(req.id) };
    }
    sheet.deleteRow(rowIndex);
    return { success: true, message: 'Transaksi berhasil dihapus', id: String(req.id) };
  });
}

function buildTransaction_(ss, data) {
  const type = cleanText_(data.type);
  if (!validType_(type)) throw new Error('Tipe transaksi harus income, expense, atau transfer.');

  const description = cleanText_(data.description || data.title || (type === 'transfer' ? 'Transfer Antar Akun' : ''));
  const amount = Number(data.amount);

  if (!data.date) throw new Error('Tanggal transaksi wajib diisi.');
  if (!description) throw new Error('Deskripsi/Judul transaksi wajib diisi.');
  if (description.length > 150) throw new Error('Deskripsi maksimal 150 karakter.');
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Nominal harus berupa angka positif.');
  if (String(data.notes || '').length > 1000) throw new Error('Catatan terlalu panjang.');

  let categoryNameStr = '';
  let accountNameStr = '';
  let fromAccountNameStr = '';
  let toAccountNameStr = '';

  if (type === 'transfer') {
    const fromAccRef = data.fromAccountId || data.fromAccount;
    const toAccRef = data.toAccountId || data.toAccount;

    if (!fromAccRef || !toAccRef) throw new Error('Akun asal dan akun tujuan wajib dipilih untuk transfer.');

    const fromAcc = findByIdOrName_(ss.getSheetByName(SHEETS.ACCOUNTS), fromAccRef);
    const toAcc = findByIdOrName_(ss.getSheetByName(SHEETS.ACCOUNTS), toAccRef);

    if (!fromAcc) throw new Error('Akun asal tidak ditemukan.');
    if (!toAcc) throw new Error('Akun tujuan tidak ditemukan.');
    if (String(fromAcc.id) === String(toAcc.id) || String(fromAcc.name) === String(toAcc.name)) {
      throw new Error('Akun asal dan akun tujuan tidak boleh sama.');
    }

    fromAccountNameStr = String(fromAcc.name);
    toAccountNameStr = String(toAcc.name);
    accountNameStr = fromAccountNameStr;
    categoryNameStr = 'Transfer';


  } else {
    const catRef = data.categoryId || data.category;
    const accRef = data.accountId || data.account;

    const category = findByIdOrName_(ss.getSheetByName(SHEETS.CATEGORIES), catRef);
    if (!category) throw new Error('Kategori tidak ditemukan. Muat ulang data lalu coba lagi.');
    if (category.type && category.type !== type) {
      throw new Error('Kategori "' + category.name + '" bukan kategori ' +
        (type === 'income' ? 'pemasukan' : 'pengeluaran') + '.');
    }

    const account = findByIdOrName_(ss.getSheetByName(SHEETS.ACCOUNTS), accRef);
    if (!account) throw new Error('Akun tidak ditemukan. Muat ulang data lalu coba lagi.');

    categoryNameStr = String(category.name);
    accountNameStr = String(account.name);


  }

  return {
    date: normalizeDateInput_(data.date),
    type: type,
    category: categoryNameStr,
    description: cellText_(description),
    amount: amount,
    account: accountNameStr,
    paymentMethod: cellText_(data.paymentMethod || '-'),
    notes: cellText_(data.notes || ''),
    fromAccount: fromAccountNameStr,
    toAccount: toAccountNameStr
  };
}

function txRow_(id, r, createdAt, updatedAt) {
  return [
    id, r.date, r.type, r.category, r.description, r.amount,
    r.account, r.paymentMethod, r.notes, createdAt, updatedAt,
    r.fromAccount || '', r.toAccount || ''
  ];
}

/* ================================ CATEGORIES ============================== */

function createCategory(data) {
  data = data || {};
  const name = cleanText_(data.name);
  if (!name || !validType_(data.type)) {
    throw new Error('Nama kategori dan jenis income/expense wajib diisi.');
  }
  const budget = toNumber_(data.budget);

  return runLocked_('createCategory', data.requestId, ss => {
    const sheet = ss.getSheetByName(SHEETS.CATEGORIES);
    if (nameTaken_(sheet, name, null)) throw new Error('Kategori "' + name + '" sudah ada.');

    const id = newId_('CAT');
    sheet.appendRow([
      id, cellText_(name), data.type,
      cleanText_(data.color || '#ec643d'),
      cleanText_(data.icon || 'folder'),
      budget,
      new Date().toISOString()
    ]);
    return { success: true, message: 'Kategori berhasil dibuat', id };


  });
}

function updateCategory(a, b) {
  const req = unpack_(a, b);
  const data = req.data;
  const name = cleanText_(data.name);
  if (!req.id) throw new Error('ID kategori tidak valid.');
  if (!name || !validType_(data.type)) {
    throw new Error('Nama kategori dan jenis income/expense wajib diisi.');
  }
  const budget = toNumber_(data.budget);

  return runLocked_('updateCategory', data.requestId, ss => {
    const sheet = ss.getSheetByName(SHEETS.CATEGORIES);
    const rowIndex = findRowIndexById(sheet, req.id);
    if (rowIndex === -1) throw new Error('Kategori tidak ditemukan.');
    if (nameTaken_(sheet, name, req.id)) throw new Error('Kategori "' + name + '" sudah ada.');

    const current = sheet.getRange(rowIndex, 2, 1, 5).getValues()[0];
    const oldName = String(current[0]);
    const txSheet = ss.getSheetByName(SHEETS.TRANSACTIONS);

    if (current[1] !== data.type && columnContainsValue_(txSheet, 'category', oldName)) {
      throw new Error('Jenis kategori tidak dapat diubah karena sudah dipakai transaksi.');
    }

    sheet.getRange(rowIndex, 2, 1, 5).setValues([[
      cellText_(name), data.type,
      cleanText_(data.color || current[2] || '#ec643d'),
      cleanText_(data.icon || current[3] || 'folder'),
      budget
    ]]);

    if (oldName !== name) updateTransactionReference_(txSheet, 'category', oldName, name);
    return { success: true, message: 'Kategori berhasil diperbarui', id: String(req.id) };


  });
}

function deleteCategory(a, b) {
  const req = unpackDelete_(a, b);
  if (!req.id) throw new Error('ID kategori tidak valid.');
  return runLocked_('deleteCategory', req.requestId, ss => {
    const sheet = ss.getSheetByName(SHEETS.CATEGORIES);
    const rowIndex = findRowIndexById(sheet, req.id);
    if (rowIndex === -1) return { success: true, message: 'Kategori sudah tidak ada', id: String(req.id) };

    const name = String(sheet.getRange(rowIndex, 2).getValue());
    if (columnContainsValue_(ss.getSheetByName(SHEETS.TRANSACTIONS), 'category', name)) {
      throw new Error('Kategori "' + name + '" masih digunakan transaksi.');
    }
    sheet.deleteRow(rowIndex);
    return { success: true, message: 'Kategori berhasil dihapus', id: String(req.id) };


  });
}

/* ================================= ACCOUNTS =============================== */

function createAccount(data) {
  data = data || {};
  const v = validateAccount_(data);
  return runLocked_('createAccount', data.requestId, ss => {
    const sheet = ss.getSheetByName(SHEETS.ACCOUNTS);
    if (nameTaken_(sheet, v.name, null)) throw new Error('Akun "' + v.name + '" sudah ada.');

    const id = newId_('ACC');
    sheet.appendRow([id, cellText_(v.name), v.type, v.initialBalance, new Date().toISOString()]);
    return { success: true, message: 'Akun berhasil dibuat', id };


  });
}

function updateAccount(a, b) {
  const req = unpack_(a, b);
  if (!req.id) throw new Error('ID akun tidak valid.');
  const v = validateAccount_(req.data);

  return runLocked_('updateAccount', req.data.requestId, ss => {
    const sheet = ss.getSheetByName(SHEETS.ACCOUNTS);
    const rowIndex = findRowIndexById(sheet, req.id);
    if (rowIndex === -1) throw new Error('Akun tidak ditemukan.');
    if (nameTaken_(sheet, v.name, req.id)) throw new Error('Akun "' + v.name + '" sudah ada.');

    const oldName = String(sheet.getRange(rowIndex, 2).getValue());
    sheet.getRange(rowIndex, 2, 1, 3).setValues([[cellText_(v.name), v.type, v.initialBalance]]);

    if (oldName !== v.name) {
      const txSheet = ss.getSheetByName(SHEETS.TRANSACTIONS);
      updateTransactionReference_(txSheet, 'account', oldName, v.name);
      updateTransactionReference_(txSheet, 'fromAccount', oldName, v.name);
      updateTransactionReference_(txSheet, 'toAccount', oldName, v.name);
    }
    return { success: true, message: 'Akun berhasil diperbarui', id: String(req.id) };


  });
}

function deleteAccount(a, b) {
  const req = unpackDelete_(a, b);
  if (!req.id) throw new Error('ID akun tidak valid.');
  return runLocked_('deleteAccount', req.requestId, ss => {
    const sheet = ss.getSheetByName(SHEETS.ACCOUNTS);
    const rowIndex = findRowIndexById(sheet, req.id);
    if (rowIndex === -1) return { success: true, message: 'Akun sudah tidak ada', id: String(req.id) };

    const name = String(sheet.getRange(rowIndex, 2).getValue());
    const txSheet = ss.getSheetByName(SHEETS.TRANSACTIONS);
    if (columnContainsValue_(txSheet, 'account', name) ||
      columnContainsValue_(txSheet, 'fromAccount', name) ||
      columnContainsValue_(txSheet, 'toAccount', name)) {
      throw new Error('Akun "' + name + '" masih digunakan transaksi.');
    }
    sheet.deleteRow(rowIndex);
    return { success: true, message: 'Akun berhasil dihapus', id: String(req.id) };


  });
}

/* ================================ TEMPLATES =============================== */

const MAX_TEMPLATES = 50;

function createTemplate(data) {
  data = data || {};
  const title = cleanText_(data.title);
  const amount = Number(data.amount === undefined || data.amount === '' ? 0 : data.amount);
  if (!title) throw new Error('Nama template wajib diisi.');
  if (title.length > 120) throw new Error('Nama template maksimal 120 karakter.');
  if (!validType_(data.type)) throw new Error('Jenis template tidak valid.');
  if (!Number.isFinite(amount) || amount < 0) throw new Error('Nominal template tidak valid.');

  return runLocked_('createTemplate', data.requestId, ss => {
    const sheet = ss.getSheetByName(SHEETS.TEMPLATES);
    const rows = getRowsAsObjects(sheet);
    if (rows.length >= MAX_TEMPLATES) throw new Error('Jumlah template maksimal ' + MAX_TEMPLATES + '.');
    const lower = title.toLowerCase();
    if (rows.some(r => String(r.title).toLowerCase() === lower)) {
      throw new Error('Template "' + title + '" sudah ada.');
    }

    const id = newId_('TPL');
    sheet.appendRow([
      id, cellText_(title), data.type,
      cleanText_(data.categoryId), cleanText_(data.accountId),
      amount, new Date().toISOString(),
      cleanText_(data.fromAccountId), cleanText_(data.toAccountId)
    ]);
    return { success: true, message: 'Template berhasil disimpan', id };


  });
}

function deleteTemplate(a, b) {
  const req = unpackDelete_(a, b);
  if (!req.id) throw new Error('ID template tidak valid.');
  return runLocked_('deleteTemplate', req.requestId, ss => {
    const sheet = ss.getSheetByName(SHEETS.TEMPLATES);
    const rowIndex = findRowIndexById(sheet, req.id);
    if (rowIndex === -1) return { success: true, message: 'Template sudah tidak ada', id: String(req.id) };
    sheet.deleteRow(rowIndex);
    return { success: true, message: 'Template berhasil dihapus', id: String(req.id) };
  });
}

/* ================================ HELPERS ================================= */

function runLocked_(method, requestId, fn) {
  const ss = getSpreadsheet();
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const duplicate = getProcessedRequest_(ss, requestId, method);
    if (duplicate) return duplicate;
    const result = fn(ss);
    saveProcessedRequest_(ss, requestId, method, result);
    return result;
  } finally {
    lock.releaseLock();
  }
}

function unpack_(a, b) {
  if (a && typeof a === 'object') {
    const data = Object.assign({}, a);
    return { id: data.id, data };
  }
  return { id: a, data: Object.assign({}, b || {}) };
}

function unpackDelete_(a, b) {
  if (a && typeof a === 'object') return { id: a.id, requestId: a.requestId };
  return { id: a, requestId: b };
}

function getRowsAsObjects(sheet) {
  if (!sheet || sheet.getLastRow() < 2) return [];
  const tz = sheet.getParent().getSpreadsheetTimeZone();
  const values = sheet.getDataRange().getValues();
  const headers = values[0].map(h => String(h || '').trim());
  return values.slice(1)
    .filter(row => row.some(v => v !== '' && v !== null))
    .map(row => {
      const obj = {};
      headers.forEach((header, i) => {
        let value = row[i];
        if (value instanceof Date) value = Utilities.formatDate(value, tz, 'yyyy-MM-dd');
        obj[header] = value;
      });
      return obj;
    });
}

function findRowIndexById(sheet, id) {
  if (!sheet || sheet.getLastRow() < 2) return -1;
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getDisplayValues();
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0]) === String(id)) return i + 2;
  }
  return -1;
}

function findByIdOrName_(sheet, ref) {
  const key = cleanText_(ref);
  if (!key) return null;
  const rows = getRowsAsObjects(sheet);
  return rows.find(r => String(r.id) === key) ||
    rows.find(r => String(r.name) === key) || null;
}

function nameTaken_(sheet, name, exceptId) {
  const lower = String(name).toLowerCase();
  return getRowsAsObjects(sheet).some(r =>
    String(r.name).toLowerCase() === lower && String(r.id) !== String(exceptId));
}

function validType_(type) {
  return type === 'income' || type === 'expense' || type === 'transfer';
}

function cleanText_(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function cellText_(value) {
  const s = cleanText_(value);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function validateAccount_(data) {
  const name = cleanText_(data.name);
  const type = cleanText_(data.type);
  if (!name || !type) throw new Error('Nama dan jenis akun wajib diisi.');
  const raw = data.initialBalance !== undefined ? data.initialBalance : data.openingBalance;
  const initialBalance = Number(raw === undefined || raw === '' ? 0 : raw);
  if (!Number.isFinite(initialBalance)) throw new Error('Saldo awal harus berupa angka.');
  return { name, type, initialBalance };
}

function toNumber_(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function normalizeDateInput_(value) {
  const s = cleanText_(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error('Format tanggal harus YYYY-MM-DD.');
  const [y, m, d] = s.split('-').map(Number);
  const check = new Date(y, m - 1, d);
  if (check.getFullYear() !== y || check.getMonth() !== m - 1 || check.getDate() !== d) {
    throw new Error('Tanggal tidak valid.');
  }
  return s;
}

function parseDate_(value) {
  if (value instanceof Date) return new Date(value.getTime());
  const s = cleanText_(value);
  if (!s) return null;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + 'T00:00:00') : new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function newId_(prefix) {
  return prefix + '-' + Date.now() + '-' + Utilities.getUuid().slice(0, 8);
}

function columnContainsValue_(sheet, colRef, value) {
  if (!sheet || sheet.getLastRow() < 2) return false;
  let colIndex = colRef;
  if (typeof colRef === 'string') {
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(h => String(h || '').trim());
    colIndex = headers.indexOf(colRef) + 1;
    if (colIndex <= 0) return false;
  }
  return sheet.getRange(2, colIndex, sheet.getLastRow() - 1, 1)
    .getDisplayValues().some(row => String(row[0]) === String(value));
}

function updateTransactionReference_(txSheet, columnName, oldValue, newValue) {
  if (!txSheet || txSheet.getLastRow() < 2) return;
  const headers = txSheet.getRange(1, 1, 1, txSheet.getLastColumn()).getValues()[0].map(h => String(h || '').trim());
  const colIndex = headers.indexOf(columnName) + 1;
  if (colIndex <= 0) return;

  const range = txSheet.getRange(2, colIndex, txSheet.getLastRow() - 1, 1);
  const values = range.getValues();
  let changed = false;
  values.forEach(row => {
    if (String(row[0]) === String(oldValue)) { row[0] = newValue; changed = true; }
  });
  if (changed) range.setValues(values);
}

/* ============================== IDEMPOTENCY =============================== */

function getProcessedRequest_(ss, requestId, method) {
  if (!requestId) return null;
  const sheet = ss.getSheetByName(SHEETS.REQUESTS);
  if (!sheet || sheet.getLastRow() < 2) return null;
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues();
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][0]) === String(requestId) && String(rows[i][1]) === String(method)) {
      try {
        return JSON.parse(String(rows[i][2]));
      } catch (err) {
        throw new Error('Catatan idempotensi rusak untuk request ' + requestId);
      }
    }
  }
  return null;
}

function saveProcessedRequest_(ss, requestId, method, result) {
  if (!requestId) return;
  const sheet = ss.getSheetByName(SHEETS.REQUESTS);
  sheet.appendRow([String(requestId), String(method), JSON.stringify(result), new Date().toISOString()]);
  if (sheet.getLastRow() > MAX_PROCESSED_REQUESTS + 1) sheet.deleteRows(2, 500);
}

/* ========================== HOSTED API BRIDGE ============================= */
/**
 * API untuk frontend yang di-host di server sendiri.
 * Simpan FM_API_KEY di Project Settings > Script properties.
 * Request body: { apiKey, method, payload }.
 */
function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const expectedKey = PropertiesService.getScriptProperties().getProperty('FM_API_KEY');
    if (!expectedKey || !body.apiKey || !constantTimeEquals_(String(body.apiKey), String(expectedKey))) {
      return jsonOutput_({ success: false, message: 'Unauthorized.' });
    }

    const allowed = {
      getAppData: function () { return getAppData(); },
      createTransaction: function (p) { return createTransaction(p); },
      updateTransaction: function (p) { return updateTransaction(p); },
      deleteTransaction: function (p) { return deleteTransaction(p); },
      createCategory: function (p) { return createCategory(p); },
      updateCategory: function (p) { return updateCategory(p); },
      deleteCategory: function (p) { return deleteCategory(p); },
      createAccount: function (p) { return createAccount(p); },
      updateAccount: function (p) { return updateAccount(p); },
      deleteAccount: function (p) { return deleteAccount(p); },
      createTemplate: function (p) { return createTemplate(p); },
      deleteTemplate: function (p) { return deleteTemplate(p); }
    };
    const method = String(body.method || '');
    if (!Object.prototype.hasOwnProperty.call(allowed, method)) {
      return jsonOutput_({ success: false, message: 'Metode API tidak diizinkan.' });
    }
    const result = allowed[method](body.payload);
    return jsonOutput_(result === undefined ? { success: true } : result);
  } catch (err) {
    return jsonOutput_({ success: false, message: err && err.message ? err.message : 'Terjadi kesalahan server.' });
  }
}

function jsonOutput_(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function constantTimeEquals_(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}
