const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const http = require('http');
const socketIo = require('socket.io');
const axios = require('axios');
const { MongoClient } = require('mongodb');

const app = express();
const server = http.createServer(app);

// ============ MONGODB CONNECTION (OPTIONAL) ============
const MONGODB_URI = process.env.MONGODB_URI || '';
let mongoClient;
let mongoDb;

async function connectMongoDB() {
    if (mongoDb) return mongoDb;
    if (!MONGODB_URI) return null;
    
    try {
        mongoClient = new MongoClient(MONGODB_URI);
        await mongoClient.connect();
        mongoDb = mongoClient.db('kedaicantika');
        console.log('✅ MongoDB connected');
        
        // Inisialisasi collection
        const collections = ['merchants', 'customers', 'orders', 'menus'];
        for (const col of collections) {
            const count = await mongoDb.collection(col).countDocuments();
            if (count === 0 && col === 'merchants') {
                await mongoDb.collection(col).insertOne({
                    email: "reynandoandrevaliano@gmail.com",
                    name: "Reynando",
                    phoneNumber: "6281234567890"
                });
            }
        }
        
        return mongoDb;
    } catch (error) {
        console.log('⚠️ MongoDB not available, using file JSON');
        return null;
    }
}

// ============ CORS - ALLOW ALL ============
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.options('*', cors());

app.use(express.json());

// ============ DATABASE FILE JSON (FALLBACK) ============
const isProduction = process.env.NODE_ENV === 'production';
let dbPath;

if (isProduction) {
    dbPath = '/data/db.json';
} else {
    dbPath = path.join(__dirname, 'database', 'db.json');
}

console.log(`📁 Database path: ${dbPath}`);
console.log(`🌍 Environment: ${isProduction ? 'PRODUCTION' : 'DEVELOPMENT'}`);

const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
    // Di Vercel, ga bisa bikin folder, skip aja
    if (!isProduction) {
        fs.mkdirSync(dbDir, { recursive: true });
    }
}

function readFileDB() {
    try {
        const data = fs.readFileSync(dbPath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        return { merchants: [], customers: [], orders: [], menus: [] };
    }
}

function writeFileDB(data) {
    try {
        fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
    } catch (error) {
        console.error('Error writing database:', error);
    }
}

// ============ DUAL MODE DATABASE ============
async function readDB() {
    const mongo = await connectMongoDB();
    if (mongo) {
        try {
            const merchants = await mongo.collection('merchants').find({}).toArray();
            const customers = await mongo.collection('customers').find({}).toArray();
            const orders = await mongo.collection('orders').find({}).sort({ createdAt: -1 }).toArray();
            const menus = await mongo.collection('menus').find({}).toArray();
            return { merchants, customers, orders, menus };
        } catch (error) {
            console.log('MongoDB read error, fallback to file');
        }
    }
    return readFileDB();
}

async function writeDB(data) {
    const mongo = await connectMongoDB();
    if (mongo) {
        try {
            if (data.merchants) {
                await mongo.collection('merchants').deleteMany({});
                if (data.merchants.length) await mongo.collection('merchants').insertMany(data.merchants);
            }
            if (data.customers) {
                await mongo.collection('customers').deleteMany({});
                if (data.customers.length) await mongo.collection('customers').insertMany(data.customers);
            }
            if (data.orders) {
                await mongo.collection('orders').deleteMany({});
                if (data.orders.length) await mongo.collection('orders').insertMany(data.orders);
            }
            if (data.menus) {
                await mongo.collection('menus').deleteMany({});
                if (data.menus.length) await mongo.collection('menus').insertMany(data.menus);
            }
            console.log('✅ Data saved to MongoDB');
            return;
        } catch (error) {
            console.log('MongoDB write error, fallback to file');
        }
    }
    writeFileDB(data);
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
app.post('/api/check-user', async (req, res) => {
    const { email } = req.body;
    const db = await readDB();
    
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

app.post('/api/register-user', async (req, res) => {
    const { email, name, phoneNumber } = req.body;
    const db = await readDB();
    
    if (!db.customers) db.customers = [];
    
    const existingCustomer = db.customers.find(c => c.email === email);
    if (!existingCustomer) {
        db.customers.push({
            email,
            name: name || email.split('@')[0],
            phoneNumber: phoneNumber || null,
            lastLogin: new Date().toISOString()
        });
        await writeDB(db);
    }
    
    res.json({ success: true });
});

app.post('/api/update-phone', async (req, res) => {
    const { email, phoneNumber } = req.body;
    const db = await readDB();
    
    const customerIndex = db.customers?.findIndex(c => c.email === email);
    if (customerIndex !== -1 && customerIndex !== undefined) {
        db.customers[customerIndex].phoneNumber = phoneNumber;
        db.customers[customerIndex].lastLogin = new Date().toISOString();
        await writeDB(db);
        return res.json({ success: true, role: 'customer' });
    }
    
    const merchantIndex = db.merchants?.findIndex(m => m.email === email);
    if (merchantIndex !== -1 && merchantIndex !== undefined) {
        db.merchants[merchantIndex].phoneNumber = phoneNumber;
        await writeDB(db);
        return res.json({ success: true, role: 'merchant' });
    }
    
    res.json({ success: false, message: 'User tidak ditemukan' });
});

app.post('/api/get-phone', async (req, res) => {
    const { email } = req.body;
    const db = await readDB();
    
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
app.get('/api/menus', async (req, res) => {
    const db = await readDB();
    res.json({ menus: db.menus || [] });
});

app.put('/api/menus/:id/toggle', async (req, res) => {
    const { id } = req.params;
    const db = await readDB();
    const menuIndex = db.menus.findIndex(m => m.id === id);
    if (menuIndex !== -1) {
        db.menus[menuIndex].available = !db.menus[menuIndex].available;
        await writeDB(db);
        res.json({ success: true, menu: db.menus[menuIndex] });
    } else {
        res.status(404).json({ success: false });
    }
});

app.put('/api/menus/:menuId/variant/:variantId/toggle', async (req, res) => {
    const { menuId, variantId } = req.params;
    const db = await readDB();
    const menuIndex = db.menus.findIndex(m => m.id === menuId);
    if (menuIndex !== -1 && db.menus[menuIndex].variants) {
        const variantIndex = db.menus[menuIndex].variants.findIndex(v => v.id === variantId);
        if (variantIndex !== -1) {
            db.menus[menuIndex].variants[variantIndex].available = !db.menus[menuIndex].variants[variantIndex].available;
            await writeDB(db);
            res.json({ success: true });
            return;
        }
    }
    res.status(404).json({ success: false });
});

// ============ API PESANAN ============
app.get('/api/orders', async (req, res) => {
    const db = await readDB();
    res.json({ orders: db.orders || [] });
});

app.get('/api/orders/:id', async (req, res) => {
    const db = await readDB();
    const order = db.orders.find(o => o.id === req.params.id);
    if (order) {
        res.json({ success: true, order: order });
    } else {
        res.json({ success: false, order: null });
    }
});

app.post('/api/orders', async (req, res) => {
    const db = await readDB();
    const newOrder = {
        id: Date.now().toString(),
        ...req.body,
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
    db.orders.unshift(newOrder);
    await writeDB(db);
    
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
    const db = await readDB();
    const orderIndex = db.orders.findIndex(o => o.id === id);
    
    if (orderIndex !== -1) {
        db.orders[orderIndex].status = status;
        db.orders[orderIndex].updatedAt = new Date().toISOString();
        await writeDB(db);
        
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

app.delete('/api/orders/:id', async (req, res) => {
    const { id } = req.params;
    const db = await readDB();
    const orderIndex = db.orders.findIndex(o => o.id === id);
    if (orderIndex !== -1) {
        db.orders.splice(orderIndex, 1);
        await writeDB(db);
        res.json({ success: true });
    } else {
        res.status(404).json({ success: false });
    }
});

// ============ API PENJUAL ============
app.post('/api/check-merchant', async (req, res) => {
    const { email } = req.body;
    const db = await readDB();
    const merchant = db.merchants?.find(m => m.email === email);
    if (merchant) {
        res.json({ isMerchant: true, name: merchant.name, email: merchant.email });
    } else {
        res.json({ isMerchant: false });
    }
});

app.get('/api/merchants', async (req, res) => {
    const db = await readDB();
    res.json({ merchants: db.merchants || [] });
});

app.post('/api/merchants', async (req, res) => {
    const { email, name, phoneNumber } = req.body;
    const db = await readDB();
    if (!db.merchants?.find(m => m.email === email)) {
        if (!db.merchants) db.merchants = [];
        db.merchants.push({ email, name, phoneNumber, addedAt: new Date().toISOString() });
        await writeDB(db);
        res.json({ success: true });
    } else {
        res.json({ success: false, message: 'Email sudah terdaftar' });
    }
});

app.delete('/api/merchants/:email', async (req, res) => {
    const { email } = req.params;
    const db = await readDB();
    db.merchants = db.merchants?.filter(m => m.email !== email) || [];
    await writeDB(db);
    res.json({ success: true });
});

// ============ API STATUS KEDAI ============
app.get('/api/store/status', async (req, res) => {
    const db = await readDB();
    const isOpen = db.storeOpen !== undefined ? db.storeOpen : true;
    res.json({ isOpen });
});

app.post('/api/store/status', async (req, res) => {
    const { isOpen } = req.body;
    const db = await readDB();
    db.storeOpen = isOpen;
    await writeDB(db);
    console.log(`🏪 Status kedai: ${isOpen ? 'BUKA' : 'TUTUP'}`);
    res.json({ success: true, isOpen });
});

app.get('/api/store/hours', async (req, res) => {
    const db = await readDB();
    const hours = db.storeHours || { openHour: 9, closeHour: 21 };
    res.json(hours);
});

app.post('/api/store/hours', async (req, res) => {
    const { openHour, closeHour } = req.body;
    const db = await readDB();
    db.storeHours = { openHour, closeHour };
    await writeDB(db);
    res.json({ success: true, hours: db.storeHours });
});

// ============ TEST ENDPOINT ============
app.get('/api/test', async (req, res) => {
    const db = await readDB();
    res.json({ 
        message: 'Backend berjalan!', 
        socketCount: connectedMerchants.size,
        environment: isProduction ? 'production' : 'development',
        dbType: (await connectMongoDB()) ? 'mongodb' : 'file_json'
    });
});

// ============ START SERVER ============
const PORT = process.env.PORT || 5000;

// Inisialisasi MongoDB saat startup
connectMongoDB().then(() => {
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Server running on port ${PORT}`);
        console.log(`📡 Socket.IO enabled`);
        console.log(`📱 WhatsApp API ready`);
        console.log(`🌍 Environment: ${isProduction ? 'PRODUCTION' : 'DEVELOPMENT'}`);
        console.log(`📁 Database: ${dbPath}`);
    });
});