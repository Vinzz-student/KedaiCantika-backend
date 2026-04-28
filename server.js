const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const http = require('http');
const socketIo = require('socket.io');
const axios = require('axios');

const app = express();
const server = http.createServer(app);

// ============ CORS - ALLOW ALL (Fix untuk Vercel) ============
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.options('*', cors());

app.use(express.json());

// ============ DATABASE ============
const isProduction = process.env.NODE_ENV === 'production';
let dbPath;

if (isProduction) {
    dbPath = '/data/db.json';
} else {
    dbPath = path.join(__dirname, 'database', 'db.json');
}

console.log(`Database path: ${dbPath}`);
console.log(`Environment: ${isProduction ? 'PRODUCTION' : 'DEVELOPMENT'}`);

// Buat folder database jika belum ada
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}

function readDB() {
    try {
        const data = fs.readFileSync(dbPath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error('Error reading database:', error);
        return { merchants: [], customers: [], orders: [], menus: [] };
    }
}

function writeDB(data) {
    try {
        fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
    } catch (error) {
        console.error('Error writing database:', error);
    }
}

// ============ SOCKET.IO ============
const io = socketIo(server, {
    cors: {
        origin: '*',
        methods: ["GET", "POST"],
        credentials: true
    }
});

const connectedMerchants = new Set();

io.on('connection', (socket) => {
    console.log('🔌 User connected:', socket.id);
    
    socket.on('register-merchant', () => {
        connectedMerchants.add(socket.id);
        console.log(`📢 Merchant registered. Total: ${connectedMerchants.size}`);
    });
    
    socket.on('disconnect', () => {
        connectedMerchants.delete(socket.id);
        console.log(`❌ User disconnected. Merchants: ${connectedMerchants.size}`);
    });
});

function notifyAllMerchants(eventName, data) {
    console.log(`📤 Sending ${eventName} to ${connectedMerchants.size} merchants`);
    connectedMerchants.forEach(socketId => {
        io.to(socketId).emit(eventName, data);
    });
}

// ============ WHATSAPP API ============
const WHATSAPP_API_KEY = '137c10358d2c01b6dd9148ca63a2b383c23eb92c9a3cdf3279fdcaaf875e7832';
const WHATSAPP_API_URL = 'https://api.ngirimwa.com/v1/send-template';

async function sendWhatsAppTemplate(phoneNumber, templateName, templateData) {
    let formattedNumber = phoneNumber;
    if (formattedNumber.startsWith('0')) formattedNumber = '62' + formattedNumber.substring(1);
    if (formattedNumber.startsWith('+')) formattedNumber = formattedNumber.substring(1);

    try {
        const response = await axios.post(WHATSAPP_API_URL, {
            phone: formattedNumber,
            template: templateName,
            data: templateData
        }, {
            headers: {
                'Authorization': WHATSAPP_API_KEY,
                'Content-Type': 'application/json'
            }
        });
        console.log(`✅ WA template "${templateName}" terkirim ke ${formattedNumber}`);
        return true;
    } catch (error) {
        console.error(`❌ Gagal kirim WA template:`, error.response?.data || error.message);
        return false;
    }
}

// ============ API AUTH & USER ============
app.post('/api/check-user', (req, res) => {
    const { email } = req.body;
    const db = readDB();
    
    const merchant = db.merchants?.find(m => m.email === email);
    if (merchant) {
        return res.json({ 
            isMerchant: true, 
            name: merchant.name, 
            email: merchant.email,
            phoneNumber: merchant.phoneNumber || null
        });
    }
    
    const customer = db.customers?.find(c => c.email === email);
    if (customer) {
        return res.json({ 
            isMerchant: false, 
            name: customer.name, 
            email: customer.email,
            phoneNumber: customer.phoneNumber || null
        });
    }
    
    res.json({ 
        isMerchant: false, 
        isNewUser: true,
        email: email
    });
});

app.post('/api/register-user', (req, res) => {
    const { email, name, phoneNumber } = req.body;
    const db = readDB();
    
    if (!db.customers) db.customers = [];
    
    const existingCustomer = db.customers.find(c => c.email === email);
    if (!existingCustomer) {
        db.customers.push({
            email,
            name: name || email.split('@')[0],
            phoneNumber: phoneNumber || null,
            lastLogin: new Date().toISOString()
        });
        writeDB(db);
    }
    
    res.json({ success: true });
});

app.post('/api/update-phone', (req, res) => {
    const { email, phoneNumber } = req.body;
    const db = readDB();
    
    const customerIndex = db.customers?.findIndex(c => c.email === email);
    if (customerIndex !== -1 && customerIndex !== undefined) {
        db.customers[customerIndex].phoneNumber = phoneNumber;
        db.customers[customerIndex].lastLogin = new Date().toISOString();
        writeDB(db);
        return res.json({ success: true, role: 'customer' });
    }
    
    const merchantIndex = db.merchants?.findIndex(m => m.email === email);
    if (merchantIndex !== -1 && merchantIndex !== undefined) {
        db.merchants[merchantIndex].phoneNumber = phoneNumber;
        writeDB(db);
        return res.json({ success: true, role: 'merchant' });
    }
    
    res.json({ success: false, message: 'User tidak ditemukan' });
});

app.post('/api/get-phone', (req, res) => {
    const { email } = req.body;
    const db = readDB();
    
    const merchant = db.merchants?.find(m => m.email === email);
    if (merchant?.phoneNumber) {
        return res.json({ success: true, phoneNumber: merchant.phoneNumber });
    }
    
    const customer = db.customers?.find(c => c.email === email);
    if (customer?.phoneNumber) {
        return res.json({ success: true, phoneNumber: customer.phoneNumber });
    }
    
    res.json({ success: false, phoneNumber: null });
});

// ============ API MENU ============
app.get('/api/menus', (req, res) => {
    const db = readDB();
    res.json({ menus: db.menus || [] });
});

app.put('/api/menus/:id/toggle', (req, res) => {
    const { id } = req.params;
    const db = readDB();
    const menuIndex = db.menus.findIndex(m => m.id === id);
    if (menuIndex !== -1) {
        db.menus[menuIndex].available = !db.menus[menuIndex].available;
        writeDB(db);
        res.json({ success: true, menu: db.menus[menuIndex] });
    } else {
        res.status(404).json({ success: false });
    }
});

app.put('/api/menus/:menuId/variant/:variantId/toggle', (req, res) => {
    const { menuId, variantId } = req.params;
    const db = readDB();
    const menuIndex = db.menus.findIndex(m => m.id === menuId);
    if (menuIndex !== -1 && db.menus[menuIndex].variants) {
        const variantIndex = db.menus[menuIndex].variants.findIndex(v => v.id === variantId);
        if (variantIndex !== -1) {
            db.menus[menuIndex].variants[variantIndex].available = !db.menus[menuIndex].variants[variantIndex].available;
            writeDB(db);
            res.json({ success: true });
            return;
        }
    }
    res.status(404).json({ success: false });
});

// ============ API PESANAN ============
app.get('/api/orders', (req, res) => {
    const db = readDB();
    res.json({ orders: db.orders || [] });
});

app.get('/api/orders/:id', (req, res) => {
    const db = readDB();
    const order = db.orders.find(o => o.id === req.params.id);
    if (order) {
        res.json({ success: true, order: order });
    } else {
        res.json({ success: false, order: null });
    }
});

app.post('/api/orders', async (req, res) => {
    const db = readDB();
    const newOrder = {
        id: Date.now().toString(),
        ...req.body,
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
    db.orders.unshift(newOrder);
    writeDB(db);
    
    console.log(`✅ Pesanan baru: ${newOrder.customerName} - Total: ${newOrder.totalAmount}`);
    
    const notificationData = {
        orderId: newOrder.id,
        customerName: newOrder.customerName,
        totalAmount: newOrder.totalAmount,
        items: newOrder.items
    };
    notifyAllMerchants('new-order-notification', notificationData);
    
    // Kirim WA ke penjual
    const merchants = db.merchants || [];
    const itemsList = newOrder.items.map(item => `- ${item.quantity}x ${item.name}`).join('\n');
    const orderLink = `https://kedaicantika.vercel.app?order=${newOrder.id}`;
    const totalAmountFormatted = newOrder.totalAmount.toLocaleString();
    
    for (const merchant of merchants) {
        if (merchant.phoneNumber) {
            const templateData = [
                newOrder.customerName,
                itemsList,
                totalAmountFormatted,
                orderLink
            ];
            await sendWhatsAppTemplate(merchant.phoneNumber, 'pesanan_baru', templateData);
        }
    }
    
    res.json({ success: true, order: newOrder });
});

app.put('/api/orders/:id/status', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    const db = readDB();
    const orderIndex = db.orders.findIndex(o => o.id === id);
    
    if (orderIndex !== -1) {
        db.orders[orderIndex].status = status;
        db.orders[orderIndex].updatedAt = new Date().toISOString();
        writeDB(db);
        
        const order = db.orders[orderIndex];
        
        notifyAllMerchants('order-status-updated', { orderId: id, status });
        
        if (status === 'completed') {
            const customer = db.customers?.find(c => c.email === order.customerEmail);
            
            if (customer?.phoneNumber) {
                const orderLink = `https://kedaicantika.vercel.app?order=${order.id}`;
                const totalAmountFormatted = order.totalAmount.toLocaleString();
                const itemsList = order.items.map(item => `- ${item.quantity}x ${item.name}`).join('\n');
                
                const templateData = [
                    order.customerName,
                    itemsList,
                    totalAmountFormatted,
                    orderLink
                ];
                await sendWhatsAppTemplate(customer.phoneNumber, 'pesanan_selesai', templateData);
            }
        }
        
        res.json({ success: true });
    } else {
        res.status(404).json({ success: false });
    }
});

app.delete('/api/orders/:id', (req, res) => {
    const { id } = req.params;
    const db = readDB();
    const orderIndex = db.orders.findIndex(o => o.id === id);
    if (orderIndex !== -1) {
        db.orders.splice(orderIndex, 1);
        writeDB(db);
        res.json({ success: true });
    } else {
        res.status(404).json({ success: false });
    }
});

// ============ API PENJUAL ============
app.post('/api/check-merchant', (req, res) => {
    const { email } = req.body;
    const db = readDB();
    const merchant = db.merchants?.find(m => m.email === email);
    if (merchant) {
        res.json({ isMerchant: true, name: merchant.name, email: merchant.email });
    } else {
        res.json({ isMerchant: false });
    }
});

app.get('/api/merchants', (req, res) => {
    const db = readDB();
    res.json({ merchants: db.merchants || [] });
});

app.post('/api/merchants', (req, res) => {
    const { email, name, phoneNumber } = req.body;
    const db = readDB();
    if (!db.merchants?.find(m => m.email === email)) {
        if (!db.merchants) db.merchants = [];
        db.merchants.push({ email, name, phoneNumber, addedAt: new Date().toISOString() });
        writeDB(db);
        res.json({ success: true });
    } else {
        res.json({ success: false, message: 'Email sudah terdaftar' });
    }
});

app.delete('/api/merchants/:email', (req, res) => {
    const { email } = req.params;
    const db = readDB();
    db.merchants = db.merchants?.filter(m => m.email !== email) || [];
    writeDB(db);
    res.json({ success: true });
});

// ============ API STATUS KEDAI ============
app.get('/api/store/status', (req, res) => {
    const db = readDB();
    const isOpen = db.storeOpen !== undefined ? db.storeOpen : true;
    res.json({ isOpen });
});

app.post('/api/store/status', (req, res) => {
    const { isOpen } = req.body;
    const db = readDB();
    db.storeOpen = isOpen;
    writeDB(db);
    console.log(`🏪 Status kedai: ${isOpen ? 'BUKA' : 'TUTUP'}`);
    res.json({ success: true, isOpen });
});

app.get('/api/store/hours', (req, res) => {
    const db = readDB();
    const hours = db.storeHours || { openHour: 9, closeHour: 21 };
    res.json(hours);
});

app.post('/api/store/hours', (req, res) => {
    const { openHour, closeHour } = req.body;
    const db = readDB();
    db.storeHours = { openHour, closeHour };
    writeDB(db);
    res.json({ success: true, hours: db.storeHours });
});

// ============ TEST ENDPOINT ============
app.get('/api/test', (req, res) => {
    res.json({ 
        message: 'Backend berjalan!', 
        socketCount: connectedMerchants.size,
        environment: isProduction ? 'production' : 'development'
    });
});

// ============ START SERVER ============
const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📡 Socket.IO enabled`);
    console.log(`📱 WhatsApp API ready`);
    console.log(`🌍 Environment: ${isProduction ? 'PRODUCTION' : 'DEVELOPMENT'}`);
    console.log(`📁 Database: ${dbPath}`);
});