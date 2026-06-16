const { Pool } = require('pg');

const pool = new Pool({
    user: 'exfil_user',
    password: 'exfil123',
    host: 'localhost',
    port: 5433,
    database: 'exfiltration_db',
});

async function test() {
    try {
        const result = await pool.query('SELECT NOW() as time, current_user as user, current_database() as database');
        console.log('✅ Connected successfully!');
        console.log('   Time:', result.rows[0].time);
        console.log('   User:', result.rows[0].user);
        console.log('   Database:', result.rows[0].database);
        process.exit(0);
    } catch (error) {
        console.error('❌ Connection failed:', error.message);
        process.exit(1);
    }
}

test();