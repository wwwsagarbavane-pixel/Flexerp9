import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');
const SEED_PATH = path.join(DATA_DIR, 'db.seed.json');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const JWT_SECRET = 'super-secret-erp-key';

// Helper: Read DB safely
function readDatabase() {
  try {
    if (fs.existsSync(DB_PATH)) {
      const raw = fs.readFileSync(DB_PATH, 'utf-8');
      return JSON.parse(raw);
    } else if (fs.existsSync(SEED_PATH)) {
      const raw = fs.readFileSync(SEED_PATH, 'utf-8');
      fs.writeFileSync(DB_PATH, raw, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (err) {
    console.error('Error reading database file:', err);
  }
  return {};
}

// Helper: Save DB safely
function saveDatabase(data) {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    const tempPath = DB_PATH + '.tmp';
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf-8');
    // On Windows, if destination exists, renameSync may fail, so unlinkSync first if needed
    try {
      if (fs.existsSync(DB_PATH)) {
        fs.unlinkSync(DB_PATH);
      }
    } catch (_) {}
    fs.renameSync(tempPath, DB_PATH);
    return true;
  } catch (err) {
    console.error('Error saving database file:', err);
    try {
      fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf-8');
      return true;
    } catch (e2) {
      console.error('Direct write failed:', e2);
      return false;
    }
  }
}

let db = readDatabase();

// Helper: Add Audit Log
function logAudit(action, collection, recordId, details = {}) {
  if (!db.auditLogs) db.auditLogs = [];
  const logEntry = {
    id: `LOG-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    timestamp: new Date().toISOString(),
    action,
    collection,
    recordId,
    details
  };
  db.auditLogs.unshift(logEntry);
  if (db.auditLogs.length > 500) db.auditLogs.pop();
}

// Normalize Purchase Order
function normalizePO(po) {
  const amt = po.total !== undefined ? po.total : (po.amount !== undefined ? po.amount : 0);
  const dt = po.orderDate || po.date || new Date().toISOString().slice(0, 10);
  const num = po.orderNumber || po.id;
  return {
    ...po,
    id: po.id || num,
    orderNumber: num,
    total: parseFloat(amt),
    amount: parseFloat(amt),
    orderDate: dt,
    date: dt
  };
}

// 0. HEALTH CHECK
app.get('/api/health', (req, res) => {
  res.json({
    status: 'online',
    engine: 'JSON File Persistent Backend',
    databaseFile: DB_PATH,
    collections: Object.keys(db).filter(k => Array.isArray(db[k])),
    timestamp: new Date().toISOString()
  });
});

// 1. PUBLIC COMPANIES
app.get('/api/companies/public', (req, res) => {
  db = readDatabase();
  const publicCompanies = (db.companies || []).filter(c => c.status === 'Active' || !c.status);
  res.json(publicCompanies);
});

// 2. AUTHENTICATION (TENANT GUARD)
app.post('/api/auth/login', (req, res) => {
  db = readDatabase();
  const { companyId, email, password } = req.body;
  
  if (!companyId || !email || !password) {
    return res.status(400).json({ error: 'Missing credentials' });
  }

  const users = db.users || [];
  let user;
  if (companyId === 'SYSTEM') {
    user = users.find(u => u.email === email && u.companyId === 'SYSTEM' && u.password === password);
  } else {
    user = users.find(u => u.email === email && u.companyId === companyId && u.password === password);
    if (!user) {
      user = users.find(u => u.email === email && u.password === password);
    }
  }

  // Fallback demo user if password matches
  if (!user && password === 'password') {
    user = {
      id: `U-${Date.now().toString().slice(-4)}`,
      name: email.split('@')[0],
      email: email,
      companyId: companyId,
      role: 'Super Admin',
      roleScope: companyId === 'SYSTEM' ? 'SYSTEM' : 'COMPANY'
    };
  }

  if (!user) {
    return res.status(403).json({ error: 'COMPANY_ACCESS_DENIED' });
  }

  const token = jwt.sign({
    userId: user.id,
    companyId: user.companyId || companyId,
    roleScope: user.roleScope || 'COMPANY'
  }, JWT_SECRET, { expiresIn: '8h' });

  res.json({
    token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      companyId: user.companyId || companyId,
      role: user.role || 'Admin',
      roleScope: user.roleScope || 'COMPANY'
    }
  });
});

// 3. SYSTEM COMPANIES ROUTE
app.get('/api/system/companies', (req, res) => {
  db = readDatabase();
  res.json({ success: true, data: db.companies || [] });
});

app.post('/api/system/companies', (req, res) => {
  db = readDatabase();
  if (!db.companies) db.companies = [];
  const b = req.body;
  const newCompany = {
    id: `C-00${db.companies.length + 1}`,
    name: b.companyName || b.name,
    code: b.companyCode || b.code || `CMP-${db.companies.length + 1}`,
    legalName: b.legalName || b.companyName || b.name,
    gstin: b.gstin || '',
    email: b.email || '',
    phone: b.phone || '',
    city: b.city || '',
    state: b.state || '',
    status: 'Active',
    created: new Date().toISOString().slice(0, 10)
  };
  db.companies.push(newCompany);
  logAudit('CREATE', 'companies', newCompany.id, newCompany);
  saveDatabase(db);
  res.json({ success: true, data: newCompany });
});

app.delete('/api/system/companies/:id', (req, res) => {
  db = readDatabase();
  const id = req.params.id;
  db.companies = (db.companies || []).filter(c => c.id !== id);
  logAudit('DELETE', 'companies', id);
  saveDatabase(db);
  res.json({ success: true, id });
});

// 4. VENDORS ROUTE
app.get('/api/vendors', (req, res) => {
  db = readDatabase();
  res.json(db.vendors || []);
});

app.post('/api/vendors', (req, res) => {
  db = readDatabase();
  if (!db.vendors) db.vendors = [];
  const item = req.body;
  const id = item.id || `V-${Date.now().toString().slice(-4)}`;
  const newItem = {
    ...item,
    id,
    code: item.code || id,
    companyId: item.companyId || 'C-001',
    status: item.status || 'Active'
  };
  db.vendors.push(newItem);
  logAudit('CREATE', 'vendors', id, newItem);
  saveDatabase(db);
  res.status(201).json(newItem);
});

app.patch('/api/vendors/:id', (req, res) => {
  db = readDatabase();
  const id = req.params.id;
  const idx = (db.vendors || []).findIndex(v => String(v.id) === String(id) || String(v.code) === String(id));
  if (idx !== -1) {
    db.vendors[idx] = { ...db.vendors[idx], ...req.body, id: db.vendors[idx].id };
    logAudit('UPDATE', 'vendors', id, req.body);
    saveDatabase(db);
    return res.json(db.vendors[idx]);
  }
  res.status(404).json({ error: 'Vendor not found' });
});

app.delete('/api/vendors/:id', (req, res) => {
  db = readDatabase();
  const id = req.params.id;
  db.vendors = (db.vendors || []).filter(v => String(v.id) !== String(id) && String(v.code) !== String(id));
  logAudit('DELETE', 'vendors', id);
  saveDatabase(db);
  res.json({ success: true, id });
});

// 5. PROCUREMENT PURCHASE ORDERS ROUTE
app.get('/api/procurement/purchase-orders', (req, res) => {
  db = readDatabase();
  const pos = (db.purchaseOrders || []).map(normalizePO);
  res.json(pos);
});

app.post('/api/procurement/purchase-orders', (req, res) => {
  db = readDatabase();
  if (!db.purchaseOrders) db.purchaseOrders = [];
  const item = req.body;
  const id = item.orderNumber || item.id || `PO-26-${Date.now().toString().slice(-4)}`;
  const normalized = normalizePO({ ...item, id });
  db.purchaseOrders.push(normalized);
  logAudit('CREATE', 'purchaseOrders', id, normalized);
  saveDatabase(db);
  res.status(201).json(normalized);
});

app.patch('/api/procurement/purchase-orders/:id', (req, res) => {
  db = readDatabase();
  const id = req.params.id;
  const idx = (db.purchaseOrders || []).findIndex(p => String(p.id) === String(id) || String(p.orderNumber) === String(id));
  if (idx !== -1) {
    db.purchaseOrders[idx] = normalizePO({ ...db.purchaseOrders[idx], ...req.body, id: db.purchaseOrders[idx].id });
    logAudit('UPDATE', 'purchaseOrders', id, req.body);
    saveDatabase(db);
    return res.json(db.purchaseOrders[idx]);
  }
  res.status(404).json({ error: 'Purchase Order not found' });
});

app.delete('/api/procurement/purchase-orders/:id', (req, res) => {
  db = readDatabase();
  const id = req.params.id;
  db.purchaseOrders = (db.purchaseOrders || []).filter(p => String(p.id) !== String(id) && String(p.orderNumber) !== String(id));
  logAudit('DELETE', 'purchaseOrders', id);
  saveDatabase(db);
  res.json({ success: true, id });
});

// 6. UNIVERSAL STORE APIS (All Collections)
app.get('/api/store/sync', (req, res) => {
  db = readDatabase();
  // Ensure normalized POs in sync response
  if (Array.isArray(db.purchaseOrders)) {
    db.purchaseOrders = db.purchaseOrders.map(normalizePO);
  }
  res.json(db);
});

app.get('/api/store/:collection', (req, res) => {
  db = readDatabase();
  const list = db[req.params.collection] || [];
  res.json(list);
});

app.get('/api/store/:collection/:id', (req, res) => {
  db = readDatabase();
  const list = db[req.params.collection] || [];
  const found = list.find(x => String(x.id) === String(req.params.id));
  if (!found) return res.status(404).json({ error: 'Not found' });
  res.json(found);
});

app.post('/api/store/:collection', (req, res) => {
  db = readDatabase();
  const { collection } = req.params;
  if (!db[collection]) db[collection] = [];

  const item = req.body;
  const prefix = collection.substring(0, 3).toUpperCase();
  const id = item.id || `${prefix}-${Date.now().toString().slice(-6)}`;
  let newItem = {
    ...item,
    id,
    companyId: item.companyId || 'C-001',
    createdAt: new Date().toISOString()
  };

  if (collection === 'purchaseOrders') {
    newItem = normalizePO(newItem);
  }

  db[collection].push(newItem);
  logAudit('CREATE', collection, id, newItem);
  saveDatabase(db);

  console.log(`[JSON DB] Saved in ${collection} (ID: ${id}) to db.json`);
  res.status(201).json({ success: true, item: newItem });
});

app.patch('/api/store/:collection/:id', (req, res) => {
  db = readDatabase();
  const { collection, id } = req.params;
  if (!db[collection]) db[collection] = [];

  const idx = db[collection].findIndex(x => String(x.id) === String(id) || String(x.code) === String(id) || String(x.orderNumber) === String(id));
  if (idx !== -1) {
    let updated = { ...db[collection][idx], ...req.body, id: db[collection][idx].id, updatedAt: new Date().toISOString() };
    if (collection === 'purchaseOrders') updated = normalizePO(updated);
    db[collection][idx] = updated;
    logAudit('UPDATE', collection, id, req.body);
    saveDatabase(db);
    return res.json({ success: true, item: updated });
  }

  // Not found -> insert
  let newItem = { ...req.body, id, updatedAt: new Date().toISOString() };
  if (collection === 'purchaseOrders') newItem = normalizePO(newItem);
  db[collection].push(newItem);
  logAudit('CREATE', collection, id, newItem);
  saveDatabase(db);
  res.json({ success: true, item: newItem });
});

app.delete('/api/store/:collection/:id', (req, res) => {
  db = readDatabase();
  const { collection, id } = req.params;
  if (!db[collection]) return res.json({ success: true, id });

  const prevLen = db[collection].length;
  db[collection] = db[collection].filter(x => String(x.id) !== String(id) && String(x.code) !== String(id) && String(x.orderNumber) !== String(id));
  logAudit('DELETE', collection, id);
  saveDatabase(db);
  res.json({ success: true, id, count: prevLen - db[collection].length });
});

// 7. RESET DATABASE
app.post('/api/store/reset', (req, res) => {
  try {
    if (fs.existsSync(SEED_PATH)) {
      const seedContent = fs.readFileSync(SEED_PATH, 'utf-8');
      fs.writeFileSync(DB_PATH, seedContent, 'utf-8');
      db = JSON.parse(seedContent);
      logAudit('RESET', 'ALL', 'SEED');
      saveDatabase(db);
      console.log('[JSON DB] Reset db.json to initial demo seed!');
      return res.json({ success: true, message: 'Database reset to demo state' });
    }
    res.status(500).json({ error: 'Seed file not found' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`🚀 Flex ERP Backend (JSON Database Engine)`);
  console.log(`📁 Persistent File: ${DB_PATH}`);
  console.log(`🌐 Server URL:      http://localhost:${PORT}`);
  console.log(`📊 Total Tables:    ${Object.keys(db).length}`);
  console.log(`====================================================`);
});
