const express = require('express');
const sql = require('mssql');
const cors = require('cors');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Serve static files

// Azure SQL Database configuration
const dbConfig = {
    server: process.env.DB_SERVER, // e.g., 'myserver.privatelink.database.windows.net'
    database: process.env.DB_NAME,
    authentication: {
        type: 'default',
        options: {
            userName: process.env.DB_USER,
            password: process.env.DB_PASSWORD
        }
    },
    options: {
        encrypt: true, // Always true for Azure
        enableArithAbort: true,
        trustServerCertificate: false, // Set to true only for development
        connectTimeout: 30000,
        requestTimeout: 30000,
        pool: {
            max: 10,
            min: 0,
            idleTimeoutMillis: 30000
        }
    }
};

// Alternative configuration using connection string
const connectionString = process.env.CONNECTION_STRING;
// Format: "Server=myserver.privatelink.database.windows.net;Database=mydb;User Id=myuser;Password=mypass;Encrypt=true;"

// Database connection pool
let poolPromise;

// Initialize database connection
async function initializeDatabase() {
    try {
        if (connectionString) {
            poolPromise = sql.connect(connectionString);
        } else {
            poolPromise = sql.connect(dbConfig);
        }
        
        await poolPromise;
        console.log('✅ Connected to Azure SQL Database via Private Endpoint');
        
        // Test query
        const result = await sql.query`SELECT @@VERSION as version, @@SERVERNAME as server`;
        console.log('Database Info:', result.recordset[0]);
        
    } catch (error) {
        console.error('❌ Database connection failed:', error.message);
        throw error;
    }
}

// API Routes

// Health check endpoint
app.get('/api/health', async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request().query('SELECT 1 as healthy');
        res.json({ 
            status: 'healthy', 
            database: 'connected',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ 
            status: 'unhealthy', 
            error: error.message 
        });
    }
});

// Get all users example
app.get('/api/users', async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request().query(`
            SELECT TOP 100 
                UserId, 
                UserName, 
                Email, 
                CreatedDate 
            FROM Users 
            ORDER BY CreatedDate DESC
        `);
        
        res.json({
            success: true,
            data: result.recordset,
            count: result.recordset.length
        });
    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to fetch users',
            details: error.message
        });
    }
});

// Get user by ID
app.get('/api/users/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const pool = await poolPromise;
        
        const result = await pool.request()
            .input('userId', sql.Int, parseInt(id))
            .query('SELECT * FROM Users WHERE UserId = @userId');
        
        if (result.recordset.length === 0) {
            return res.status(404).json({ 
                success: false, 
                error: 'User not found' 
            });
        }
        
        res.json({
            success: true,
            data: result.recordset[0]
        });
    } catch (error) {
        console.error('Error fetching user:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to fetch user',
            details: error.message
        });
    }
});

// Create new user
app.post('/api/users', async (req, res) => {
    try {
        const { userName, email } = req.body;
        
        if (!userName || !email) {
            return res.status(400).json({
                success: false,
                error: 'userName and email are required'
            });
        }
        
        const pool = await poolPromise;
        const result = await pool.request()
            .input('userName', sql.NVarChar(100), userName)
            .input('email', sql.NVarChar(255), email)
            .query(`
                INSERT INTO Users (UserName, Email, CreatedDate) 
                OUTPUT INSERTED.*
                VALUES (@userName, @email, GETDATE())
            `);
        
        res.status(201).json({
            success: true,
            data: result.recordset[0],
            message: 'User created successfully'
        });
    } catch (error) {
        console.error('Error creating user:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to create user',
            details: error.message
        });
    }
});

// Update user
app.put('/api/users/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { userName, email } = req.body;
        
        const pool = await poolPromise;
        const result = await pool.request()
            .input('userId', sql.Int, parseInt(id))
            .input('userName', sql.NVarChar(100), userName)
            .input('email', sql.NVarChar(255), email)
            .query(`
                UPDATE Users 
                SET UserName = @userName, Email = @email, UpdatedDate = GETDATE()
                OUTPUT INSERTED.*
                WHERE UserId = @userId
            `);
        
        if (result.recordset.length === 0) {
            return res.status(404).json({ 
                success: false, 
                error: 'User not found' 
            });
        }
        
        res.json({
            success: true,
            data: result.recordset[0],
            message: 'User updated successfully'
        });
    } catch (error) {
        console.error('Error updating user:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to update user',
            details: error.message
        });
    }
});

// Delete user
app.delete('/api/users/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const pool = await poolPromise;
        
        const result = await pool.request()
            .input('userId', sql.Int, parseInt(id))
            .query('DELETE FROM Users WHERE UserId = @userId');
        
        if (result.rowsAffected[0] === 0) {
            return res.status(404).json({ 
                success: false, 
                error: 'User not found' 
            });
        }
        
        res.json({
            success: true,
            message: 'User deleted successfully'
        });
    } catch (error) {
        console.error('Error deleting user:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to delete user',
            details: error.message
        });
    }
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\nShutting down server...');
    try {
        await sql.close();
        console.log('Database connections closed');
    } catch (error) {
        console.error('Error closing database:', error);
    }
    process.exit(0);
});

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('Unhandled error:', error);
    res.status(500).json({
        success: false,
        error: 'Internal server error',
        details: error.message
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'Endpoint not found'
    });
});

// Start server
async function startServer() {
    try {
        await initializeDatabase();
        app.listen(port, () => {
            console.log(`🚀 Server running on port ${port}`);
            console.log(`📊 Health check: http://localhost:${port}/api/health`);
            console.log(`👥 Users API: http://localhost:${port}/api/users`);
        });
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
}

startServer();