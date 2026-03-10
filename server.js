const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Telegram Bot Config - GANTI INI
const TELEGRAM_BOT_TOKEN = '8771288742:AAHkrLhBDHwHhhgmSRHXZYA4Z5DqFSRMLiI';
const TELEGRAM_ADMIN_CHAT_ID = '8771288742:AAHkrLhBDHwHhhgmSRHXZYA4Z5DqFSRMLiI'; 
// Middleware
app.use(express.json());
app.use(express.static('public'));
app.use(cors({
    origin: true,
    credentials: true
}));

app.use(session({
    secret: process.env.SESSION_SECRET || 'milo-secret-key-2026',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: process.env.NODE_ENV === 'production',
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

// Database Setup
const db = new sqlite3.Database('./database.sqlite');

db.serialize(() => {
    // Users table
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        role TEXT DEFAULT 'user',
        telegram_chat_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // News table
    db.run(`CREATE TABLE IF NOT EXISTS news (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pts TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        file_url TEXT,
        created_by INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (created_by) REFERENCES users(id)
    )`);

    // Messages table
    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        sender TEXT NOT NULL,
        message TEXT NOT NULL,
        is_read INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
    )`);

    // Create default admin if not exists
    const adminPass = bcrypt.hashSync('admin', 10);
    db.run(`INSERT OR IGNORE INTO users (username, password, role) VALUES (?, ?, ?)`, 
        ['admin', adminPass, 'admin']);
    
    // Create default user if not exists
    const userPass = bcrypt.hashSync('user', 10);
    db.run(`INSERT OR IGNORE INTO users (username, password, role) VALUES (?, ?, ?)`, 
        ['user', userPass, 'user']);
});

// Multer Config
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = './public/uploads';
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});
const upload = multer({ storage });

// Auth Middleware
const requireAuth = (req, res, next) => {
    if (req.session.userId) next();
    else res.status(401).json({ error: 'Unauthorized' });
};

const requireAdmin = (req, res, next) => {
    if (req.session.role === 'admin') next();
    else res.status(403).json({ error: 'Forbidden' });
};

// Routes

// Auth
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    
    db.get('SELECT * FROM users WHERE username = ?', [username], (err, user) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!user) return res.json({ success: false, message: 'User not found' });
        
        if (bcrypt.compareSync(password, user.password)) {
            req.session.userId = user.id;
            req.session.username = user.username;
            req.session.role = user.role;
            res.json({ 
                success: true, 
                user: { id: user.id, username: user.username, role: user.role }
            });
        } else {
            res.json({ success: false, message: 'Wrong password' });
        }
    });
});

app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

app.get('/api/me', (req, res) => {
    if (req.session.userId) {
        res.json({ 
            user: { 
                id: req.session.userId, 
                username: req.session.username, 
                role: req.session.role 
            } 
        });
    } else {
        res.json({ user: null });
    }
});

// Users (Admin only)
app.post('/api/users', requireAdmin, (req, res) => {
    const { username, password, role } = req.body;
    const hashedPass = bcrypt.hashSync(password, 10);
    
    db.run('INSERT INTO users (username, password, role) VALUES (?, ?, ?)', 
        [username, hashedPass, role], function(err) {
            if (err) {
                if (err.message.includes('UNIQUE')) return res.json({ success: false, message: 'Username already exists' });
                return res.status(500).json({ error: err.message });
            }
            res.json({ success: true, id: this.lastID });
        });
});

app.get('/api/users', requireAdmin, (req, res) => {
    db.all('SELECT id, username, role, created_at FROM users', [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ users: rows });
    });
});

app.delete('/api/users/:id', requireAdmin, (req, res) => {
    db.run('DELETE FROM users WHERE id = ?', [req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// News
app.get('/api/news', (req, res) => {
    db.all('SELECT * FROM news ORDER BY created_at DESC', [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ news: rows });
    });
});

app.post('/api/news', requireAuth, upload.single('file'), (req, res) => {
    const { pts, title, description } = req.body;
    const fileUrl = req.file ? `/uploads/${req.file.filename}` : null;
    
    db.run('INSERT INTO news (pts, title, description, file_url, created_by) VALUES (?, ?, ?, ?, ?)',
        [pts, title, description, fileUrl, req.session.userId], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, id: this.lastID });
        });
});

// Messages + Telegram Integration
app.get('/api/messages/:userId', requireAuth, (req, res) => {
    const userId = req.params.userId;
    // Mark as read
    db.run('UPDATE messages SET is_read = 1 WHERE user_id = ? AND sender = ?', [userId, 'admin']);
    
    db.all('SELECT * FROM messages WHERE user_id = ? ORDER BY created_at ASC', [userId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ messages: rows });
    });
});

app.get('/api/messages/:userId/unread', requireAuth, (req, res) => {
    db.get('SELECT COUNT(*) as count FROM messages WHERE user_id = ? AND sender = ? AND is_read = 0', 
        [req.params.userId, 'admin'], (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ count: row.count });
        });
});

app.post('/api/messages', requireAuth, async (req, res) => {
    const { userId, message, sender } = req.body;
    
    // Save to DB
    db.run('INSERT INTO messages (user_id, sender, message) VALUES (?, ?, ?)',
        [userId, sender, message], async function(err) {
            if (err) return res.status(500).json({ error: err.message });
            
            // Send to Telegram if from user
            if (sender === 'user' && TELEGRAM_BOT_TOKEN !== 'YOUR_BOT_TOKEN') {
                try {
                    const userRes = await new Promise((resolve, reject) => {
                        db.get('SELECT username FROM users WHERE id = ?', [userId], (err, row) => {
                            if (err) reject(err);
                            else resolve(row);
                        });
                    });
                    
                    const text = `📩 *Pesan Baru*\n\n*Dari:* ${userRes.username}\n*ID:* ${userId}\n*Pesan:* ${message}\n\n_Reply pesan ini dengan format: ${userId} : balasan anda_`;
                    
                    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                        chat_id: TELEGRAM_ADMIN_CHAT_ID,
                        text: text,
                        parse_mode: 'Markdown'
                    });
                } catch (err) {
                    console.error('Telegram send failed:', err.message);
                }
            }
            
            res.json({ success: true, id: this.lastID });
        });
});

// Telegram Webhook Handler
app.post('/telegram-webhook', express.json(), async (req, res) => {
    const update = req.body;
    
    if (update.message && update.message.reply_to_message) {
        // This is a reply from admin
        const originalText = update.message.reply_to_message.text;
        const replyText = update.message.text;
        
        // Extract user ID from original message format "ID: {userId}"
        const idMatch = originalText.match(/ID:\s*(\d+)/);
        if (idMatch) {
            const userId = idMatch[1];
            
            // Check if format is "userId : message"
            const formatMatch = replyText.match(/^(\d+)\s*:\s*(.+)$/);
            if (formatMatch) {
                const targetUserId = formatMatch[1];
                const message = formatMatch[2];
                
                // Save admin reply
                db.run('INSERT INTO messages (user_id, sender, message) VALUES (?, ?, ?)',
                    [targetUserId, 'admin', message], (err) => {
                        if (err) console.error('Failed to save admin message:', err);
                    });
                
                // Confirm to admin
                await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                    chat_id: update.message.chat.id,
                    text: `✅ Balasan terkirim ke user ID ${targetUserId}`,
                    reply_to_message_id: update.message.message_id
                });
            }
        }
    }
    
    res.sendStatus(200);
});

// Setup webhook (run once when deploying)
app.get('/setup-telegram-webhook', async (req, res) => {
    if (TELEGRAM_BOT_TOKEN === 'YOUR_BOT_TOKEN') {
        return res.send('Please set TELEGRAM_BOT_TOKEN first');
    }
    
    const webhookUrl = `${req.protocol}://${req.get('host')}/telegram-webhook`;
    
    try {
        const response = await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`, {
            url: webhookUrl
        });
        res.json(response.data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Serve index.html for all routes (SPA support)
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
